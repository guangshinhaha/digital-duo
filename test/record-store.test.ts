import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidRecordError } from "../src/ingest/record.js";
import {
  countRecords,
  getRecord,
  InvalidRecordEditError,
  listRecordsPage,
  RecordNotFoundError,
  searchRecords,
  updateRecordText,
  writeRecords,
} from "../src/ingest/record-store.js";
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
    classification: "unknown",
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
  it("writes a batch and retrieves each by id with every field intact, including classification as unknown", () => {
    const storePath = initStore();
    const written = writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" }), record({ id: "rec-2", text: "a second question" })]);
    expect(written).toEqual({ written: 2, skipped: 0 });

    const fetched = getRecord(storePath, PASSPHRASE, "rec-1");
    expect(fetched).toEqual(record({ id: "rec-1" }));
    expect(fetched?.classification).toBe("unknown");
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

describe("updateRecordText — digital-duo#286, correcting a record's stored text in place", () => {
  it("edits the text, stamps editedAt, and leaves every other field untouched", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1", text: "five days per quarter" })]);

    const edited = updateRecordText(storePath, PASSPHRASE, "rec-1", "ten days per quarter");
    expect(edited.text).toBe("ten days per quarter");
    expect(edited.editedAt).toEqual(expect.any(String));
    expect(edited.id).toBe("rec-1");
    expect(edited.source).toBe("claude-export");

    // The edit is durable: a fresh read sees it too, not just the mutation's own return value.
    expect(getRecord(storePath, PASSPHRASE, "rec-1")?.text).toBe("ten days per quarter");
  });

  it("trims whitespace and refuses to edit a record down to nothing", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" })]);
    expect(() => updateRecordText(storePath, PASSPHRASE, "rec-1", "   ")).toThrow(InvalidRecordEditError);
    expect(getRecord(storePath, PASSPHRASE, "rec-1")?.text).toBe("when does the leave policy change?");
  });

  it("refuses to edit a record id that doesn't exist", () => {
    const storePath = initStore();
    expect(() => updateRecordText(storePath, PASSPHRASE, "no-such-id", "new text")).toThrow(RecordNotFoundError);
  });

  it("keeps the FTS5 index in step: search finds the edited text, not the old wording", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1", text: "the printer is broken" })]);
    updateRecordText(storePath, PASSPHRASE, "rec-1", "the leave policy changes every January");

    expect(searchRecords(storePath, PASSPHRASE, "leave policy").map((r) => r.record.id)).toContain("rec-1");
    expect(searchRecords(storePath, PASSPHRASE, "printer")).toEqual([]);
  });

  it("leaves classification exactly as ingest detected it — an edit never re-runs classification detection", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1", text: "Restricted: see below", classification: "restricted" })]);
    const edited = updateRecordText(storePath, PASSPHRASE, "rec-1", "Secret: a completely different sentence now");
    expect(edited.classification).toBe("restricted");
  });
});

describe("listRecordsPage — digital-duo#286, the Knows tab's paginated browse", () => {
  it("pages newest-first, honouring limit and cursor", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record({ id: "rec-1", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ id: "rec-2", timestamp: "2026-01-02T00:00:00.000Z" }),
      record({ id: "rec-3", timestamp: "2026-01-03T00:00:00.000Z" }),
    ]);

    const first = listRecordsPage(storePath, PASSPHRASE, { limit: 2 });
    expect(first.records.map((r) => r.id)).toEqual(["rec-3", "rec-2"]);
    expect(first.nextCursor).toBe(2);

    const second = listRecordsPage(storePath, PASSPHRASE, { limit: 2, cursor: first.nextCursor! });
    expect(second.records.map((r) => r.id)).toEqual(["rec-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by source", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record({ id: "rec-1", source: "claude-export" }),
      record({ id: "rec-2", source: "paste" }),
    ]);
    const page = listRecordsPage(storePath, PASSPHRASE, { source: "paste" });
    expect(page.records.map((r) => r.id)).toEqual(["rec-2"]);
  });

  it("filters by full-text q, combined with source", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record({ id: "rec-1", source: "claude-export", text: "the leave policy changes every January" }),
      record({ id: "rec-2", source: "paste", text: "the leave policy is five days" }),
      record({ id: "rec-3", source: "paste", text: "unrelated printer talk" }),
    ]);
    const page = listRecordsPage(storePath, PASSPHRASE, { q: "leave policy", source: "paste" });
    expect(page.records.map((r) => r.id)).toEqual(["rec-2"]);
  });

  it("returns an empty page, not an error, for a fresh store", () => {
    const storePath = initStore();
    expect(listRecordsPage(storePath, PASSPHRASE)).toEqual({ records: [], nextCursor: null });
  });

  it("every row carries editedAt — null for a record no edit has touched", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-1" })]);
    updateRecordText(storePath, PASSPHRASE, "rec-1", "edited text");
    writeRecords(storePath, PASSPHRASE, [record({ id: "rec-2" })]);

    const page = listRecordsPage(storePath, PASSPHRASE);
    const byId = new Map(page.records.map((r) => [r.id, r.editedAt]));
    expect(byId.get("rec-1")).toEqual(expect.any(String));
    expect(byId.get("rec-2")).toBeNull();
  });
});
