import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { excludeSource, listExcludedSources, listSourceControls, restoreSource } from "../src/drafting/source-exclusions.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "claude-export",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

describe("source-exclusions — duo#278: turning a whole source off from Privacy settings", () => {
  it("excludes a source, then listExcludedSources reports it", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "a", source: "claude-export" })]);

    expect(withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedSources(db)).size).toBe(0);

    excludeSource(storePath, PASSPHRASE, "claude-export");

    const excluded = withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedSources(db));
    expect(excluded.has("claude-export")).toBe(true);
  });

  it("is idempotent: excluding an already-excluded source keeps the original excludedAt", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "a", source: "paste" })]);

    excludeSource(storePath, PASSPHRASE, "paste");
    const first = listSourceControls(storePath, PASSPHRASE).find((row) => row.source === "paste")!;

    excludeSource(storePath, PASSPHRASE, "paste");
    const second = listSourceControls(storePath, PASSPHRASE).find((row) => row.source === "paste")!;
    expect(second.excludedAt).toBe(first.excludedAt);
  });

  it("restoreSource reverses an exclusion, and restoring something never excluded is a no-op", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record({ text: "a", source: "connector" })]);

    excludeSource(storePath, PASSPHRASE, "connector");
    expect(withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedSources(db)).has("connector")).toBe(true);

    restoreSource(storePath, PASSPHRASE, "connector");
    expect(withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedSources(db)).has("connector")).toBe(false);

    expect(() => restoreSource(storePath, PASSPHRASE, "connector")).not.toThrow();
    expect(() => restoreSource(storePath, PASSPHRASE, "never-excluded-source")).not.toThrow();
  });

  it("listSourceControls lists every source with a record count, excluded sources first", () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record({ text: "a", source: "claude-export" }),
      record({ text: "b", source: "claude-export" }),
      record({ text: "c", source: "paste" }),
    ]);

    excludeSource(storePath, PASSPHRASE, "paste");

    const controls = listSourceControls(storePath, PASSPHRASE);
    expect(controls).toEqual([
      { source: "paste", recordCount: 1, excluded: true, excludedAt: expect.any(String) },
      { source: "claude-export", recordCount: 2, excluded: false, excludedAt: null },
    ]);
  });

  it("keeps an excluded source listed, with a zero record count, once its only record is gone", () => {
    const storePath = initStore();
    const only = record({ text: "a", source: "connector" });
    writeRecords(storePath, PASSPHRASE, [only]);
    excludeSource(storePath, PASSPHRASE, "connector");

    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.exec(`DELETE FROM records WHERE id = '${only.id}'`);
    });

    const controls = listSourceControls(storePath, PASSPHRASE);
    expect(controls).toEqual([{ source: "connector", recordCount: 0, excluded: true, excludedAt: expect.any(String) }]);
  });
});
