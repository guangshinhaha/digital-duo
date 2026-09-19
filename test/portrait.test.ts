import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { buildInterruptionPortrait } from "../src/derivation/portrait.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
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

/** Seeds `count` question/answer pairs, each in its own thread unless `threadId` is given, all assigned to `topicId`. */
async function seedPairs(
  storePath: string,
  topicId: string | null,
  count: number,
  options: { threadId?: string; startTs?: number } = {},
): Promise<void> {
  const records = [];
  for (let i = 0; i < count; i++) {
    const questionOverrides: Partial<RecordInput> & { text: string } = { kind: "question_to_me", author: "other", text: `question ${i}` };
    if (options.threadId !== undefined) {
      questionOverrides.threadId = options.threadId;
    }
    if (options.startTs !== undefined) {
      questionOverrides.timestamp = new Date(options.startTs + i * 1000).toISOString();
    }
    const question = record(questionOverrides);

    const answerOverrides: Partial<RecordInput> & { text: string } = {
      kind: "my_answer",
      author: "me",
      text: `answer ${i}`,
      threadId: question.threadId,
    };
    if (options.startTs !== undefined) {
      answerOverrides.timestamp = new Date(options.startTs + i * 1000 + 500).toISOString();
    }
    const answer = record(answerOverrides);
    records.push(question, answer);
  }
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
}

describe("buildInterruptionPortrait — an empty or thin corpus says so", () => {
  it("reports tooThin with zero questions on a brand-new store", () => {
    const storePath = initStore();
    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());
    expect(portrait.tooThin).toBe(true);
    expect(portrait.totalQuestions).toBe(0);
    expect(portrait.periodStart).toBeNull();
    expect(portrait.topicBreakdown).toEqual([]);
  });

  it("still reports tooThin when there are a few pairs but fewer than the threshold", async () => {
    const storePath = initStore();
    await seedPairs(storePath, "topic-a", 3);
    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());
    expect(portrait.tooThin).toBe(true);
    expect(portrait.totalQuestions).toBe(3);
  });
});

describe("buildInterruptionPortrait — the shape of the interruptions", () => {
  it("reports total, period, topic distribution, and top-five share for a real corpus", async () => {
    const storePath = initStore();
    writeTopicsFile(duoDir(), [
      { id: "topic-a", label: "Leave policy", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-b", label: "Printer issues", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await seedPairs(storePath, "topic-a", 8, { startTs: Date.parse("2026-01-01T00:00:00.000Z") });
    await seedPairs(storePath, "topic-b", 4, { startTs: Date.parse("2026-02-01T00:00:00.000Z") });

    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());

    expect(portrait.tooThin).toBe(false);
    expect(portrait.totalQuestions).toBe(12);
    expect(portrait.periodStart).toBe("2026-01-01T00:00:00.500Z");
    expect(portrait.periodEnd).toBe("2026-02-01T00:00:03.500Z");

    expect(portrait.topicBreakdown).toHaveLength(2);
    expect(portrait.topicBreakdown[0]).toEqual({ topicId: "topic-a", label: "Leave policy", count: 8, share: 8 / 12 });
    expect(portrait.topicBreakdown[1]).toEqual({ topicId: "topic-b", label: "Printer issues", count: 4, share: 4 / 12 });
    // Only two topics exist, so all of it is "top five".
    expect(portrait.topFiveShare).toBeCloseTo(1, 5);
  });

  it("groups a pair with no topic yet under an explicit unassigned bucket rather than dropping it", async () => {
    const storePath = initStore();
    await seedPairs(storePath, null, 10);
    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());
    expect(portrait.tooThin).toBe(false);
    expect(portrait.topicBreakdown).toEqual([{ topicId: "unassigned", label: "not yet assigned to a topic", count: 10, share: 1 }]);
  });

  it("keeps a minor topic legible in the breakdown even next to a dominant one (AC3)", async () => {
    const storePath = initStore();
    await seedPairs(storePath, "topic-big", 50);
    await seedPairs(storePath, "topic-small", 1);
    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());
    const small = portrait.topicBreakdown.find((topic) => topic.topicId === "topic-small");
    expect(small).toBeDefined();
    expect(small!.count).toBe(1);
    expect(small!.share).toBeGreaterThan(0);
  });

  it("reports the busiest threads by volume", async () => {
    const storePath = initStore();
    await seedPairs(storePath, "topic-a", 5, { threadId: "thread-busy" });
    await seedPairs(storePath, "topic-a", 6); // separate threads, one pair each
    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());
    expect(portrait.busiestThreads[0]).toEqual({ threadId: "thread-busy", count: 5, share: 5 / 11 });
  });
});

describe("buildInterruptionPortrait — read-only", () => {
  it("never writes to the store", async () => {
    const storePath = initStore();
    await seedPairs(storePath, "topic-a", 10);
    const before = withDatabase(storePath, PASSPHRASE, false, (db) =>
      db.prepare(`SELECT COUNT(*) AS count FROM qa_pairs`).get(),
    );
    buildInterruptionPortrait(storePath, PASSPHRASE, duoDir());
    const after = withDatabase(storePath, PASSPHRASE, false, (db) =>
      db.prepare(`SELECT COUNT(*) AS count FROM qa_pairs`).get(),
    );
    expect(after).toEqual(before);
  });
});
