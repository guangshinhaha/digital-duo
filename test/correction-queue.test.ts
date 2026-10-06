import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, DraftNotFoundError, type DraftProvenance } from "../src/drafting/draft-log.js";
import { classifyAndQueueEdit, NoDraftTextError } from "../src/corrections/classify.js";
import { getCorrectionCandidate, listCorrectionCandidates, queueCorrectionCandidate, requirePendingCandidate, setCandidateStatus } from "../src/corrections/queue.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { markRoomOffTheRecord } from "../src/workspace/off-the-record.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function seedDraft(storePath: string, question: string, draftText: string, provenance?: DraftProvenance): string {
  return appendDraft(storePath, PASSPHRASE, {
    question,
    threadContext: null,
    draftText,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.9,
    sources: [],
    provenance,
  });
}

const WORKSPACE_PROVENANCE = (roomId: string): DraftProvenance => ({
  origin: "channel",
  channelKind: "workspace",
  askerRef: "@bob:workspace",
  threadId: roomId,
  permalink: null,
});

describe("classifyAndQueueEdit — every candidate stores the draft, the sent text, and the question (#37 AC checklist)", () => {
  it("queues one style candidate for a style-only edit, carrying the full triple", async () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting tuesday 3pm main office");
    expect(result.classification).toBe("style");
    expect(result.queuedKinds).toEqual(["style"]);

    const candidates = listCorrectionCandidates(storePath, PASSPHRASE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "style",
      draftId,
      question: "when is the meeting?",
      draftText: "the meeting is on tuesday at 3pm in the main office",
      sentText: "meeting tuesday 3pm main office",
      status: "pending",
    });
  });

  it("queues one substance candidate for a substance-only edit", async () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "the budget review moved to thursday afternoon");
    expect(result.classification).toBe("substance");
    expect(result.queuedKinds).toEqual(["substance"]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE)).toHaveLength(1);
  });

  it("splits a mixed edit into two candidates, one of each kind", async () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "meeting tuesday 3pm main office");

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting thursday 3pm branch office");
    expect(result.classification).toBe("both");
    expect(new Set(result.queuedKinds)).toEqual(new Set(["style", "substance"]));

    const candidates = listCorrectionCandidates(storePath, PASSPHRASE);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((c) => c.kind))).toEqual(new Set(["style", "substance"]));
  });

  it("queues nothing for a trivial edit", async () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "is that right?", "Yes, that's correct.");

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "Yes, that's correct");
    expect(result.classification).toBe("trivial");
    expect(result.queuedKinds).toEqual([]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE)).toEqual([]);
  });

  it("throws NoDraftTextError against an escalated draft (no draft text to diff)", async () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
    });

    await expect(classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "some answer")).rejects.toThrow(NoDraftTextError);
  });

  it("fails loudly for an unknown draft id", async () => {
    const storePath = initStore();
    await expect(classifyAndQueueEdit(storePath, PASSPHRASE, "nope", "some answer")).rejects.toThrow(DraftNotFoundError);
  });

  it("is idempotent: classifying the same draft twice does not duplicate the queue", async () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");

    await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting tuesday 3pm main office");
    const second = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting tuesday 3pm main office");

    expect(second.queuedKinds).toEqual([]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE)).toHaveLength(1);
  });

  it("does not re-propose a candidate identical to one already rejected (#38-facing dedupe)", async () => {
    const storePath = initStore();
    const firstDraftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");
    await classifyAndQueueEdit(storePath, PASSPHRASE, firstDraftId, "meeting tuesday 3pm main office");
    const [candidate] = listCorrectionCandidates(storePath, PASSPHRASE);
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      requirePendingCandidate(db, candidate.id);
      setCandidateStatus(db, candidate.id, "rejected");
    });

    const secondDraftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");
    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, secondDraftId, "meeting tuesday 3pm main office");

    expect(result.queuedKinds).toEqual([]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE, "pending")).toEqual([]);
  });
});

describe("classifyAndQueueEdit — guangshinhaha/duo#274: a room marked off the record is never learned from", () => {
  it("still reports the true classification, but queues nothing, for a draft in an off-the-record room", async () => {
    const storePath = initStore();
    const duoDir = tempDir();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office", WORKSPACE_PROVENANCE("!off:workspace"));
    markRoomOffTheRecord(duoDir, "!off:workspace");

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting tuesday 3pm main office", undefined, duoDir);
    expect(result.classification).toBe("style");
    expect(result.queuedKinds).toEqual([]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE)).toEqual([]);
  });

  it("queues normally for a room that is not off the record, even when duoDir is supplied", async () => {
    const storePath = initStore();
    const duoDir = tempDir();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office", WORKSPACE_PROVENANCE("!on:workspace"));

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting tuesday 3pm main office", undefined, duoDir);
    expect(result.queuedKinds).toEqual(["style"]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE)).toHaveLength(1);
  });

  it("queues normally when duoDir is omitted — pre-#274 behaviour, byte-identical", async () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office", WORKSPACE_PROVENANCE("!off:workspace"));

    const result = await classifyAndQueueEdit(storePath, PASSPHRASE, draftId, "meeting tuesday 3pm main office");
    expect(result.queuedKinds).toEqual(["style"]);
  });
});

describe("queueCorrectionCandidate / listCorrectionCandidates", () => {
  it("is empty on a fresh store", () => {
    const storePath = initStore();
    expect(listCorrectionCandidates(storePath, PASSPHRASE)).toEqual([]);
  });

  it("lists candidates oldest first", () => {
    const storePath = initStore();
    const draftA = seedDraft(storePath, "q1", "draft a");
    const draftB = seedDraft(storePath, "q2", "draft b");
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId: draftA, question: "q1", draftText: "draft a", sentText: "sent a" });
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "substance", draftId: draftB, question: "q2", draftText: "draft b", sentText: "sent b" });

    const candidates = listCorrectionCandidates(storePath, PASSPHRASE);
    expect(candidates.map((c) => c.question)).toEqual(["q1", "q2"]);
  });

  it("round-trips through getCorrectionCandidate", () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "q", "draft");
    const { id } = queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId, question: "q", draftText: "draft", sentText: "sent" });
    expect(getCorrectionCandidate(storePath, PASSPHRASE, id)).toMatchObject({ id, kind: "style", status: "pending" });
  });
});
