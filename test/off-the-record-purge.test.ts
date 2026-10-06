import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, type DraftProvenance } from "../src/drafting/draft-log.js";
import { listStandingOrderCandidates, queueStandingOrderCandidate } from "../src/drafting/standing-order-candidates.js";
import { purgeOffTheRecordRoom } from "../src/drafting/off-the-record-purge.js";
import { queueCorrectionCandidate, listCorrectionCandidates } from "../src/corrections/queue.js";
import { writeCorrectionRule } from "../src/derivation/rule-review.js";
import { listRules } from "../src/derivation/rules.js";
import { createEncryptedStore } from "../src/store/store.js";

/**
 * guangshinhaha/duo#274: "turning it on purges what was already learned
 * from that room" — the store-touching half, exercised end to end against
 * a real encrypted store and a real `duo/` directory.
 */

const tempDir = useTempDir("duo-off-the-record-purge-test-");
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

const roomProvenance = (roomId: string): DraftProvenance => ({
  origin: "channel",
  channelKind: "workspace",
  askerRef: "@bob:workspace",
  threadId: roomId,
  permalink: null,
});

describe("purgeOffTheRecordRoom", () => {
  it("rejects a pending standing-order candidate queued from an escalation in the room", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what is the policy?",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
      provenance: roomProvenance("!a:workspace"),
    });
    const candidateId = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "the policy is X");

    const result = purgeOffTheRecordRoom(storePath, PASSPHRASE, duoDir(), "!a:workspace");

    expect(result.draftIds).toEqual([draftId]);
    expect(result.standingOrderCandidatesRejected).toBe(1);
    const candidate = listStandingOrderCandidates(storePath, PASSPHRASE).find((c) => c.id === candidateId);
    expect(candidate?.status).toBe("rejected");
  });

  it("rejects a pending correction candidate queued from an edit in the room", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "when is the meeting?",
      threadContext: null,
      draftText: "the meeting is tuesday",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
      provenance: roomProvenance("!b:workspace"),
    });
    queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId,
      question: "when is the meeting?",
      draftText: "the meeting is tuesday",
      sentText: "the meeting is wednesday",
    });

    const result = purgeOffTheRecordRoom(storePath, PASSPHRASE, duoDir(), "!b:workspace");

    expect(result.correctionCandidatesRejected).toBe(1);
    expect(listCorrectionCandidates(storePath, PASSPHRASE, "pending")).toEqual([]);
    expect(listCorrectionCandidates(storePath, PASSPHRASE, "rejected")).toHaveLength(1);
  });

  it("rejects a rule already written and approved from a correction on a draft in the room", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what are office hours?",
      threadContext: null,
      draftText: "ten to six",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
      provenance: roomProvenance("!c:workspace"),
    });
    const rule = writeCorrectionRule(storePath, PASSPHRASE, duoDir(), "office hours", "office hours are nine to five", draftId, "what are office hours?");
    expect(rule.reviewStatus).toBe("approved");

    const result = purgeOffTheRecordRoom(storePath, PASSPHRASE, duoDir(), "!c:workspace");

    expect(result.rulesRejected).toBe(1);
    const stored = listRules(storePath, PASSPHRASE).find((r) => r.id === rule.id);
    expect(stored?.reviewStatus).toBe("rejected");
  });

  it("leaves another room's candidates and rules untouched", () => {
    const storePath = initStore();
    const inRoom = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
      provenance: roomProvenance("!purged:workspace"),
    });
    const elsewhere = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
      provenance: roomProvenance("!kept:workspace"),
    });
    queueStandingOrderCandidate(storePath, PASSPHRASE, inRoom, "answer 1");
    const keptCandidateId = queueStandingOrderCandidate(storePath, PASSPHRASE, elsewhere, "answer 2");

    purgeOffTheRecordRoom(storePath, PASSPHRASE, duoDir(), "!purged:workspace");

    const kept = listStandingOrderCandidates(storePath, PASSPHRASE).find((c) => c.id === keptCandidateId);
    expect(kept?.status).toBe("pending");
  });

  it("is a no-op, not an error, for a room with no drafts", () => {
    const storePath = initStore();
    const result = purgeOffTheRecordRoom(storePath, PASSPHRASE, duoDir(), "!never-asked:workspace");
    expect(result).toEqual({ draftIds: [], standingOrderCandidatesRejected: 0, correctionCandidatesRejected: 0, rulesRejected: 0 });
  });
});
