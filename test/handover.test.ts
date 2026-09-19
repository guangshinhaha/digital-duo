import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  HandoverDraftMalformedError,
  HandoverItemNotFoundError,
  NoHandoverDraftError,
  cutHandoverItem,
  generateHandoverPack,
  handoverDraftPath,
  regenerateHandoverDraft,
  renderHandoverDocument,
  shareHandoverPack,
} from "../src/continuity/handover.js";
import { extractQaPairs, listQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule, type Rule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { appendDraft } from "../src/drafting/draft-log.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { writeRefusalsFile } from "../src/trust/refusals.js";

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

// A plain zero-padded seconds string overflows past counter 59 (invalid
// ISO seconds) once enough records accumulate across this file's several
// multi-pair fixtures — timestamps are computed from a base instant plus
// whole seconds instead, so the counter can grow arbitrarily large without
// ever producing an invalid or colliding timestamp.
const BASE_TIMESTAMP_MS = new Date("2026-01-01T00:00:00.000Z").getTime();
let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: `ref-${counter}`,
    kind: "my_thinking",
    author: "other",
    timestamp: new Date(BASE_TIMESTAMP_MS + counter * 1000).toISOString(),
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** Seeds `count` question/answer pairs, one topic, enough to clear the portrait's characterisation threshold (10). */
async function seedPairs(storePath: string, topicId: string, count: number): Promise<void> {
  const records = [];
  for (let i = 0; i < count; i++) {
    const question = record({ kind: "question_to_me", author: "other", text: `question ${i}` });
    const answer = record({ kind: "my_answer", author: "me", text: `answer ${i}`, threadId: question.threadId });
    records.push(question, answer);
  }
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
}

/** `evidencePairIds` defaults to every qa_pair currently on `topicId` — the same "the rule's evidence is whatever qa_pairs it cites" shape `rules.ts`'s own induction uses. */
function seedActiveRule(storePath: string, topicId: string, text: string): void {
  const evidencePairIds = listQaPairs(storePath, PASSPHRASE)
    .filter((pair) => pair.topicId === topicId)
    .map((pair) => pair.id);
  const rule: Rule = {
    id: topicId,
    topicId,
    text,
    status: "confirmed",
    supportCount: 3,
    consistency: 0.9,
    createdAt: new Date().toISOString(),
    lastConfirmedAt: new Date().toISOString(),
    reviewStatus: "approved",
    origin: "derived",
    supersededByRuleId: null,
    correctionDraftId: null,
    correctionQuestion: null,
  };
  withDatabase(storePath, PASSPHRASE, true, (db) => putRule(db, rule, evidencePairIds));
}

/** Assembles a full, non-thin corpus: 10 pairs on one topic, an active rule, a recorded refusal, and one unresolved escalation — everything #62 AC1 asks a pack to carry. */
async function seedFullCorpus(storePath: string, dir: string): Promise<void> {
  writeTopicsFile(dir, [{ id: "topic-leave", label: "Leave policy", createdAt: "2025-01-01T00:00:00.000Z" }]);
  await seedPairs(storePath, "topic-leave", 12);
  seedActiveRule(storePath, "topic-leave", "Leave is five days per quarter.");
  writeRefusalsFile(dir, [{ heading: "Salary negotiations", reason: "Never speaks for me on pay." }]);
  appendDraft(storePath, PASSPHRASE, {
    question: "what is the succession plan for this desk",
    threadContext: null,
    draftText: null,
    escalated: true,
    escalationReason: "no evidence at all",
    confidenceScore: 0,
    sources: [],
  });
}

describe("generateHandoverPack — #62 AC1: assembled from evidence, traceable to its source", () => {
  it("carries recurring questions, standing orders with evidence, refusals, thread activity, and open threads", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedFullCorpus(storePath, dir);

    const pack = generateHandoverPack(storePath, PASSPHRASE, dir);

    expect(pack.recurringQuestions).toHaveLength(1);
    expect(pack.recurringQuestions[0]).toMatchObject({ id: "topic:topic-leave", label: "Leave policy", count: 12 });

    expect(pack.standingOrders).toHaveLength(1);
    expect(pack.standingOrders[0].text).toBe("Leave is five days per quarter.");
    expect(pack.standingOrders[0].evidence.length).toBeGreaterThan(0);
    expect(pack.standingOrders[0].evidence[0].questionText).toMatch(/question/);

    expect(pack.refusals).toEqual([{ id: "refusal-0", excluded: false, heading: "Salary negotiations", reason: "Never speaks for me on pay." }]);

    expect(pack.askerActivity.length).toBeGreaterThan(0);

    expect(pack.openThreads).toHaveLength(1);
    expect(pack.openThreads[0].question).toBe("what is the succession plan for this desk");
    expect(pack.openThreads[0].escalationReason).toBe("no evidence at all");

    expect(pack.gaps).toEqual([]);
  });
});

