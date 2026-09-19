import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, DraftNotFoundError } from "../src/drafting/draft-log.js";
import { listStandingOrderCandidates, NotAnEscalationError, queueStandingOrderCandidate } from "../src/drafting/standing-order-candidates.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function seedEscalatedDraft(storePath: string, question = "what is my end of year bonus"): string {
  return appendDraft(storePath, PASSPHRASE, {
    question,
    threadContext: null,
    draftText: null,
    escalated: true,
    escalationReason: "no supporting evidence",
    confidenceScore: 0,
    sources: [],
  });
}

describe("queueStandingOrderCandidate — an escalation can be turned into a rule on the spot (#34 AC3)", () => {
  it("queues a pending candidate carrying the original question and the owner's answer", () => {
    const storePath = initStore();
    const draftId = seedEscalatedDraft(storePath);

    const candidateId = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "Bonuses are 5% of salary, paid in December.");

    const candidates = listStandingOrderCandidates(storePath, PASSPHRASE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: candidateId,
      draftId,
      question: "what is my end of year bonus",
      answerText: "Bonuses are 5% of salary, paid in December.",
      status: "pending",
    });
  });

  it("refuses to queue a candidate against a draft that was never escalated", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a confident answer",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    expect(() => queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "some answer")).toThrow(NotAnEscalationError);
  });

  it("fails loudly for an unknown draft id", () => {
    const storePath = initStore();
    expect(() => queueStandingOrderCandidate(storePath, PASSPHRASE, "nope", "answer")).toThrow(DraftNotFoundError);
  });
});

describe("listStandingOrderCandidates", () => {
  it("is empty on a fresh store", () => {
    const storePath = initStore();
    expect(listStandingOrderCandidates(storePath, PASSPHRASE)).toEqual([]);
  });

  it("lists candidates oldest first — the same batched-review queue every correction will enter", () => {
    const storePath = initStore();
    const first = seedEscalatedDraft(storePath, "q1");
    const second = seedEscalatedDraft(storePath, "q2");
    queueStandingOrderCandidate(storePath, PASSPHRASE, first, "a1");
    queueStandingOrderCandidate(storePath, PASSPHRASE, second, "a2");

    const candidates = listStandingOrderCandidates(storePath, PASSPHRASE);
    expect(candidates.map((c) => c.question)).toEqual(["q1", "q2"]);
    expect(candidates.every((c) => c.status === "pending")).toBe(true);
  });
});
