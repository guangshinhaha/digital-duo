import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, recordDraftOutcome } from "../src/drafting/draft-log.js";
import { appendPublicAnswerLogEntry } from "../src/permissions/public-answer-log.js";
import { assembleDailyBrief } from "../src/duo/daily-brief.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

describe("duo#282 — assembleDailyBrief", () => {
  it("is all-clear on a fresh store", () => {
    const storePath = initStore();
    const brief = assembleDailyBrief(storePath, PASSPHRASE);
    expect(brief).toMatchObject({ waitingOnYou: [], passedOn: [], handledByDuo: [], allClear: true });
  });

  it("puts a pending, non-escalated draft in waitingOnYou and a pending escalation in passedOn", () => {
    const storePath = initStore();
    const waitingId = appendDraft(storePath, PASSPHRASE, {
      question: "draft waiting",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const passedId = appendDraft(storePath, PASSPHRASE, {
      question: "passed on question",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "below confidence threshold",
      confidenceScore: 0.2,
      sources: [],
    });

    const brief = assembleDailyBrief(storePath, PASSPHRASE);
    expect(brief.waitingOnYou.map((item) => item.draftId)).toEqual([waitingId]);
    expect(brief.passedOn.map((item) => item.draftId)).toEqual([passedId]);
    expect(brief.passedOn[0]?.escalationReason).toBe("below confidence threshold");
    expect(brief.allClear).toBe(false);
  });

  it("leaves a dispositioned draft out of waitingOnYou — it is no longer waiting", () => {
    const storePath = initStore();
    const sentId = appendDraft(storePath, PASSPHRASE, {
      question: "already sent",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    recordDraftOutcome(storePath, PASSPHRASE, sentId, "sent", undefined);

    const brief = assembleDailyBrief(storePath, PASSPHRASE);
    expect(brief.waitingOnYou).toEqual([]);
    expect(brief.allClear).toBe(true);
  });

  it("counts an 'answered' public-answer-log entry as handled by the duo, but not a passed-on one", () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what's the refund window",
      threadContext: null,
      draftText: "30 days",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });
    appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "what's the refund window",
      askerRef: "colleague-ref",
      topicId: "topic-refunds",
      outcome: "answered",
      text: "30 days",
      draftId,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });
    appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "what's the legal position on X",
      askerRef: "colleague-ref",
      topicId: null,
      outcome: "passed_on",
      text: "Waiting on the owner.",
      draftId,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });

    const brief = assembleDailyBrief(storePath, PASSPHRASE);
    expect(brief.handledByDuo).toHaveLength(1);
    expect(brief.handledByDuo[0]?.question).toBe("what's the refund window");
    expect(brief.allClear).toBe(false);
  });

  it("excludes a draft created before the window's since timestamp", () => {
    const storePath = initStore();
    appendDraft(storePath, PASSPHRASE, {
      question: "old draft",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    // A `since` set in the future excludes every draft just appended.
    const futureSince = new Date(Date.now() + 60_000).toISOString();
    const brief = assembleDailyBrief(storePath, PASSPHRASE, futureSince);
    expect(brief.waitingOnYou).toEqual([]);
    expect(brief.since).toBe(futureSince);
  });

  it("defaults the window to the last 24 hours when since is omitted", () => {
    const storePath = initStore();
    const now = new Date("2026-06-15T12:00:00.000Z");
    const brief = assembleDailyBrief(storePath, PASSPHRASE, undefined, now);
    expect(brief.since).toBe("2026-06-14T12:00:00.000Z");
    expect(brief.generatedAt).toBe(now.toISOString());
  });
});
