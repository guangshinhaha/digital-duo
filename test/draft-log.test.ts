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
});
