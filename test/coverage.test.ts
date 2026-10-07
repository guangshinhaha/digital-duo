import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { buildTopicCoverage } from "../src/derivation/coverage.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule, type Rule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
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
    sourceRef: `ref-${counter}`,
    kind: "my_thinking",
    author: "other",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** Seeds `count` question/answer pairs, one per thread, all assigned to `topicId`. */
async function seedPairs(storePath: string, topicId: string, count: number): Promise<void> {
  const records = [];
  for (let i = 0; i < count; i++) {
    const question = record({ kind: "question_to_me", author: "other", text: `question ${topicId}-${i}` });
    const answer = record({ kind: "my_answer", author: "me", text: `answer ${topicId}-${i}`, threadId: question.threadId });
    records.push(question, answer);
  }
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
}

function putApprovedRule(storePath: string, topicId: string, text: string): void {
  const rule: Rule = {
    id: topicId,
    topicId,
    text,
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
  };
  withDatabase(storePath, PASSPHRASE, true, (db) => putRule(db, rule, []));
}

function putPendingRule(storePath: string, topicId: string, text: string): void {
  const rule: Rule = {
    id: topicId,
    topicId,
    text,
    status: "weak_signal",
    supportCount: 1,
    consistency: 0.4,
    createdAt: new Date().toISOString(),
    lastConfirmedAt: null,
    reviewStatus: "pending",
    origin: "derived",
    supersededByRuleId: null,
    correctionDraftId: null,
    correctionQuestion: null,
  };
  withDatabase(storePath, PASSPHRASE, true, (db) => putRule(db, rule, []));
}

describe("buildTopicCoverage — an empty or thin corpus says so (#277 AC1)", () => {
  it("reports tooThin with zero questions, no topics, no gaps on a brand-new store", () => {
    const storePath = initStore();
    const coverage = buildTopicCoverage(storePath, PASSPHRASE, duoDir());
    expect(coverage.tooThin).toBe(true);
    expect(coverage.totalQuestions).toBe(0);
    expect(coverage.coveredShare).toBe(0);
    expect(coverage.topics).toEqual([]);
    expect(coverage.gaps).toEqual([]);
  });
});

describe("buildTopicCoverage — joining the portrait's topics against the rules table", () => {
  it("marks a topic covered only once its rule is approved, and leaves everything else a gap", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [
      { id: "topic-leave", label: "Leave policy", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-printer", label: "Printer issues", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-onboarding", label: "Onboarding", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    // 6 leave questions (approved rule), 3 printer questions (a weak_signal,
    // still-pending rule — not covered), 1 onboarding question (no rule at
    // all) — ten total, enough to clear tooThin.
    await seedPairs(storePath, "topic-leave", 6);
    await seedPairs(storePath, "topic-printer", 3);
    await seedPairs(storePath, "topic-onboarding", 1);
    putApprovedRule(storePath, "topic-leave", "Standard leave is five days per quarter.");
    putPendingRule(storePath, "topic-printer", "Printer jams clear from the second tray.");
    // topic-onboarding gets no rule at all — the plainest kind of gap.

    const coverage = buildTopicCoverage(storePath, PASSPHRASE, dir);
    expect(coverage.tooThin).toBe(false);
    expect(coverage.totalQuestions).toBe(10);

    const byId = new Map(coverage.topics.map((topic) => [topic.topicId, topic]));
    expect(byId.get("topic-leave")).toMatchObject({ covered: true, ruleStatus: "confirmed", reviewStatus: "approved", questionCount: 6 });
    expect(byId.get("topic-printer")).toMatchObject({ covered: false, ruleStatus: "weak_signal", reviewStatus: "pending", questionCount: 3 });
    expect(byId.get("topic-onboarding")).toMatchObject({ covered: false, ruleStatus: "none", reviewStatus: "none", questionCount: 1 });

    // Covered share is the fraction of QUESTIONS (not topics) behind an approved rule: 6 of 10.
    expect(coverage.coveredShare).toBeCloseTo(0.6, 5);

    // Gaps are every uncovered topic, most-asked first (same order the portrait itself sorts in).
    expect(coverage.gaps.map((gap) => gap.topicId)).toEqual(["topic-printer", "topic-onboarding"]);
    expect(coverage.gaps.every((gap) => !gap.covered)).toBe(true);
  });

  it("a topic the owner explicitly rejected a rule for stays a gap, not covered", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-comp", label: "Compensation", createdAt: "2026-01-01T00:00:00.000Z" }]);
    await seedPairs(storePath, "topic-comp", 12);
    const rule: Rule = {
      id: "topic-comp",
      topicId: "topic-comp",
      text: "Never discuss comp figures.",
      status: "confirmed",
      supportCount: 5,
      consistency: 0.9,
      createdAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
      reviewStatus: "rejected",
      origin: "derived",
      supersededByRuleId: null,
      correctionDraftId: null,
      correctionQuestion: null,
    };
    withDatabase(storePath, PASSPHRASE, true, (db) => putRule(db, rule, []));

    const coverage = buildTopicCoverage(storePath, PASSPHRASE, dir);
    expect(coverage.coveredShare).toBe(0);
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0]).toMatchObject({ topicId: "topic-comp", covered: false, reviewStatus: "rejected" });
  });
});
