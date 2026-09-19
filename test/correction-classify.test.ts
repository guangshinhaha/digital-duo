import { describe, expect, it } from "vitest";
import {
  classifyEdit,
  defaultEditClassifier,
  isTrivialEdit,
  NoDraftTextError,
} from "../src/corrections/classify.js";

describe("isTrivialEdit (#37: a one-character or whitespace change produces nothing)", () => {
  it("treats a pure whitespace difference as trivial", () => {
    expect(isTrivialEdit("Yes, that's correct.", "Yes,  that's correct.")).toBe(true);
    expect(isTrivialEdit("Yes, that's correct.\n", "Yes, that's correct.")).toBe(true);
  });

  it("treats a single dropped/changed character as trivial", () => {
    expect(isTrivialEdit("Yes, that's correct.", "Yes, that's correct")).toBe(true);
    expect(isTrivialEdit("Its fine", "It's fine")).toBe(true);
  });

  it("does not treat a real (even short) wording change as trivial", () => {
    expect(isTrivialEdit("Yes", "No")).toBe(false);
  });
});

describe("defaultEditClassifier (#37 AC1/AC2/AC3)", () => {
  it("classifies a shortened, blunter draft with no new content as style", () => {
    const result = defaultEditClassifier("when is the meeting?", "the meeting is on tuesday at 3pm in the main office", "meeting tuesday 3pm main office");
    expect(result).toBe("style");
  });

  it("classifies a draft whose actual answer changed as substance", () => {
    const result = defaultEditClassifier(
      "when is the meeting?",
      "the meeting is on tuesday at 3pm in the main office",
      "the budget review moved to thursday afternoon",
    );
    expect(result).toBe("substance");
  });

  it("classifies an edit that changes both wording and substance as both", () => {
    const result = defaultEditClassifier("when is the meeting?", "meeting tuesday 3pm main office", "meeting thursday 3pm branch office");
    expect(result).toBe("both");
  });
});

describe("classifyEdit (#37: trivial short-circuits before any classifier runs)", () => {
  it("reports trivial without ever invoking a configured classifier", async () => {
    let called = false;
    const spyClassifier = async (): Promise<"style" | "substance" | "both"> => {
      called = true;
      return "substance";
    };
    const result = await classifyEdit("q", "Yes, that's correct.", "Yes, that's correct", spyClassifier);
    expect(result.classification).toBe("trivial");
    expect(called).toBe(false);
  });

  it("uses the default deterministic classifier when none is supplied", async () => {
    const result = await classifyEdit(
      "when is the meeting?",
      "the meeting is on tuesday at 3pm in the main office",
      "meeting tuesday 3pm main office",
    );
    expect(result.classification).toBe("style");
  });

  it("uses a supplied classifier's verdict for non-trivial edits", async () => {
    const result = await classifyEdit("q", "a real draft", "a real edited sent version", async () => "both");
    expect(result.classification).toBe("both");
  });
});

describe("NoDraftTextError", () => {
  it("names the draft id", () => {
    const error = new NoDraftTextError("draft-123");
    expect(error.message).toContain("draft-123");
  });
});
