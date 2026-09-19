import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, DraftNotFoundError, getDraft, listDrafts, recordDraftOutcome } from "../src/drafting/draft-log.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

describe("appendDraft / getDraft", () => {
  it("round-trips a drafted (non-escalated) entry", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "How much leave do I get?",
      threadContext: null,
      draftText: "Five days per quarter.",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [{ kind: "rule", id: "topic-leave", label: "standing order: five days" }],
    });

    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft).toMatchObject({
      id,
      question: "How much leave do I get?",
      draftText: "Five days per quarter.",
      escalated: false,
      confidenceScore: 0.8,
      outcome: null,
    });
    expect(draft?.sources).toEqual([{ kind: "rule", id: "topic-leave", label: "standing order: five days" }]);
  });

  it("defaults refused to false and escalationThreshold to 0.55 when the caller omits them", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.refused).toBe(false);
    expect(draft?.escalationThreshold).toBe(0.55);
  });

  it("round-trips a refused escalation with a non-default threshold", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "refused subject",
      confidenceScore: 0,
      sources: [],
      refused: true,
      escalationThreshold: 0.7,
    });
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.refused).toBe(true);
    expect(draft?.escalationThreshold).toBe(0.7);
  });

  it("round-trips an escalated entry with a null draftText", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "What's my bonus?",
      threadContext: "prior context",
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0.1,
      sources: [],
    });
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.draftText).toBeNull();
    expect(draft?.escalated).toBe(true);
    expect(draft?.escalationReason).toBe("no supporting evidence");
    expect(draft?.threadContext).toBe("prior context");
  });

  it("returns undefined for an unknown id", () => {
    const storePath = initStore();
    expect(getDraft(storePath, PASSPHRASE, "nope")).toBeUndefined();
  });
});

describe("recordDraftOutcome — the outcome is recorded against the draft (#32 AC3)", () => {
  it("stores sent/edited/discarded with a timestamp", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    recordDraftOutcome(storePath, PASSPHRASE, id, "edited");
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.outcome).toBe("edited");
    expect(draft?.outcomeRecordedAt).not.toBeNull();
  });

  it("throws DraftNotFoundError for an unknown id, rather than silently no-op-ing", () => {
    const storePath = initStore();
    expect(() => recordDraftOutcome(storePath, PASSPHRASE, "nope", "sent")).toThrow(DraftNotFoundError);
  });

  it("stores the sent text when supplied (#37: needed to diff draft vs sent at all)", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    recordDraftOutcome(storePath, PASSPHRASE, id, "edited", "an edited sent version");
    const draft = getDraft(storePath, PASSPHRASE, id);
    expect(draft?.sentText).toBe("an edited sent version");
  });

  it("leaves sentText null when it isn't supplied", () => {
    const storePath = initStore();
    const id = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
    });

    recordDraftOutcome(storePath, PASSPHRASE, id, "sent");
    expect(getDraft(storePath, PASSPHRASE, id)?.sentText).toBeNull();
  });
});

describe("listDrafts", () => {
  it("lists every draft, oldest first", () => {
    const storePath = initStore();
    const first = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: "a1",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const second = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0.2,
      sources: [],
    });
    const drafts = listDrafts(storePath, PASSPHRASE);
    expect(drafts.map((draft) => draft.id)).toEqual([first, second]);
  });

  it("is empty on a fresh store", () => {
    const storePath = initStore();
    expect(listDrafts(storePath, PASSPHRASE)).toEqual([]);
  });

  it("filters to pending (undispositioned) drafts only, oldest first", () => {
    const storePath = initStore();
    const pending = appendDraft(storePath, PASSPHRASE, {
      question: "still pending",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const dispositioned = appendDraft(storePath, PASSPHRASE, {
      question: "already handled",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    recordDraftOutcome(storePath, PASSPHRASE, dispositioned, "sent", undefined);

    expect(listDrafts(storePath, PASSPHRASE, { outcome: "pending" }).map((draft) => draft.id)).toEqual([pending]);
  });

  it("filters to a concrete outcome", () => {
    const storePath = initStore();
    const sent = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const discarded = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    recordDraftOutcome(storePath, PASSPHRASE, sent, "sent", undefined);
    recordDraftOutcome(storePath, PASSPHRASE, discarded, "discarded", undefined);

    expect(listDrafts(storePath, PASSPHRASE, { outcome: "sent" }).map((draft) => draft.id)).toEqual([sent]);
  });

  it("caps results with limit", () => {
    const storePath = initStore();
    for (let i = 0; i < 3; i += 1) {
      appendDraft(storePath, PASSPHRASE, {
        question: `q${i}`,
        threadContext: null,
        draftText: "a",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.7,
        sources: [],
      });
    }
    expect(listDrafts(storePath, PASSPHRASE, { limit: 2 })).toHaveLength(2);
  });

  it("excludes drafts created at or after the before cursor", () => {
    const storePath = initStore();
    const first = appendDraft(storePath, PASSPHRASE, {
      question: "q1",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const firstDraft = getDraft(storePath, PASSPHRASE, first);
    appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });

    const cutoff = new Date(new Date(firstDraft!.createdAt).getTime() + 1).toISOString();
    expect(listDrafts(storePath, PASSPHRASE, { before: cutoff }).map((draft) => draft.id)).toEqual([first]);
  });
});
