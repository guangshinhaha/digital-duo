import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MalformedTranscriptError, parsePastedTranscript } from "../src/ingest/adapters/paste.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("parsePastedTranscript — produces the same record shape as the Claude export adapter", () => {
  it("splits Human:/Assistant: lines into records with kind my_thinking and matching authors", () => {
    const result = parsePastedTranscript(fixture("transcript-work.txt"));
    expect(result.workRelevant).toBe(true);
    expect(result.records).toHaveLength(3);

    expect(result.records[0].author).toBe("me");
    expect(result.records[1].author).toBe("assistant");
    expect(result.records[2].author).toBe("me");
    expect(result.records.every((record) => record.kind === "my_thinking")).toBe(true);
    expect(result.records.every((record) => record.source === "paste")).toBe(true);
    expect(result.records.every((record) => record.audience === "private")).toBe(true);

    // All turns from one pasted transcript are one thread.
    const threadIds = new Set(result.records.map((record) => record.threadId));
    expect(threadIds.size).toBe(1);
  });

  it("folds a continuation line with no marker into the previous turn", () => {
    const result = parsePastedTranscript(fixture("transcript-work.txt"));
    expect(result.records[1].text).toContain("incident timeline first");
    expect(result.records[1].text).toContain("manager review before the deadline");
  });

  it("is not work-relevant for a personal transcript and produces no records", () => {
    const result = parsePastedTranscript(fixture("transcript-personal.txt"));
    expect(result.workRelevant).toBe(false);
    expect(result.records).toEqual([]);
  });

  it("refuses text with no recognisable turn, naming the expected format", () => {
    expect(() => parsePastedTranscript("just some prose with no speaker markers at all")).toThrow(MalformedTranscriptError);
    expect(() => parsePastedTranscript("just some prose with no speaker markers at all")).toThrow(/Human/);
  });
});
