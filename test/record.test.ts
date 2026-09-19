import { describe, expect, it } from "vitest";
import { computeRecordId, createRecord, InvalidRecordError, parseRecord, stripMarkingLine, type RecordInput } from "../src/ingest/record.js";

function sampleInput(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    source: "claude-export",
    sourceRef: null,
    kind: "question_to_me",
    author: "other",
    text: "when is the leave policy changing?",
    timestamp: "2026-01-01T00:00:00.000Z",
    threadId: "thread-1",
    audience: "channel",
    ...overrides,
  };
}

describe("createRecord", () => {
  it("fills id, classification (unknown absent a marking), and topics (empty) from adapter input", () => {
    const record = createRecord(sampleInput());
    expect(record.classification).toBe("unknown");
    expect(record.topics).toEqual([]);
    expect(record.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures a classification marking off the record's first line, per level", () => {
    expect(createRecord(sampleInput({ text: "RESTRICTED\nthe rest of the message" })).classification).toBe("restricted");
    expect(createRecord(sampleInput({ text: "[CONFIDENTIAL]: budget figures below" })).classification).toBe("confidential");
    expect(createRecord(sampleInput({ text: "Official (Open): fine to share" })).classification).toBe("official_open");
    expect(createRecord(sampleInput({ text: "secret:" })).classification).toBe("secret");
  });

  it("never mistakes a colloquial mention of a level for a marking", () => {
    expect(createRecord(sampleInput({ text: "let's keep this confidential between us" })).classification).toBe("unknown");
  });

  it("is deterministic: the same input always yields the same id", () => {
    expect(computeRecordId(sampleInput())).toBe(computeRecordId(sampleInput()));
  });

  it("changes the id when the text differs", () => {
    expect(computeRecordId(sampleInput())).not.toBe(computeRecordId(sampleInput({ text: "a different question" })));
  });

  it("never lets classification or topics influence the id — they don't exist on RecordInput at all", () => {
    // Compile-time guarantee: RecordInput is IngestRecord minus id/classification/topics,
    // so there is nothing to pass here even to try. This test documents that contract.
    const a = createRecord(sampleInput());
    const b = createRecord(sampleInput());
    expect(a.id).toBe(b.id);
  });
});

describe("stripMarkingLine", () => {
  it("removes a bare marking line, leaving the message intact", () => {
    expect(stripMarkingLine({ text: "RESTRICTED\nthe actual message", classification: "restricted" })).toBe("the actual message");
  });

  it("leaves text untouched when the classification is unknown", () => {
    expect(stripMarkingLine({ text: "no marking here", classification: "unknown" })).toBe("no marking here");
  });

  it("leaves text untouched when the marking shares its line with real content (the colon case)", () => {
    const text = "Official (Open): fine to share";
    expect(stripMarkingLine({ text, classification: "official_open" })).toBe(text);
  });

  it("leaves text untouched when there's no second line to fall back to", () => {
    expect(stripMarkingLine({ text: "RESTRICTED", classification: "restricted" })).toBe("RESTRICTED");
  });
});

describe("parseRecord", () => {
  it("accepts a fully-formed record and returns it typed", () => {
    const record = createRecord(sampleInput());
    expect(parseRecord(record)).toEqual(record);
  });

  it("rejects a non-object value", () => {
    expect(() => parseRecord("not a record")).toThrow(InvalidRecordError);
  });

  it("rejects an unknown kind, naming the field", () => {
    const record = { ...createRecord(sampleInput()), kind: "bogus" };
    expect(() => parseRecord(record)).toThrow(InvalidRecordError);
    try {
      parseRecord(record);
      throw new Error("expected parseRecord to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRecordError);
      expect((error as InvalidRecordError).field).toBe("kind");
    }
  });

  it("rejects a missing required field (text), naming it", () => {
    const record = { ...createRecord(sampleInput()), text: undefined };
    expect(() => parseRecord(record)).toThrow(/text/);
  });

  it("rejects an unknown author and an unknown audience, each naming the field", () => {
    expect(() => parseRecord({ ...createRecord(sampleInput()), author: "nobody" })).toThrow(/author/);
    expect(() => parseRecord({ ...createRecord(sampleInput()), audience: "everywhere" })).toThrow(/audience/);
  });

  it("defaults topics to an empty array when absent, but validates it when present", () => {
    const withoutTopics: Record<string, unknown> = { ...createRecord(sampleInput()) };
    delete withoutTopics.topics;
    expect(parseRecord(withoutTopics).topics).toEqual([]);
    expect(() => parseRecord({ ...createRecord(sampleInput()), topics: "not-an-array" })).toThrow(/topics/);
  });
});
