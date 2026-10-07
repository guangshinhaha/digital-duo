import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { buildStarterSuggestions } from "../src/derivation/suggestions.js";
import { appendDraft } from "../src/drafting/draft-log.js";
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

describe("duo#305 — buildStarterSuggestions", () => {
  it("pads with fixed prompts on a brand-new store, never an empty list (AC1)", () => {
    const starters = buildStarterSuggestions(initStore(), PASSPHRASE, duoDir()).starters;
    expect(starters.length).toBeGreaterThan(0);
    expect(starters.length).toBeLessThanOrEqual(4);
  });

  it("leads with the most-asked coverage gap, phrased as a question", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-leave", label: "Leave policy", createdAt: "2026-01-01T00:00:00.000Z" }]);
    await seedPairs(storePath, "topic-leave", 5);
    const starters = buildStarterSuggestions(storePath, PASSPHRASE, dir).starters;
    expect(starters[0]).toBe("What do you know about Leave policy?");
  });

  it("never offers a gap starter for a topic whose rule is already approved", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-leave", label: "Leave policy", createdAt: "2026-01-01T00:00:00.000Z" }]);
    await seedPairs(storePath, "topic-leave", 5);
    const rule: Rule = {
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
    };
    withDatabase(storePath, PASSPHRASE, true, (db) => putRule(db, rule, []));
    const starters = buildStarterSuggestions(storePath, PASSPHRASE, dir).starters;
    expect(starters).not.toContain("What do you know about Leave policy?");
  });

  it("surfaces 'what's waiting on me' when a draft is pending", () => {
    const storePath = initStore();
    appendDraft(storePath, PASSPHRASE, {
      question: "draft waiting",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const starters = buildStarterSuggestions(storePath, PASSPHRASE, duoDir()).starters;
    expect(starters).toContain("What's waiting on me?");
  });

  it("surfaces 'passed on' over 'handled on its own' when both are true, matching the daily brief's own section order", () => {
    const storePath = initStore();
    appendDraft(storePath, PASSPHRASE, {
      question: "passed on question",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "below confidence threshold",
      confidenceScore: 0.2,
      sources: [],
    });
    const starters = buildStarterSuggestions(storePath, PASSPHRASE, duoDir()).starters;
    expect(starters).toContain("What have you passed on to me recently?");
    expect(starters).not.toContain("What's waiting on me?");
  });

  it("never returns more than four starters", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [
      { id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-b", label: "Topic B", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await seedPairs(storePath, "topic-a", 5);
    await seedPairs(storePath, "topic-b", 3);
    appendDraft(storePath, PASSPHRASE, {
      question: "draft waiting",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const starters = buildStarterSuggestions(storePath, PASSPHRASE, dir).starters;
    expect(starters.length).toBeLessThanOrEqual(4);
  });
});
