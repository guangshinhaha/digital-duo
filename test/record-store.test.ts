import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidRecordError } from "../src/ingest/record.js";
import { countRecords, getRecord, searchRecords, writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, StoreNotInitializedError } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "rec-1",
    source: "claude-export",
    sourceRef: null,
    kind: "question_to_me",
    author: "other",
    text: "when does the leave policy change?",
    timestamp: "2026-01-01T00:00:00.000Z",
    threadId: "thread-1",
    audience: "channel",
    classification: null,
    topics: [],
    ...overrides,
  };
}

describe("records operations require an initialized store", () => {
  it("refuses to write, read, count, or search when no store exists at the path", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    expect(() => writeRecords(storePath, PASSPHRASE, [record()])).toThrow(StoreNotInitializedError);
    expect(() => getRecord(storePath, PASSPHRASE, "rec-1")).toThrow(StoreNotInitializedError);
    expect(() => countRecords(storePath, PASSPHRASE)).toThrow(StoreNotInitializedError);
    expect(() => searchRecords(storePath, PASSPHRASE, "anything")).toThrow(StoreNotInitializedError);
  });
});

describe("writeRecords / getRecord — records are stored and retrievable", () => {
  it("writes a batch and retrieves each by id with every field intact, including classification as unset", () => {
    const storePath = initStore();
    const written = writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" }), record({ id: "rec-2", text: "a second question" })]);
    expect(written).toEqual({ written: 2, skipped: 0 });

    const fetched = getRecord(storePath, PASSPHRASE, "rec-1");
    expect(fetched).toEqual(record({ id: "rec-1" }));
    expect(fetched?.classification).toBeNull();
  });

  it("returns undefined for an id that was never written", () => {
    const storePath = initStore();
    expect(getRecord(storePath, PASSPHRASE, "nope")).toBeUndefined();
  });
});

describe("writeRecords — an invalid record is rejected at the boundary", () => {
  it("refuses a record with an unknown kind, naming the field, and commits nothing from the batch", () => {
    const storePath = initStore();
    expect(() => writeRecords(storePath, PASSPHRASE, [record({ id: "good" }), record({ id: "bad", kind: "not-a-kind" })])).toThrow(
      InvalidRecordError,
    );
    expect(countRecords(storePath, PASSPHRASE)).toBe(0);
  });

  it("refuses a record missing a required field, naming it, and commits nothing from the batch", () => {
    const storePath = initStore();
    const missingText = record({ id: "bad" });
    delete missingText.text;
    expect(() => writeRecords(storePath, PASSPHRASE, [record({ id: "good" }), missingText])).toThrow(/text/);
    expect(countRecords(storePath, PASSPHRASE)).toBe(0);
  });
});

describe("writeRecords — re-import does not duplicate", () => {
  it("importing the identical record twice leaves the count unchanged", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" })]);
    const second = writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" })]);
    expect(second).toEqual({ written: 0, skipped: 1 });
    expect(countRecords(storePath, PASSPHRASE)).toBe(1);
  });

  it("a mixed batch of one new and one already-imported record reports each correctly", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" })]);
    const result = writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" }), record({ id: "rec-2" })]);
    expect(result).toEqual({ written: 1, skipped: 1 });
    expect(countRecords(storePath, PASSPHRASE)).toBe(2);
  });
});

describe("searchRecords — FTS5 index over text, ranked", () => {
  it("returns matching records ranked, best match first", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record({ id: "rec-1", text: "the leave policy changes every January" }),
      record({ id: "rec-2", text: "unrelated: the printer on the third floor is broken" }),
      record({ id: "rec-3", text: "leave policy leave policy, ask about leave policy specifically" }),
    ]);

    const results = searchRecords(storePath, PASSPHRASE, "leave policy");
    const ids = results.map((r) => r.record.id);
    expect(ids).toContain("rec-1");
    expect(ids).toContain("rec-3");
    expect(ids).not.toContain("rec-2");
    // rec-3 repeats the matched terms far more densely, so bm25 ranks it first.
    expect(ids[0]).toBe("rec-3");
  });

  it("returns an empty array, not an error, when nothing matches", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1", text: "the leave policy changes every January" })]);
    expect(searchRecords(storePath, PASSPHRASE, "nonexistent-term-xyz")).toEqual([]);
  });

  it("never throws on a query containing FTS5 syntax characters (hyphens, quotes, colons)", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1", text: "the leave policy changes every January" })]);
    for (const query of ['nonexistent-term-xyz', '"quoted" phrase', "col: value", "-excluded", ""]) {
      expect(() => searchRecords(storePath, PASSPHRASE, query)).not.toThrow();
    }
  });

  it("returns an empty result set, with no error and no fabricated matches, for an empty store", () => {
    const storePath = initStore();
    expect(searchRecords(storePath, PASSPHRASE, "anything")).toEqual([]);
  });
});
