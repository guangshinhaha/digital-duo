import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adjudicate } from "../src/derivation/qa-pairs.js";
import { computeQaPairId, extractQaPairs, listQaPairs, runPairExtraction } from "../src/derivation/qa-pairs.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
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
    threadId: "t1",
    audience: "channel",
    ...overrides,
  });
}

describe("extractQaPairs — a clear question and reply become a pair", () => {
  it("links the question and answer, carrying thread and timestamp", async () => {
    const question = record({ kind: "question_to_me", author: "other", text: "can you review the incident doc?" });
    const answer = record({ kind: "my_answer", author: "me", text: "yes, will do by EOD" });

    const result = await extractQaPairs([question, answer]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toEqual({
      id: computeQaPairId(question.id, answer.id),
      questionId: question.id,
      answerId: answer.id,
      threadId: "t1",
      ts: answer.timestamp,
      topicId: null,
    });
    expect(result.unansweredCount).toBe(0);
    expect(result.ambiguousCount).toBe(0);
  });
});

describe("extractQaPairs — a thread with no answer produces no pair", () => {
  it("counts the question as unanswered instead", async () => {
    const question = record({ kind: "question_to_me", author: "other", text: "any update on the ticket?" });

    const result = await extractQaPairs([question]);

    expect(result.pairs).toEqual([]);
    expect(result.unansweredCount).toBe(1);
  });
});

describe("extractQaPairs — multi-turn exchanges do not fragment into noise", () => {
  it("produces one pair using the last substantive answer, not one per turn", async () => {
    const question = record({ kind: "question_to_me", author: "other", text: "what's our leave policy?" });
    const firstTurn = record({ kind: "my_answer", author: "me", text: "let me check the handbook" });
    const secondTurn = record({ kind: "my_answer", author: "me", text: "confirmed: five days per quarter" });
    const ack = record({ kind: "my_thinking", author: "other", text: "thanks!" });

    const result = await extractQaPairs([question, firstTurn, secondTurn, ack]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].questionId).toBe(question.id);
    expect(result.pairs[0].answerId).toBe(secondTurn.id);
  });
});

describe("extractQaPairs — records outside any thread are skipped", () => {
  it("ignores a record with no threadId entirely", async () => {
    const stray = record({ kind: "question_to_me", author: "other", text: "no thread here", threadId: null });
    const result = await extractQaPairs([stray]);
    expect(result.pairs).toEqual([]);
    expect(result.unansweredCount).toBe(0);
  });
});

describe("extractQaPairs — a second question that already has an answer starts a fresh, unambiguous span", () => {
  it("closes the first pair and opens a new one, without ambiguity", async () => {
    const q1 = record({ kind: "question_to_me", author: "other", text: "is the release on track?" });
    const a1 = record({ kind: "my_answer", author: "me", text: "yes, on track" });
    const q2 = record({ kind: "question_to_me", author: "other", text: "who's on call this week?" });
    const a2 = record({ kind: "my_answer", author: "me", text: "I am" });

    const result = await extractQaPairs([q1, a1, q2, a2]);

    expect(result.pairs).toHaveLength(2);
    expect(result.pairs.map((pair) => pair.questionId)).toEqual([q1.id, q2.id]);
    expect(result.ambiguousCount).toBe(0);
  });
});

describe("extractQaPairs — ambiguous cases: two unanswered questions in a row", () => {
  it("without an adjudicator, defaults to treating the second as a new question and counts the ambiguity", async () => {
    const q1 = record({ kind: "question_to_me", author: "other", text: "any thoughts on the proposal?" });
    const q2 = record({ kind: "question_to_me", author: "other", text: "actually, different question: who owns this?" });
    const answer = record({ kind: "my_answer", author: "me", text: "I'll own it" });

    const result = await extractQaPairs([q1, q2, answer]);

    expect(result.ambiguousCount).toBe(1);
    expect(result.adjudicatedCount).toBe(0);
    expect(result.unansweredCount).toBe(1); // q1 never got answered
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].questionId).toBe(q2.id);
  });

  it("calls the adjudicator, and folds the two questions into one span when it says continuation", async () => {
    const q1 = record({ kind: "question_to_me", author: "other", text: "any thoughts on the proposal?" });
    const q2 = record({ kind: "question_to_me", author: "other", text: "I mean the budget proposal specifically" });
    const answer = record({ kind: "my_answer", author: "me", text: "looks reasonable to me" });

    const adjudicate: Adjudicate = async () => "continuation";
    const result = await extractQaPairs([q1, q2, answer], { adjudicate });

    expect(result.ambiguousCount).toBe(1);
    expect(result.adjudicatedCount).toBe(1);
    expect(result.unansweredCount).toBe(0);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].questionId).toBe(q1.id); // the original, still-open question
    expect(result.pairs[0].answerId).toBe(answer.id);
  });

  it("respects the adjudicator's new_question verdict", async () => {
    const q1 = record({ kind: "question_to_me", author: "other", text: "any thoughts on the proposal?" });
    const q2 = record({ kind: "question_to_me", author: "other", text: "unrelated: is the printer fixed?" });
    const answer = record({ kind: "my_answer", author: "me", text: "yes, fixed it this morning" });

    const adjudicate: Adjudicate = async () => "new_question";
    const result = await extractQaPairs([q1, q2, answer], { adjudicate });

    expect(result.adjudicatedCount).toBe(1);
    expect(result.unansweredCount).toBe(1); // q1
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].questionId).toBe(q2.id);
  });
});

describe("extractQaPairs — several threads are handled independently", () => {
  it("does not let one thread's records leak into another's span", async () => {
    const q1 = record({ kind: "question_to_me", author: "other", text: "thread one question", threadId: "t1" });
    const a1 = record({ kind: "my_answer", author: "me", text: "thread one answer", threadId: "t1" });
    const q2 = record({ kind: "question_to_me", author: "other", text: "thread two question", threadId: "t2" });

    const result = await extractQaPairs([q1, a1, q2]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].threadId).toBe("t1");
    expect(result.unansweredCount).toBe(1); // thread two's question, unanswered
  });
});

describe("runPairExtraction — persistence over a real store", () => {
  it("extracts, writes, and is idempotent on a second run over the same records", async () => {
    const storePath = initStore();
    const question = record({ kind: "question_to_me", author: "other", text: "can you approve the PR?" });
    const answer = record({ kind: "my_answer", author: "me", text: "approved" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);

    const first = await runPairExtraction(storePath, PASSPHRASE);
    expect(first.written).toBe(1);
    expect(first.alreadyPresent).toBe(0);
    expect(listQaPairs(storePath, PASSPHRASE)).toHaveLength(1);

    const second = await runPairExtraction(storePath, PASSPHRASE);
    expect(second.written).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(listQaPairs(storePath, PASSPHRASE)).toHaveLength(1);
  });

  it("on an empty store, extracts nothing and writes nothing", async () => {
    const storePath = initStore();
    const result = await runPairExtraction(storePath, PASSPHRASE);
    expect(result.pairs).toEqual([]);
    expect(result.written).toBe(0);
  });
});
