import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft } from "../src/drafting/draft-log.js";
import { queueStandingOrderCandidate } from "../src/drafting/standing-order-candidates.js";
import { queueCorrectionCandidate } from "../src/corrections/queue.js";
import {
  approveCandidate,
  CandidateConflictError,
  listPendingReview,
  rejectCandidate,
  ReviewCandidateNotFoundError,
} from "../src/corrections/review.js";
import { listActiveRules, writeRuleByHand } from "../src/derivation/rule-review.js";
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

function seedDraft(storePath: string, question: string, draftText: string): string {
  return appendDraft(storePath, PASSPHRASE, {
    question,
    threadContext: null,
    draftText,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.9,
    sources: [],
  });
}

describe("listPendingReview — merges #37's and #34's queues (#38 AC1)", () => {
  it("is empty on a fresh store", () => {
    const storePath = initStore();
    expect(listPendingReview(storePath, PASSPHRASE, duoDir())).toEqual({ candidates: [], conflicts: [] });
  });

  it("lists a draft-edit-sourced candidate and an escalation-sourced candidate together, oldest first", () => {
    const storePath = initStore();
    const draftA = seedDraft(storePath, "q1", "draft a");
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId: draftA, question: "q1", draftText: "draft a", sentText: "sent a" });

    const escalatedDraft = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
    });
    queueStandingOrderCandidate(storePath, PASSPHRASE, escalatedDraft, "the answer");

    const review = listPendingReview(storePath, PASSPHRASE, duoDir());
    expect(review.candidates.map((c) => c.question)).toEqual(["q1", "q2"]);
    expect(review.candidates[0]).toMatchObject({ kind: "style", source: "draft_edit", draftText: "draft a", proposedText: "sent a" });
    expect(review.candidates[1]).toMatchObject({ kind: "substance", source: "escalation", draftText: null, proposedText: "the answer" });
  });
});

describe("approveCandidate — style (#38 AC1: writes to duo/voice.md with provenance)", () => {
  it("appends a Corrections entry to voice.md and marks the candidate approved", () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");
    queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "style",
      draftId,
      question: "when is the meeting?",
      draftText: "the meeting is on tuesday at 3pm in the main office",
      sentText: "meeting tuesday 3pm main office",
    });
    const [candidate] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;

    const result = approveCandidate(storePath, PASSPHRASE, duoDir(), candidate.id);
    expect(result.kind).toBe("style");

    const voiceFile = readFileSync(join(duoDir(), "voice.md"), "utf8");
    expect(voiceFile).toContain("## Corrections");
    expect(voiceFile).toContain("meeting tuesday 3pm main office");
    expect(voiceFile).toContain(draftId);

    expect(listPendingReview(storePath, PASSPHRASE, duoDir()).candidates).toEqual([]);
  });

  it("appends a second correction under the same heading rather than duplicating it", () => {
    const storePath = initStore();
    const draftId1 = seedDraft(storePath, "q1", "draft one");
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId: draftId1, question: "q1", draftText: "draft one", sentText: "sent one" });
    const draftId2 = seedDraft(storePath, "q2", "draft two");
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId: draftId2, question: "q2", draftText: "draft two", sentText: "sent two" });

    const [first, second] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;
    approveCandidate(storePath, PASSPHRASE, duoDir(), first.id);
    approveCandidate(storePath, PASSPHRASE, duoDir(), second.id);

    const voiceFile = readFileSync(join(duoDir(), "voice.md"), "utf8");
    expect(voiceFile.match(/## Corrections/g)).toHaveLength(1);
    expect(voiceFile).toContain("sent one");
    expect(voiceFile).toContain("sent two");
  });
});

describe("approveCandidate — substance (#38 AC1: writes to duo/rules/ with provenance)", () => {
  it("writes an active rule from a draft-edit-sourced substance candidate", () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");
    queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId,
      question: "when is the meeting?",
      draftText: "the meeting is on tuesday at 3pm in the main office",
      sentText: "the budget review moved to thursday afternoon",
    });
    const [candidate] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;

    const result = approveCandidate(storePath, PASSPHRASE, duoDir(), candidate.id);
    expect(result.kind).toBe("substance");
    expect(result.rule?.text).toBe("the budget review moved to thursday afternoon");
    expect(existsSync(join(duoDir(), "rules", `${result.rule?.id}.md`))).toBe(true);

    expect(listPendingReview(storePath, PASSPHRASE, duoDir()).candidates).toEqual([]);
  });

  it("writes an active rule from an escalation-sourced standing-order candidate", () => {
    const storePath = initStore();
    const escalatedDraft = appendDraft(storePath, PASSPHRASE, {
      question: "what is my end of year bonus",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0,
      sources: [],
    });
    queueStandingOrderCandidate(storePath, PASSPHRASE, escalatedDraft, "Bonuses are 5% of salary, paid in December.");
    const [candidate] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;

    const result = approveCandidate(storePath, PASSPHRASE, duoDir(), candidate.id);
    expect(result.rule?.text).toBe("Bonuses are 5% of salary, paid in December.");
    expect(listPendingReview(storePath, PASSPHRASE, duoDir()).candidates).toEqual([]);
  });
});