describe("generateHandoverPack — #62 AC3: a thin corpus produces an honest pack, not a padded one", () => {
  it("states what it could not cover on a brand-new store, rather than showing empty sections silently", () => {
    const storePath = initStore();
    const pack = generateHandoverPack(storePath, PASSPHRASE, duoDir());

    expect(pack.recurringQuestions).toEqual([]);
    expect(pack.standingOrders).toEqual([]);
    expect(pack.gaps.length).toBeGreaterThan(0);
    expect(pack.gaps.some((gap) => gap.includes("Too little history"))).toBe(true);
    expect(pack.gaps.some((gap) => gap.includes("standing orders"))).toBe(true);
    expect(pack.gaps.some((gap) => gap.includes("refusals"))).toBe(true);
  });

  it("does not treat a deliberately recorded empty refusals list as a gap", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeRefusalsFile(dir, []); // confirm-none: a real decision, recorded as zero refusals
    const pack = generateHandoverPack(storePath, PASSPHRASE, dir);
    expect(pack.refusals).toEqual([]);
    expect(pack.gaps.some((gap) => gap.toLowerCase().includes("refusal"))).toBe(false);
  });
});

describe("the handover draft lives outside the git-tracked duoDir", () => {
  it("writes the draft under the store's own data directory, never under duoDir", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedFullCorpus(storePath, dir);

    regenerateHandoverDraft(storePath, PASSPHRASE, dir);
    const draftPath = handoverDraftPath(storePath);
    expect(existsSync(draftPath)).toBe(true);
    expect(draftPath.startsWith(dir)).toBe(false);
    expect(draftPath).toContain(join(tempDir(), "data"));
  });
});

describe("cutHandoverItem / shareHandoverPack — #62 AC2: the owner cuts anything before an explicit share", () => {
  it("excludes a cut item from the shared document, and reports it as excluded rather than silently absent", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedFullCorpus(storePath, dir);
    regenerateHandoverDraft(storePath, PASSPHRASE, dir);

    const updated = cutHandoverItem(storePath, "topic:topic-leave");
    expect(updated.recurringQuestions.find((item) => item.id === "topic:topic-leave")?.excluded).toBe(true);
    // Cutting one item never touches another section, even one whose id
    // shares the same underlying topic id (a rule's id is its topic id).
    expect(updated.standingOrders[0].excluded).toBe(false);

    const outputPath = join(tempDir(), "shared", "handover.md");
    const summary = shareHandoverPack(storePath, outputPath);
    expect(summary.includedCounts.recurringQuestions).toBe(0);
    expect(summary.includedCounts.standingOrders).toBe(1);
    expect(summary.excludedCount).toBe(1);

    const document = readFileSync(outputPath, "utf8");
    expect(document).not.toContain("Leave policy");
    expect(document).toContain("Leave is five days per quarter.");
  });

  it("throws a clear error for an unknown item id, and for sharing with no draft generated yet", async () => {
    const storePath = initStore();
    expect(() => cutHandoverItem(storePath, "nonexistent")).toThrow(NoHandoverDraftError);
    expect(() => shareHandoverPack(storePath, join(tempDir(), "out.md"))).toThrow(NoHandoverDraftError);

    const dir = duoDir();
    await seedFullCorpus(storePath, dir);
    regenerateHandoverDraft(storePath, PASSPHRASE, dir);
    expect(() => cutHandoverItem(storePath, "nonexistent")).toThrow(HandoverItemNotFoundError);
  });

  it("carries forward an earlier cut across a regenerate, rather than silently un-cutting it", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedFullCorpus(storePath, dir);
    regenerateHandoverDraft(storePath, PASSPHRASE, dir);
    cutHandoverItem(storePath, "topic:topic-leave");

    // New evidence lands; the owner re-generates to pick it up.
    await seedPairs(storePath, "topic-leave", 3);
    const regenerated = regenerateHandoverDraft(storePath, PASSPHRASE, dir);

    const carried = regenerated.recurringQuestions.find((item) => item.id === "topic:topic-leave");
    expect(carried?.excluded).toBe(true);
    expect(carried?.count).toBe(15); // fresh count, cut decision preserved
  });
});

describe("readHandoverDraft — a malformed hand-edit fails loudly rather than silently mis-cutting", () => {
  it("throws a clear error on invalid JSON instead of a raw SyntaxError", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedFullCorpus(storePath, dir);
    regenerateHandoverDraft(storePath, PASSPHRASE, dir);

    writeFileSync(handoverDraftPath(storePath), "{ not valid json", "utf8");
    expect(() => cutHandoverItem(storePath, "topic:topic-leave")).toThrow(HandoverDraftMalformedError);
  });

  it("rejects a hand-edited `excluded` value that isn't strictly a boolean, rather than silently misreading a string as truthy", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedFullCorpus(storePath, dir);
    const pack = regenerateHandoverDraft(storePath, PASSPHRASE, dir);

    const corrupted = {
      ...pack,
      recurringQuestions: pack.recurringQuestions.map((item) => ({ ...item, excluded: "false" })),
    };
    writeFileSync(handoverDraftPath(storePath), JSON.stringify(corrupted), "utf8");

    expect(() => shareHandoverPack(storePath, join(tempDir(), "out.md"))).toThrow(HandoverDraftMalformedError);
  });
});

describe("renderHandoverDocument", () => {
  it("names every section, even an empty one, rather than omitting it", () => {
    const pack = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      recurringQuestions: [],
      standingOrders: [],
      refusals: [],
      askerActivity: [],
      openThreads: [],
      gaps: ["nothing derived yet"],
    };
    const document = renderHandoverDocument(pack);
    expect(document).toContain("## Recurring questions");
    expect(document).toContain("## Standing orders");
    expect(document).toContain("## Refusals");
    expect(document).toContain("## Who asks about what");
    expect(document).toContain("## Open threads");
    expect(document).toContain("## What this pack could not cover");
    expect(document).toContain("nothing derived yet");
  });
});
