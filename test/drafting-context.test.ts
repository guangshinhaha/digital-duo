import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { gatherDraftContext } from "../src/drafting/context.js";
import { excludeEvidence, restoreEvidence } from "../src/drafting/evidence-exclusions.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
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

describe("gatherDraftContext — evidence and voice with no rule yet", () => {
  it("returns real per-item similarity, and a placeholder voice when duo/voice.md doesn't exist", async () => {
    const storePath = initStore();
    const answer = record({ text: "five days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);

    expect(context.evidence.length).toBeGreaterThan(0);
    expect(context.evidence[0].similarity).toBeGreaterThan(0);
    expect(context.ruleHit).toBeUndefined();
    expect(context.voiceText).toContain("Not enough");
    expect(context.usedEmbeddings).toBe(true);
  });

  it("reads duo/voice.md verbatim when it exists", async () => {
    const storePath = initStore();
    const dir = duoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "voice.md"), "# Voice profile\n\nterse and direct\n", "utf8");

    const context = await gatherDraftContext(storePath, PASSPHRASE, dir, "anything", createFakeEmbeddingProvider());
    expect(context.voiceText).toContain("terse and direct");
  });
});

describe("gatherDraftContext — evidence the owner excluded (duo#272)", () => {
  it("leaves out a record the owner excluded from a draft's Why panel, and brings it back once restored", async () => {
    const storePath = initStore();
    const answer = record({ text: "five days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const before = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(before.evidence.some((item) => item.recordId === answer.id)).toBe(true);

    excludeEvidence(storePath, PASSPHRASE, answer.id);
    const excluded = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(excluded.evidence.some((item) => item.recordId === answer.id)).toBe(false);

    restoreEvidence(storePath, PASSPHRASE, answer.id);
    const restored = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(restored.evidence.some((item) => item.recordId === answer.id)).toBe(true);
  });

  it("an excluded record also drops out of rule-hit and topic resolution when it was the only evidence backing them", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "t-shared" });
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
          reviewStatus: "approved",
          origin: "derived",
          supersededByRuleId: null,
          correctionDraftId: null,
          correctionQuestion: null,
        },
        pairs.map((pair) => pair.id),
      );
    });

    excludeEvidence(storePath, PASSPHRASE, answer.id);
    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(context.evidence.some((item) => item.recordId === answer.id)).toBe(false);
    expect(context.ruleHit).toBeUndefined();
    expect(context.topicId).toBeUndefined();
  });
});

describe("gatherDraftContext — the explicit rule-hit signal", () => {
  it("finds the confirmed rule backing the retrieved evidence", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "t-shared" });
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
          reviewStatus: "approved",
          origin: "derived",
          supersededByRuleId: null,
          correctionDraftId: null,
          correctionQuestion: null,
        },
        pairs.map((pair) => pair.id),
      );
    });

    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(context.ruleHit?.id).toBe("topic-leave");
    expect(context.ruleHit?.status).toBe("confirmed");
  });

  it("does not treat a confirmed-but-not-yet-owner-approved rule as a hit (#28's review gate)", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "t-shared" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const { pairs } = await extractQaPairs([question, answer]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave-pending" })));
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      putRule(
        db,
        {
          id: "topic-leave-pending",
          topicId: "topic-leave-pending",
          text: "Standard leave is five days per quarter.",
          status: "confirmed",
          supportCount: 3,
          consistency: 0.95,
          createdAt: new Date().toISOString(),
          lastConfirmedAt: new Date().toISOString(),
          reviewStatus: "pending", // the owner hasn't signed off on this yet
          origin: "derived",
          supersededByRuleId: null,
          correctionDraftId: null,
          correctionQuestion: null,
        },
        pairs.map((pair) => pair.id),
      );
    });

    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(context.ruleHit).toBeUndefined();
  });

  it("does not treat an approved rule as a hit once its topic has a conflicting refusal (#29 AC3, checked live)", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "t-shared" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const { pairs } = await extractQaPairs([question, answer]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave-refused" })));
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      putRule(
        db,
        {
          id: "topic-leave-refused",
          topicId: "topic-leave-refused",
          text: "Standard leave is five days per quarter.",
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "refusals.md"), "## topic-leave-refused\n\nNever speak for me on leave policy.\n", "utf8");

    const context = await gatherDraftContext(storePath, PASSPHRASE, dir, "how much vacation leave do I get", embeddingProvider);
    expect(context.ruleHit).toBeUndefined();
  });
});

describe("gatherDraftContext — topic resolution for evidence (#43)", () => {
  it("takes the topic from a rule hit when one exists", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "t-shared" });
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
          reviewStatus: "approved",
          origin: "derived",
          supersededByRuleId: null,
          correctionDraftId: null,
          correctionQuestion: null,
        },
        pairs.map((pair) => pair.id),
      );
    });

    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(context.topicId).toBe("topic-leave");
  });

  it("falls back to the evidence's own qa_pairs topic when there is no rule at all", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "t-shared" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const { pairs } = await extractQaPairs([question, answer]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave-no-rule" })));

    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(context.ruleHit).toBeUndefined();
    expect(context.topicId).toBe("topic-leave-no-rule");
  });

  it("is undefined when there is no evidence at all", async () => {
    const storePath = initStore();
    const context = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "nothing matches this", createFakeEmbeddingProvider());
    expect(context.topicId).toBeUndefined();
  });
});

describe("gatherDraftContext — an optional clearance ceiling filters candidates before anything else sees them (#43)", () => {
  it("excludes a record above the ceiling from evidence, rule-hit lookup, and topic resolution alike", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "a question about leave", threadId: "t-shared" });
    const answer = record({ text: "RESTRICTED\nfive days per quarter, per the vacation policy", threadId: "t-shared" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const { pairs } = await extractQaPairs([question, answer]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));

    const unfiltered = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", embeddingProvider);
    expect(unfiltered.evidence.length).toBeGreaterThan(0);
    expect(unfiltered.topicId).toBe("topic-leave");

    const filtered = await gatherDraftContext(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      embeddingProvider,
      undefined,
      "official_open",
    );
    expect(filtered.evidence).toEqual([]);
    expect(filtered.topicId).toBeUndefined();
    expect(filtered.freshestEvidenceAgeDays).toBeNull();
  });

  it("admits a record at or below the ceiling unchanged", async () => {
    const storePath = initStore();
    const answer = record({ text: "OFFICIAL (OPEN)\nfive days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const filtered = await gatherDraftContext(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      embeddingProvider,
      undefined,
      "official_open",
    );
    expect(filtered.evidence.length).toBeGreaterThan(0);
  });
});

describe("gatherDraftContext — freshest evidence age", () => {
  it("is null with no evidence, and a real number in days with some", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();

    const empty = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "no such topic", embeddingProvider);
    expect(empty.freshestEvidenceAgeDays).toBeNull();

    const answer = record({ text: "the printer on the third floor is broken, hardware issue", timestamp: "2020-01-01T00:00:00.000Z" });
    writeRecords(storePath, PASSPHRASE, [answer]);
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const withEvidence = await gatherDraftContext(storePath, PASSPHRASE, duoDir(), "printer hardware broken", embeddingProvider);
    expect(withEvidence.freshestEvidenceAgeDays).toBeGreaterThan(365);
  });
});
