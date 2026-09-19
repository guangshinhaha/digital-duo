import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { defaultTopicLabel, readTopicsFile, runTopicAssignment, writeTopicsFile, type Topic } from "../src/derivation/topics.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";

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

/** Seeds a store with one question/answer qa_pair per given question text, all in separate threads (so extraction produces one pair per question) and returns nothing — call listQaPairs afterward. */
async function seedPairs(storePath: string, questionTexts: string[]): Promise<void> {
  const records = questionTexts.flatMap((text) => {
    const question = record({ kind: "question_to_me", author: "other", text });
    const answer = record({ kind: "my_answer", author: "me", text: "answered", threadId: question.threadId });
    return [question, answer];
  });
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs);
}

describe("runTopicAssignment — topics survive re-derivation", () => {
  it("keeps an existing topic's id when new pairs on the same subject arrive later", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    const first = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);
    expect(first.newTopics).toHaveLength(1);
    const originalTopicId = first.newTopics[0].id;

    await seedPairs(storePath, ["how many holiday days do we get?"]);
    const second = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);

    expect(second.newTopics).toEqual([]);
    expect(second.matchedTopicIds).toEqual([originalTopicId]);

    const topics = readTopicsFile(dir);
    expect(topics).toHaveLength(1);
    expect(topics[0].id).toBe(originalTopicId);
  });
});

describe("runTopicAssignment — an unmatched cluster is surfaced rather than force-fitted", () => {
  it("mints a new topic for a genuinely unrelated cluster instead of absorbing it", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    await runTopicAssignment(storePath, PASSPHRASE, dir, provider);

    await seedPairs(storePath, ["is the printer on the third floor broken again?"]);
    const result = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);

    expect(result.matchedTopicIds).toEqual([]);
    expect(result.newTopics).toHaveLength(1);
    expect(readTopicsFile(dir)).toHaveLength(2);
  });
});

describe("runTopicAssignment — renaming a topic breaks nothing", () => {
  it("keeps every reference resolving after a hand-edit to duo/topics.json", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    const first = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);
    const topicId = first.newTopics[0].id;

    // Hand-edit: rename the topic's label, as an owner would in an editor.
    const topics = readTopicsFile(dir);
    writeTopicsFile(dir, topics.map((topic) => (topic.id === topicId ? { ...topic, label: "Time off" } : topic)));

    // A later run over a genuinely new, related question must still resolve to the same id and must not clobber the rename.
    await seedPairs(storePath, ["how many holiday days do we get?"]);
    const second = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);
    expect(second.matchedTopicIds).toEqual([topicId]);

    const finalTopics = readTopicsFile(dir);
    expect(finalTopics).toHaveLength(1);
    expect(finalTopics[0].id).toBe(topicId);
    expect(finalTopics[0].label).toBe("Time off");
  });

  it("syncs a rename into the DB projection even on a run with no new pairs", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    await runTopicAssignment(storePath, PASSPHRASE, dir, provider);

    const topics = readTopicsFile(dir);
    writeTopicsFile(dir, topics.map((topic) => ({ ...topic, label: "Time off" })));

    const result = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);
    expect(result.assignedPairs).toBe(0);
    expect(readTopicsFile(dir)[0].label).toBe("Time off");
  });
});

describe("duo/topics.json is human-readable and safe to hand-edit", () => {
  it("is plain JSON with only id/label/createdAt fields, no embedding vectors", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    await runTopicAssignment(storePath, PASSPHRASE, dir, provider);

    const raw = readFileSync(join(dir, "topics.json"), "utf8");
    const parsed = JSON.parse(raw) as Topic[];
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]).sort()).toEqual(["createdAt", "id", "label"]);
  });

  it("returns an empty list, not an error, when the file doesn't exist yet", () => {
    expect(readTopicsFile(duoDir())).toEqual([]);
  });
});

describe("runTopicAssignment — labeling", () => {
  it("uses the deterministic default label when no labeler is configured", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    const result = await runTopicAssignment(storePath, PASSPHRASE, dir, provider);

    expect(result.newTopics[0].label).toBe(defaultTopicLabel(["what's our vacation policy?"]));
  });

  it("uses a supplied labeler when given", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const provider = createFakeEmbeddingProvider();

    await seedPairs(storePath, ["what's our vacation policy?"]);
    const result = await runTopicAssignment(storePath, PASSPHRASE, dir, provider, {
      labelTopic: async () => "Time off",
    });

    expect(result.newTopics[0].label).toBe("Time off");
  });
});

describe("runTopicAssignment — an empty batch is a no-op", () => {
  it("assigns nothing when there are no un-topic'd pairs", async () => {
    const storePath = initStore();
    const result = await runTopicAssignment(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider());
    expect(result).toEqual({ assignedPairs: 0, matchedTopicIds: [], newTopics: [] });
  });
});
