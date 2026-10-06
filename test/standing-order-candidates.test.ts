import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, DraftNotFoundError, type DraftProvenance } from "../src/drafting/draft-log.js";
import {
  DraftIsRefusedError,
  listStandingOrderCandidates,
  NotAnEscalationError,
  queueStandingOrderCandidate,
  RoomOffTheRecordError,
} from "../src/drafting/standing-order-candidates.js";
import { createEncryptedStore } from "../src/store/store.js";
import { markRoomOffTheRecord } from "../src/workspace/off-the-record.js";

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

  it("is idempotent: a second call against the same draft returns the same id and queues nothing new (a client remount re-submitting must never duplicate)", () => {
    const storePath = initStore();
    const draftId = seedEscalatedDraft(storePath);

    const first = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "Bonuses are 5% of salary.");
    const second = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "A different answer, same draft.");

    expect(second).toBe(first);
    const candidates = listStandingOrderCandidates(storePath, PASSPHRASE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].answerText).toBe("Bonuses are 5% of salary.");
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

  it("refuses to queue a candidate for a refused escalation — the owner's refusal is a boundary, not something an answer can override", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "this subject is refused",
      confidenceScore: 0,
      sources: [],
      refused: true,
    });

    expect(() => queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "an override answer")).toThrow(DraftIsRefusedError);
    expect(listStandingOrderCandidates(storePath, PASSPHRASE)).toHaveLength(0);
  });
});

const WORKSPACE_PROVENANCE = (roomId: string): DraftProvenance => ({
  origin: "channel",
  channelKind: "workspace",
  askerRef: "@bob:workspace",
  threadId: roomId,
  permalink: null,
});

describe("queueStandingOrderCandidate — guangshinhaha/duo#274: a room marked off the record is never learned from", () => {
  it("refuses to queue a candidate for an escalation in an off-the-record room, when duoDir is supplied", () => {
    const storePath = initStore();
    const duoDir = tempDir();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what is my end of year bonus",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0,
      sources: [],
      provenance: WORKSPACE_PROVENANCE("!off:workspace"),
    });
    markRoomOffTheRecord(duoDir, "!off:workspace");

    expect(() => queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "an answer", duoDir)).toThrow(RoomOffTheRecordError);
    expect(listStandingOrderCandidates(storePath, PASSPHRASE)).toHaveLength(0);
  });

  it("queues normally for a room that is not off the record, even when duoDir is supplied", () => {
    const storePath = initStore();
    const duoDir = tempDir();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what is my end of year bonus",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0,
      sources: [],
      provenance: WORKSPACE_PROVENANCE("!on:workspace"),
    });

    const candidateId = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "an answer", duoDir);
    expect(listStandingOrderCandidates(storePath, PASSPHRASE).map((candidate) => candidate.id)).toEqual([candidateId]);
  });

  it("queues normally when duoDir is omitted — pre-#274 behaviour, byte-identical", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0,
      sources: [],
      provenance: WORKSPACE_PROVENANCE("!off:workspace"),
    });

    expect(() => queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "an answer")).not.toThrow();
  });

  it("queues normally for an owner-asked draft (no room at all), even when duoDir is supplied", () => {
    const storePath = initStore();
    const duoDir = tempDir();
    const draftId = seedEscalatedDraft(storePath);

    expect(() => queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "an answer", duoDir)).not.toThrow();
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
