import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendUsageEntry, InvalidUsageLogError, loadUsageLog, unresolvedQuestionGaps } from "../src/shared-duo/usage-log.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function logPath(): string {
  return join(tempDir(), "data", "shared-duo-usage.json");
}

describe("loadUsageLog", () => {
  it("returns an empty log when the file doesn't exist yet", () => {
    expect(loadUsageLog(logPath())).toEqual([]);
  });

  it("rejects a malformed (non-array) log file", () => {
    const path = logPath();
    appendUsageEntry(path, { question: "x", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: false, citedTitles: [], staleCitation: false });
    writeFileSync(path, JSON.stringify({ not: "an array" }));
    expect(() => loadUsageLog(path)).toThrow(InvalidUsageLogError);
  });

  it("normalizes a pre-#160 log (entries without asker context) to null — not recorded, not undefined", () => {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "entry-pre-160",
          createdAt: "2026-09-01T00:00:00.000Z",
          question: "old question",
          askerId: "asker-0",
          declined: true,
          citedTitles: [],
          staleCitation: false,
        },
      ]),
    );

    const entries = loadUsageLog(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].askerResolved).toBeNull();
    expect(entries[0].askLinkId).toBeNull();
    expect(entries[0].askerId).toBe("asker-0");
  });
});

describe("appendUsageEntry", () => {
  it("creates the log directory and file on first write, and reads back every field", () => {
    const path = logPath();
    const entry = appendUsageEntry(path, {
      question: "what is the leave policy?",
      askerId: "asker-1",
      declined: false,
      citedTitles: ["Leave requests"],
      staleCitation: false,
    });
    expect(entry.id).toBeTruthy();
    expect(typeof entry.createdAt).toBe("string");

    const entries = loadUsageLog(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      question: "what is the leave policy?",
      declined: false,
      citedTitles: ["Leave requests"],
      staleCitation: false,
    });
  });

  it("appends to an existing log rather than overwriting it", () => {
    const path = logPath();
    appendUsageEntry(path, { question: "first", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: false, citedTitles: [], staleCitation: false });
    appendUsageEntry(path, { question: "second", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });
    expect(loadUsageLog(path).map((e) => e.question)).toEqual(["first", "second"]);
  });
});

describe("unresolvedQuestionGaps (#69 AC4)", () => {
  it("groups the same declined question, case- and whitespace-insensitively, and counts repeats", () => {
    const path = logPath();
    appendUsageEntry(path, { question: "What is the parking policy?", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });
    appendUsageEntry(path, { question: "what is the parking policy? ", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });
    appendUsageEntry(path, { question: "WHAT IS THE PARKING POLICY?", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });

    const gaps = unresolvedQuestionGaps(loadUsageLog(path));
    expect(gaps).toEqual([{ question: "What is the parking policy?", count: 3 }]);
  });

  it("never counts an answered question as a gap", () => {
    const path = logPath();
    appendUsageEntry(path, { question: "covered question", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: false, citedTitles: ["Leave requests"], staleCitation: false });
    expect(unresolvedQuestionGaps(loadUsageLog(path))).toEqual([]);
  });

  it("sorts distinct gaps by how many times each was asked, most first", () => {
    const path = logPath();
    appendUsageEntry(path, { question: "rare gap", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });
    appendUsageEntry(path, { question: "common gap", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });
    appendUsageEntry(path, { question: "common gap", askerId: "asker-1", askerResolved: null, askLinkId: null, declined: true, citedTitles: [], staleCitation: false });

    expect(unresolvedQuestionGaps(loadUsageLog(path))).toEqual([
      { question: "common gap", count: 2 },
      { question: "rare gap", count: 1 },
    ]);
  });
});
