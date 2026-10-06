import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { checkOwnerText } from "../src/drafting/fact-check.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** A confirmed, approved standing order about vacation leave — the same fixture shape as drafting-pipeline.test.ts's seedConfirmedRule. */
async function seedLeaveRule(storePath: string, ruleText = "Standard leave is five days per quarter."): Promise<void> {
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "shared" });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  await embedRecords(storePath, PASSPHRASE, createFakeEmbeddingProvider());
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-leave",
        topicId: "topic-leave",
        text: ruleText,
        status: "confirmed",
        supportCount: 3,
        consistency: 0.95,
        createdAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
        reviewStatus: "approved",
        origin: "derived",
        supersededByRuleId: null,
        correctionDraftId: null,
        correctionQuestion: null,
      },
      pairs.map((pair) => pair.id),
    );
  });
}

function providerThatReturns(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

function providerThatThrows(): InferenceProvider {
  return {
    name: "fake",
    async complete() {
      throw new Error("provider unreachable (fake)");
    },
  };
}

/** Returns each response in order, one per call, and counts how many calls it got — for pinning the two-independent-calls agreement requirement. */
function providerWithResponses(responses: readonly string[]): InferenceProvider & { callCount(): number } {
  let count = 0;
  return {
    name: "fake",
    async complete() {
      const response = responses[count] ?? responses.at(-1)!;
      count += 1;
      return response;
    },
    callCount: () => count,
  };
}

const CONFIDENT_CONTRADICTION = JSON.stringify({
  contradiction: true,
  factIndex: 0,
  claim: "ten days a quarter",
  concern: "You said ten days a quarter; the standing order says five.",
  confidence: 97,
});

const CONTRADICTS_LEAVE_TEXT = "quick note — vacation leave is now ten days a quarter";

describe("#264 — checkOwnerText", () => {
  it("never flags with no inference provider configured, even with a directly contradicting standing order in the corpus", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), undefined);
    expect(result).toEqual({ flag: null });
  });

  it("returns nothing when the corpus has no candidate facts at all, even with a provider configured", async () => {
    const storePath = initStore();
    const provider = providerThatReturns(
      JSON.stringify({ contradiction: true, factIndex: 0, claim: "ten days", concern: "mismatch", confidence: 99 }),
    );
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
  });

  it("flags a real, high-confidence contradiction, citing the standing order as its source and the claim verbatim from the owner's text", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(
      JSON.stringify({
        contradiction: true,
        factIndex: 0,
        claim: "ten days a quarter",
        concern: "You said ten days a quarter; the standing order says five.",
        confidence: 97,
      }),
    );
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result.flag).not.toBeNull();
    expect(result.flag?.claim).toBe("ten days a quarter");
    expect(result.flag?.source.kind).toBe("rule");
    expect(result.flag?.concern.length).toBeGreaterThan(0);
  });

  it("asks twice, independently, and only flags when both calls agree on the same fact", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerWithResponses([CONFIDENT_CONTRADICTION, CONFIDENT_CONTRADICTION]);
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result.flag).not.toBeNull();
    expect(provider.callCount()).toBe(2);
  });

  it("never flags when the second independent call disagrees with the first — even though the first alone was confident", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const noContradiction = JSON.stringify({ contradiction: false, factIndex: -1, claim: "", concern: "", confidence: 0 });
    const provider = providerWithResponses([CONFIDENT_CONTRADICTION, noContradiction]);
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
    expect(provider.callCount()).toBe(2);
  });

  it("only calls the provider once when the first call already finds nothing — the second opinion is only worth asking for after a confident first hit", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const noContradiction = JSON.stringify({ contradiction: false, factIndex: -1, claim: "", concern: "", confidence: 0 });
    const provider = providerWithResponses([noContradiction, CONFIDENT_CONTRADICTION]);
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
    expect(provider.callCount()).toBe(1);
  });

  it("never flags below the confidence threshold, even when the model says it's a contradiction", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(
      JSON.stringify({ contradiction: true, factIndex: 0, claim: "ten days a quarter", concern: "mismatch", confidence: 60 }),
    );
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
  });

  it("never flags when contradiction is false, whatever the stated confidence", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(
      JSON.stringify({ contradiction: false, factIndex: -1, claim: "", concern: "", confidence: 0 }),
    );
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
  });

  it("never fabricates a source: discards the whole verdict when the model's claim doesn't actually appear in the owner's text", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(
      JSON.stringify({
        contradiction: true,
        factIndex: 0,
        claim: "something the owner never actually typed",
        concern: "mismatch",
        confidence: 99,
      }),
    );
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
  });

  it("never fabricates a source: discards the verdict when factIndex doesn't name a real candidate", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(
      JSON.stringify({ contradiction: true, factIndex: 7, claim: "ten days a quarter", concern: "mismatch", confidence: 99 }),
    );
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
  });

  it("degrades to no flag, never a thrown error, on an unparseable model response", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns("I think there might be an issue here but I'm not sure how to phrase it as JSON.");
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
  });

  it("degrades to no flag, never a thrown error, when the provider itself fails", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), CONTRADICTS_LEAVE_TEXT, null, createFakeEmbeddingProvider(), providerThatThrows());
    expect(result).toEqual({ flag: null });
  });

  it("returns nothing for blank text without ever calling the provider", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    let called = false;
    const provider: InferenceProvider = {
      name: "fake",
      async complete() {
        called = true;
        return "{}";
      },
    };
    const result = await checkOwnerText(storePath, PASSPHRASE, duoDir(), "   ", null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ flag: null });
    expect(called).toBe(false);
  });
});
