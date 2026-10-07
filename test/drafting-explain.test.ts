import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { explainMessage, ExplainUnavailableError } from "../src/drafting/explain.js";
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

/**
 * Same fixture shape as drafting-fact-check.test.ts's seedLeaveRule, kept
 * on the same "leave" topic deliberately: the fake embedding provider
 * (`fake-embedding-provider.ts`) only recognizes a handful of synonym
 * groups, and "pto"/"vacation"/"leave" share one of them — that's what
 * lets retrieval find this rule at all for the message below.
 */
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

const MESSAGE = "heads up, my PTO for Friday is still pending";

describe("duo#283 — explainMessage", () => {
  it("throws ExplainUnavailableError with no inference provider configured, even with a standing order in the corpus", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    await expect(explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), undefined)).rejects.toBeInstanceOf(
      ExplainUnavailableError,
    );
  });

  it("explains using the corpus's standing order, citing exactly the source it drew on", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(
      JSON.stringify({ explanation: "PTO is paid time off; yours is still waiting on approval.", usedIndices: [0] }),
    );
    const result = await explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), provider);
    expect(result.explanation).toContain("paid time off");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.kind).toBe("rule");
  });

  it("returns no sources when the model cites none, even with corpus candidates available", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(JSON.stringify({ explanation: "PTO commonly means paid time off.", usedIndices: [] }));
    const result = await explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), provider);
    expect(result.sources).toEqual([]);
  });

  it("never fabricates a source: drops an index that doesn't name a real candidate", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(JSON.stringify({ explanation: "PTO means paid time off.", usedIndices: [7] }));
    const result = await explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), provider);
    expect(result.sources).toEqual([]);
  });

  it("de-duplicates repeated indices into one source", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns(JSON.stringify({ explanation: "PTO means paid time off.", usedIndices: [0, 0] }));
    const result = await explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), provider);
    expect(result.sources).toHaveLength(1);
  });

  it("throws ExplainUnavailableError on an unparseable model response, never a silent guess", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    const provider = providerThatReturns("I think it means something but I'm not sure how to say it as JSON.");
    await expect(explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), provider)).rejects.toBeInstanceOf(
      ExplainUnavailableError,
    );
  });

  it("throws ExplainUnavailableError when the provider itself fails", async () => {
    const storePath = initStore();
    await seedLeaveRule(storePath);
    await expect(
      explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), providerThatThrows()),
    ).rejects.toBeInstanceOf(ExplainUnavailableError);
  });

  it("returns a plain nothing-to-explain result for blank text, without ever calling the provider", async () => {
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
    const result = await explainMessage(storePath, PASSPHRASE, duoDir(), "   ", null, createFakeEmbeddingProvider(), provider);
    expect(result).toEqual({ explanation: "There's nothing in this message to explain.", sources: [] });
    expect(called).toBe(false);
  });

  it("explains a message with no corpus match at all, using the model's own general knowledge", async () => {
    const storePath = initStore();
    const provider = providerThatReturns(JSON.stringify({ explanation: "PTO commonly means paid time off.", usedIndices: [] }));
    const result = await explainMessage(storePath, PASSPHRASE, duoDir(), MESSAGE, null, createFakeEmbeddingProvider(), provider);
    expect(result.explanation).toContain("paid time off");
    expect(result.sources).toEqual([]);
  });
});
