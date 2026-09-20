import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { answerPublicly, type AskerContext } from "../src/permissions/public-answer.js";
import { appendPublicAnswerLogEntry, listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import {
  correctPublicAnswer,
  NothingToCorrectError,
  PublicAnswerEntryNotFoundError,
} from "../src/permissions/public-correction.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { listGrid } from "../src/trust/grid.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;
const OWNER_NAME = "Dana Cole";

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

function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

async function seedGrantedLeaveTopic(storePath: string, dir: string): Promise<void> {
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: "OFFICIAL (OPEN)\nfive days per quarter, per the vacation policy", threadId: "shared" });
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
  writeTopicsFile(dir, [{ id: "topic-leave", label: "Vacation leave", createdAt: new Date().toISOString() }]);
  grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });
}

async function postAnAnswer(storePath: string, dir: string, asker: AskerContext = { ref: "colleague-1", resolved: null, askLinkId: null }): Promise<string> {
  const outcome = await answerPublicly(
    storePath,
    PASSPHRASE,
    dir,
    "how much vacation leave do I get",
    asker,
    createFakeEmbeddingProvider(),
    agreeingProvider("Five days per quarter, per policy."),
    CONFIDENCE_CONFIG,
    OWNER_NAME,
  );
  if (outcome.kind !== "answered") {
    throw new Error(`expected an answered outcome, got ${outcome.kind}`);
  }
  return outcome.logEntryId;
}

describe("correctPublicAnswer — a correction reaches the original readers (#45 AC1)", () => {
  it("posts a correction visibly linked to the original, recorded as a new append-only entry", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedGrantedLeaveTopic(storePath, dir);
    // The original came through an ask link with a resolved asker, so this
    // test also pins #160's KTD6: the correction mirrors that context.
    const originalId = await postAnAnswer(storePath, dir, {
      ref: "jdoe",
      resolved: true,
      askLinkId: "0193c0ff-2000-7000-8000-000000000001",
    });

    const result = correctPublicAnswer(storePath, PASSPHRASE, dir, originalId, "Actually it's ten days per quarter.", OWNER_NAME, true);

    expect(result.originalEntryId).toBe(originalId);
    expect(result.postedInThread).toBe(true);
    expect(result.threadGoneNotice).toBeUndefined();
    expect(result.text).toContain("ten days per quarter");
    expect(result.text).toContain("Five days per quarter"); // quotes the original for visible linkage
    expect(result.notifiedAskerRefs).toEqual(["jdoe"]);

    const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(entries).toHaveLength(2);
    const correctionEntry = entries.find((entry) => entry.id === result.correctionEntryId);
    expect(correctionEntry?.correctsEntryId).toBe(originalId);
    expect(correctionEntry?.outcome).toBe("corrected");
    expect(correctionEntry?.text).toBe(result.text);
    // #160 (KTD6): the correction entry carries the original's asker context.
    expect(correctionEntry).toMatchObject({
      askerRef: "jdoe",
      askLinkId: "0193c0ff-2000-7000-8000-000000000001",
      askerResolved: true,
      clearanceApplied: "official_open",
    });

    const originalEntry = entries.find((entry) => entry.id === originalId);
    expect(originalEntry?.text).toContain("Five days per quarter"); // the original stands, unedited (out of scope: deleting it)
    // ...including its asker context, exactly as answered (#160).
    expect(originalEntry).toMatchObject({
      askerRef: "jdoe",
      askLinkId: "0193c0ff-2000-7000-8000-000000000001",
      askerResolved: true,
      clearanceApplied: "official_open",
    });
  });
});

describe("correctPublicAnswer — a correction in a gone thread is handled (#45 AC2)", () => {
  it("still records the correction and demotes the topic, but reports the thread is gone rather than posting", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedGrantedLeaveTopic(storePath, dir);
    const originalId = await postAnAnswer(storePath, dir);

    const before = listPublicAnswerLogEntries(storePath, PASSPHRASE).length;
    const result = correctPublicAnswer(storePath, PASSPHRASE, dir, originalId, "Actually it's ten days per quarter.", OWNER_NAME, false);

    expect(result.postedInThread).toBe(false);
    expect(result.threadGoneNotice).toMatch(/no longer exists/i);
    expect(result.threadGoneNotice).toMatch(/recorded/i);

    // Not silently dropped: the correction entry still exists, and the
    // topic is still demoted, regardless of the thread being gone.
    const after = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(after).toHaveLength(before + 1);
    expect(result.demotion?.demoted).toBe(true);
  });
});

describe("correctPublicAnswer — a correction demotes the topic immediately (#45 AC3)", () => {
  it("drops the granted T0 cell a level and says so in the posted text", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedGrantedLeaveTopic(storePath, dir);
    expect(listGrid(storePath, PASSPHRASE, dir).find((row) => row.topicId === "topic-leave")?.level).toBe("auto");
    const originalId = await postAnAnswer(storePath, dir);

    const result = correctPublicAnswer(storePath, PASSPHRASE, dir, originalId, "Actually it's ten days per quarter.", OWNER_NAME);

    expect(result.demotion?.fromLevel).toBe("auto");
    expect(result.demotion?.toLevel).toBe("approve");
    expect(result.demotion?.demoted).toBe(true);
    expect(result.text).toMatch(/asking the owner first/i);

    const cell = listGrid(storePath, PASSPHRASE, dir).find((row) => row.topicId === "topic-leave");
    expect(cell?.level).toBe("approve");
  });
});

describe("correctPublicAnswer — error cases", () => {
  it("refuses a correction for an id that names no logged exchange at all", async () => {
    const storePath = initStore();
    const dir = duoDir();
    expect(() => correctPublicAnswer(storePath, PASSPHRASE, dir, "not-a-real-id", "text", OWNER_NAME)).toThrow(
      PublicAnswerEntryNotFoundError,
    );
  });

  it("refuses to correct an exchange that never asserted an answer (passed-on or refused)", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const passedOnId = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "what is the vacation policy?",
      askerRef: "colleague-2",
      topicId: null,
      outcome: "passed_on",
      text: "passed on",
      draftId: "draft-1",
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });
    expect(() => correctPublicAnswer(storePath, PASSPHRASE, dir, passedOnId, "text", OWNER_NAME)).toThrow(NothingToCorrectError);
  });

  it("never throws over a missing topic — a defensive guard, not an assumed invariant", async () => {
    const storePath = initStore();
    const dir = duoDir();
    const entryId = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "some question",
      askerRef: "colleague-3",
      topicId: null,
      outcome: "answered",
      text: "an answer with no topic somehow",
      draftId: "draft-2",
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });
    const result = correctPublicAnswer(storePath, PASSPHRASE, dir, entryId, "corrected text", OWNER_NAME);
    expect(result.demotion).toBeUndefined();
    expect(result.correctedTopicId).toBeNull();
  });
});
