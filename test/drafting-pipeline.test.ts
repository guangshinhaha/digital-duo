import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { getDraft, listDrafts } from "../src/drafting/draft-log.js";
import { draftReply } from "../src/drafting/pipeline.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;

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

/** Always returns the same completion — a deterministic stand-in for a well-agreeing model, so self-consistency scores 1. */
function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

async function seedConfirmedRule(storePath: string): Promise<void> {
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "shared" });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  const embeddingProvider = createFakeEmbeddingProvider();
  await embedRecords(storePath, PASSPHRASE, embeddingProvider);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-leave",
        topicId: "topic-leave",
        text: "Standard leave is five days per quarter.",
        status: "confirmed",
        supportCount: 3,
        consistency: 0.95,
        createdAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      },
      pairs.map((pair) => pair.id),
    );
  });
}

describe("draftReply — a question produces a draft with sources (#32 AC1)", () => {
  it("returns a draft with the standing order and past exchange listed as sources, and confidence high enough to pass", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();
    const inferenceProvider = agreeingProvider("Five days per quarter, per policy.");

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toBe("Five days per quarter, per policy.");
    expect(result.sources.some((source) => source.kind === "rule")).toBe(true);
    expect(result.sources.some((source) => source.kind === "evidence")).toBe(true);
    expect(result.confidence.passesThreshold).toBe(true);

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.draftText).toBe(result.text);
    expect(stored?.escalated).toBe(false);
  });

  it("works with no provider configured, using the extractive fallback", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toBe("Standard leave is five days per quarter.");
  });
});

describe("draftReply — an unanswerable question escalates instead of guessing (#32 AC2)", () => {
  it("escalates, with an explanation, when there is no supporting evidence at all", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is the meaning of life",
      null,
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    if (result.kind !== "escalation") throw new Error("expected an escalation");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).not.toMatch(/five days/i);

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.draftText).toBeNull();
    expect(stored?.escalated).toBe(true);
  });

  it("escalates on thin evidence even when a provider is configured, rather than drafting a confident-sounding guess", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();
    // A weak, unrelated single match: writes one record whose embedding
    // shares no synonym group with the question, so retrieval strength
    // and self-consistency alone can't clear the escalation threshold.
    const unrelated = record({ text: "the printer on the third floor is broken, hardware issue" });
    writeRecords(storePath, PASSPHRASE, [unrelated]);
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is my end of year bonus",
      null,
      embeddingProvider,
      agreeingProvider("I don't know."),
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
  });

  it("never calls the inference provider at all when there is zero grounding, even with one configured", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();
    let calls = 0;
    const countingProvider = { name: "fake", async complete() { calls += 1; return "should never run"; } };

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is the meaning of life",
      null,
      embeddingProvider,
      countingProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    expect(calls).toBe(0);
  });
});

describe("draftReply — every call writes exactly one draft-log row", () => {
  it("logs both the draft and escalation cases", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();

    await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, embeddingProvider, undefined, CONFIDENCE_CONFIG);
    await draftReply(storePath, PASSPHRASE, duoDir(), "what is the meaning of life", null, embeddingProvider, undefined, CONFIDENCE_CONFIG);

    expect(listDrafts(storePath, PASSPHRASE)).toHaveLength(2);
  });
});

describe("draftReply — a thread of context can be supplied (#32 AC4)", () => {
  it("accounts for piped-in thread context rather than answering the last line alone", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();
    const seenPrompts: string[] = [];
    const capturingProvider: InferenceProvider = {
      name: "fake",
      async complete(prompt: string) {
        seenPrompts.push(prompt);
        return "Five days.";
      },
    };

    await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "is the vacation policy the same for everyone?",
      "Alice: how much vacation leave do I get\nMe: it depends on tenure",
      embeddingProvider,
      capturingProvider,
      CONFIDENCE_CONFIG,
    );

    // The self-consistency samples are the draft prompt itself; a later
    // self-report call asks a different question and wouldn't carry the
    // thread context, so this checks every prompt the provider actually saw.
    expect(seenPrompts.some((prompt) => prompt.includes("it depends on tenure"))).toBe(true);
  });
});
