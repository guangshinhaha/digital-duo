import { describe, expect, it } from "vitest";
import { CorpusTooShortError, splitCorpusByTime } from "../src/eval/time-split.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string; timestamp: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_thinking",
    author: "me",
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

describe("splitCorpusByTime — the boundary is applied before anything else runs", () => {
  it("splits into train (strictly before cutoff) and held-out (at or after cutoff)", () => {
    // Span: 2026-01-01 to 2026-02-20 is 50 days; holdout 30 days puts the
    // cutoff exactly at 2026-01-21.
    const records = [
      record({ text: "before cutoff", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ text: "exactly at cutoff", timestamp: "2026-01-21T00:00:00.000Z" }),
      record({ text: "after cutoff", timestamp: "2026-02-01T00:00:00.000Z" }),
      record({ text: "the corpus's latest record", timestamp: "2026-02-20T00:00:00.000Z" }),
    ];
    const result = splitCorpusByTime(records, 30);

    expect(result.cutoff).toBe("2026-01-21T00:00:00.000Z");
    expect(result.holdoutDays).toBe(30);
    expect(result.corpusSpanDays).toBeCloseTo(50, 5);
    expect(result.trainRecords.map((r) => r.text)).toEqual(["before cutoff"]);
    // The boundary is inclusive on the held-out side: a record timestamped
    // exactly at the cutoff must never leak into the train split.
    expect(result.heldOutRecords.map((r) => r.text)).toEqual(["exactly at cutoff", "after cutoff", "the corpus's latest record"]);
  });

  it("is a pure function of the corpus's own span, not of when it happens to run", () => {
    const records = [
      record({ text: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ text: "b", timestamp: "2026-03-01T00:00:00.000Z" }),
    ];
    const first = splitCorpusByTime(records, 42);
    const second = splitCorpusByTime(records, 42);
    expect(first).toEqual(second);
  });

  it("refuses a corpus shorter than the holdout window, naming the span found and needed", () => {
    const records = [
      record({ text: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ text: "b", timestamp: "2026-01-05T00:00:00.000Z" }),
    ];
    expect(() => splitCorpusByTime(records, 42)).toThrow(CorpusTooShortError);
    try {
      splitCorpusByTime(records, 42);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CorpusTooShortError);
      const typed = error as CorpusTooShortError;
      expect(typed.corpusSpanDays).toBeCloseTo(4, 5);
      expect(typed.holdoutDaysNeeded).toBe(42);
      expect(typed.message).toMatch(/4\.0 day/);
      expect(typed.message).toMatch(/42 day/);
    }
  });

  it("refuses an empty corpus rather than dividing by nothing", () => {
    expect(() => splitCorpusByTime([], 42)).toThrow(CorpusTooShortError);
  });

  it("treats an unparseable timestamp as train, never as held-out", () => {
    const records = [
      record({ text: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ text: "b", timestamp: "2026-03-01T00:00:00.000Z" }),
      record({ text: "garbage timestamp", timestamp: "not-a-real-date" }),
    ];
    const result = splitCorpusByTime(records, 10);
    expect(result.trainRecords.map((r) => r.text)).toContain("garbage timestamp");
    expect(result.heldOutRecords.map((r) => r.text)).not.toContain("garbage timestamp");
  });
});