describe("rejectCandidate (#38 AC2: never re-proposed unchanged)", () => {
  it("marks a candidate rejected, removing it from the pending review", () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "q", "draft");
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId, question: "q", draftText: "draft", sentText: "sent" });
    const [candidate] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;

    rejectCandidate(storePath, PASSPHRASE, candidate.id);
    expect(listPendingReview(storePath, PASSPHRASE, duoDir()).candidates).toEqual([]);
  });

  it("throws for an already-reviewed candidate", () => {
    const storePath = initStore();
    const draftId = seedDraft(storePath, "q", "draft");
    queueCorrectionCandidate(storePath, PASSPHRASE, { kind: "style", draftId, question: "q", draftText: "draft", sentText: "sent" });
    const [candidate] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;
    rejectCandidate(storePath, PASSPHRASE, candidate.id);

    expect(() => rejectCandidate(storePath, PASSPHRASE, candidate.id)).toThrow();
    expect(() => approveCandidate(storePath, PASSPHRASE, duoDir(), candidate.id)).toThrow();
  });

  it("throws ReviewCandidateNotFoundError for an unknown id", () => {
    const storePath = initStore();
    expect(() => rejectCandidate(storePath, PASSPHRASE, "nope")).toThrow(ReviewCandidateNotFoundError);
    expect(() => approveCandidate(storePath, PASSPHRASE, duoDir(), "nope")).toThrow(ReviewCandidateNotFoundError);
  });
});

describe("conflict detection (#38 AC4: a candidate contradicting an active rule is flagged, not silently accumulated)", () => {
  it("flags a substance candidate whose proposed answer disagrees with an active rule on the same subject", () => {
    const storePath = initStore();
    writeRuleByHand(storePath, PASSPHRASE, duoDir(), "office hours", "office hours are nine to five, monday to friday");

    const draftId = seedDraft(storePath, "what are the office hours?", "office hours are flexible this month");
    queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId,
      question: "what are the office hours?",
      draftText: "office hours are flexible this month",
      sentText: "office hours are now ten to six every weekday",
    });

    const review = listPendingReview(storePath, PASSPHRASE, duoDir());
    expect(review.conflicts).toHaveLength(1);
    expect(review.conflicts[0].conflictingRule.text).toBe("office hours are nine to five, monday to friday");

    const [candidate] = review.candidates;
    expect(() => approveCandidate(storePath, PASSPHRASE, duoDir(), candidate.id)).toThrow(CandidateConflictError);
    // Refused, not partially applied: the candidate is still pending afterward.
    expect(listPendingReview(storePath, PASSPHRASE, duoDir()).candidates).toHaveLength(1);
  });

  it("approves with --supersedes-equivalent option, retiring the old rule instead of leaving both active (#39 AC3)", () => {
    const storePath = initStore();
    const oldRule = writeRuleByHand(storePath, PASSPHRASE, duoDir(), "office hours", "office hours are nine to five, monday to friday");

    const draftId = seedDraft(storePath, "what are the office hours?", "office hours are flexible this month");
    queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId,
      question: "what are the office hours?",
      draftText: "office hours are flexible this month",
      sentText: "office hours are now ten to six every weekday",
    });
    const [candidate] = listPendingReview(storePath, PASSPHRASE, duoDir()).candidates;

    const result = approveCandidate(storePath, PASSPHRASE, duoDir(), candidate.id, { supersedesRuleId: oldRule.id });
    expect(result.rule?.text).toBe("office hours are now ten to six every weekday");
    expect(result.rule?.correctionDraftId).toBe(draftId);
    expect(result.rule?.correctionQuestion).toBe("what are the office hours?");

    const activeRules = listActiveRules(storePath, PASSPHRASE, duoDir());
    expect(activeRules.map((r) => r.id)).toEqual([result.rule?.id]);
    expect(activeRules.map((r) => r.id)).not.toContain(oldRule.id);
  });

  it("does not flag a substance candidate unrelated to any active rule", () => {
    const storePath = initStore();
    writeRuleByHand(storePath, PASSPHRASE, duoDir(), "office hours", "office hours are nine to five, monday to friday");

    const draftId = seedDraft(storePath, "when is the budget review?", "the budget review is friday");
    queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId,
      question: "when is the budget review?",
      draftText: "the budget review is friday",
      sentText: "the budget review moved to next thursday",
    });

    expect(listPendingReview(storePath, PASSPHRASE, duoDir()).conflicts).toEqual([]);
  });
});
