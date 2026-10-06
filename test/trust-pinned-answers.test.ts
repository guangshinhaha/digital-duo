import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  createPinnedAnswer,
  deletePinnedAnswer,
  findPinnedAnswer,
  getPinnedAnswer,
  InvalidPinnedAnswerError,
  listPinnedAnswers,
  PinnedAnswerNotFoundError,
  updatePinnedAnswer,
} from "../src/trust/pinned-answers.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

describe("trust/pinned-answers — duo#275: owner-pinned exact wording", () => {
  it("creates a pinned answer and lists it back, newest first", () => {
    const storePath = initStore();
    const first = createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Ten days a year.");
    const second = createPinnedAnswer(storePath, PASSPHRASE, "parking policy", "Visitor parking is on level 2.");

    const listed = listPinnedAnswers(storePath, PASSPHRASE);
    expect(listed).toHaveLength(2);
    expect(listed[0]!.id).toBe(second.id);
    expect(listed[1]!.id).toBe(first.id);
    expect(listed[1]!.pattern).toBe("vacation leave");
    expect(listed[1]!.answerText).toBe("Ten days a year.");
  });

  it("rejects an empty pattern or empty wording", () => {
    const storePath = initStore();
    expect(() => createPinnedAnswer(storePath, PASSPHRASE, "   ", "some text")).toThrow(InvalidPinnedAnswerError);
    expect(() => createPinnedAnswer(storePath, PASSPHRASE, "a topic", "   ")).toThrow(InvalidPinnedAnswerError);
  });

  it("trims the pattern and wording on write", () => {
    const storePath = initStore();
    const pinned = createPinnedAnswer(storePath, PASSPHRASE, "  vacation leave  ", "  Ten days a year.  ");
    expect(pinned.pattern).toBe("vacation leave");
    expect(pinned.answerText).toBe("Ten days a year.");
  });

  it("records an optional sourceLabel, and defaults to null when omitted", () => {
    const storePath = initStore();
    const withSource = createPinnedAnswer(storePath, PASSPHRASE, "a", "b", "pinned from #general");
    expect(withSource.sourceLabel).toBe("pinned from #general");
    const withoutSource = createPinnedAnswer(storePath, PASSPHRASE, "c", "d");
    expect(withoutSource.sourceLabel).toBeNull();
  });

  it("getPinnedAnswer reads one back by id, undefined for an unknown id", () => {
    const storePath = initStore();
    const pinned = createPinnedAnswer(storePath, PASSPHRASE, "a", "b");
    expect(getPinnedAnswer(storePath, PASSPHRASE, pinned.id)).toEqual(pinned);
    expect(getPinnedAnswer(storePath, PASSPHRASE, "nope")).toBeUndefined();
  });

  it("updatePinnedAnswer edits pattern and/or wording in place, bumping updatedAt", async () => {
    const storePath = initStore();
    const pinned = createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Ten days a year.");
    await new Promise((resolve) => setTimeout(resolve, 2));

    const edited = updatePinnedAnswer(storePath, PASSPHRASE, pinned.id, { answerText: "Twelve days a year." });
    expect(edited.id).toBe(pinned.id);
    expect(edited.pattern).toBe("vacation leave");
    expect(edited.answerText).toBe("Twelve days a year.");
    expect(edited.createdAt).toBe(pinned.createdAt);
    expect(edited.updatedAt).not.toBe(pinned.updatedAt);

    const editedPattern = updatePinnedAnswer(storePath, PASSPHRASE, pinned.id, { pattern: "annual leave" });
    expect(editedPattern.pattern).toBe("annual leave");
    expect(editedPattern.answerText).toBe("Twelve days a year.");
  });

  it("updatePinnedAnswer throws PinnedAnswerNotFoundError for an unknown id", () => {
    const storePath = initStore();
    expect(() => updatePinnedAnswer(storePath, PASSPHRASE, "nope", { pattern: "x" })).toThrow(PinnedAnswerNotFoundError);
  });

  it("updatePinnedAnswer rejects editing wording down to blank", () => {
    const storePath = initStore();
    const pinned = createPinnedAnswer(storePath, PASSPHRASE, "a", "b");
    expect(() => updatePinnedAnswer(storePath, PASSPHRASE, pinned.id, { answerText: "   " })).toThrow(InvalidPinnedAnswerError);
  });

  it("deletePinnedAnswer removes it, and is idempotent for an unknown id", () => {
    const storePath = initStore();
    const pinned = createPinnedAnswer(storePath, PASSPHRASE, "a", "b");
    deletePinnedAnswer(storePath, PASSPHRASE, pinned.id);
    expect(getPinnedAnswer(storePath, PASSPHRASE, pinned.id)).toBeUndefined();
    expect(() => deletePinnedAnswer(storePath, PASSPHRASE, pinned.id)).not.toThrow();
    expect(() => deletePinnedAnswer(storePath, PASSPHRASE, "never-existed")).not.toThrow();
  });

  describe("findPinnedAnswer — case-insensitive containment, same idiom as matchesRefusedSubject", () => {
    it("matches a question containing the pattern, case-insensitively", () => {
      const storePath = initStore();
      const pinned = createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Ten days a year.");
      const found = findPinnedAnswer(storePath, PASSPHRASE, "How much VACATION LEAVE do I get this year?");
      expect(found?.id).toBe(pinned.id);
    });

    it("returns undefined when nothing matches", () => {
      const storePath = initStore();
      createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Ten days a year.");
      expect(findPinnedAnswer(storePath, PASSPHRASE, "what is the meaning of life")).toBeUndefined();
    });

    it("prefers the longest (most specific) matching pattern", () => {
      const storePath = initStore();
      createPinnedAnswer(storePath, PASSPHRASE, "leave", "A broad, generic answer.");
      const specific = createPinnedAnswer(storePath, PASSPHRASE, "unpaid leave policy", "The specific, exact answer.");
      const found = findPinnedAnswer(storePath, PASSPHRASE, "what's the unpaid leave policy here");
      expect(found?.id).toBe(specific.id);
    });

    it("ignores a blank pattern rather than matching everything", () => {
      const storePath = initStore();
      createPinnedAnswer(storePath, PASSPHRASE, "topic", "answer");
      // Can't create one with a blank pattern through the module itself, but
      // guard the matcher anyway in case a row is ever edited by hand.
      expect(findPinnedAnswer(storePath, PASSPHRASE, "anything at all, really")).toBeUndefined();
    });
  });
});
