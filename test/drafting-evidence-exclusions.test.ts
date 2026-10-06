import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { excludeEvidence, listExcludedEvidence, listExcludedEvidenceIds, restoreEvidence } from "../src/drafting/evidence-exclusions.js";
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
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

describe("evidence-exclusions — duo#272: removing a bad 'past exchange' from the Why panel", () => {
  it("excludes a record, then listExcludedEvidenceIds reports it", () => {
    const storePath = initStore();
    const answer = record({ text: "five days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);

    expect(withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedEvidenceIds(db)).size).toBe(0);

    excludeEvidence(storePath, PASSPHRASE, answer.id);

    const ids = withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedEvidenceIds(db));
    expect(ids.has(answer.id)).toBe(true);
  });

  it("is idempotent: excluding an already-excluded record keeps the original excludedAt", () => {
    const storePath = initStore();
    const answer = record({ text: "five days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);

    excludeEvidence(storePath, PASSPHRASE, answer.id);
    const first = listExcludedEvidence(storePath, PASSPHRASE);
    expect(first).toHaveLength(1);

    excludeEvidence(storePath, PASSPHRASE, answer.id);
    const second = listExcludedEvidence(storePath, PASSPHRASE);
    expect(second).toHaveLength(1);
    expect(second[0]!.excludedAt).toBe(first[0]!.excludedAt);
  });

  it("restoreEvidence reverses an exclusion, and restoring something never excluded is a no-op", () => {
    const storePath = initStore();
    const answer = record({ text: "five days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);

    excludeEvidence(storePath, PASSPHRASE, answer.id);
    expect(withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedEvidenceIds(db)).has(answer.id)).toBe(true);

    restoreEvidence(storePath, PASSPHRASE, answer.id);
    expect(withDatabase(storePath, PASSPHRASE, false, (db) => listExcludedEvidenceIds(db)).has(answer.id)).toBe(false);

    // restoring again — never excluded, or already restored — does not throw
    expect(() => restoreEvidence(storePath, PASSPHRASE, answer.id)).not.toThrow();
    expect(() => restoreEvidence(storePath, PASSPHRASE, "never-excluded-id")).not.toThrow();
  });

  it("listExcludedEvidence carries the record's own truncated text as a label, newest exclusion first", () => {
    const storePath = initStore();
    const first = record({ text: "the printer on the third floor is broken, a hardware issue" });
    const second = record({ text: "x".repeat(200) });
    writeRecords(storePath, PASSPHRASE, [first, second]);

    excludeEvidence(storePath, PASSPHRASE, first.id);
    excludeEvidence(storePath, PASSPHRASE, second.id);

    const excluded = listExcludedEvidence(storePath, PASSPHRASE);
    expect(excluded).toHaveLength(2);
    // newest (second) first
    expect(excluded[0]!.recordId).toBe(second.id);
    expect(excluded[0]!.label).toHaveLength(80);
    expect(excluded[0]!.label!.endsWith("…")).toBe(true);
    expect(excluded[1]!.recordId).toBe(first.id);
    expect(excluded[1]!.label).toBe(first.text);
  });

  it("keeps the exclusion, with an honest null label, once the record itself is gone", () => {
    const storePath = initStore();
    const answer = record({ text: "a fact that will be deleted" });
    writeRecords(storePath, PASSPHRASE, [answer]);
    excludeEvidence(storePath, PASSPHRASE, answer.id);

    // The record itself is never touched by exclusion (duo#272: the corpus
    // copy stays, searchable and importable) — this models it having been
    // separately deleted, or an exclusion for an id never seen in this
    // store at all (the same honest-null the module's own doc comment
    // describes).
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.exec(`DELETE FROM records WHERE id = '${answer.id}'`);
    });

    const excluded = listExcludedEvidence(storePath, PASSPHRASE);
    expect(excluded).toEqual([{ recordId: answer.id, excludedAt: excluded[0]!.excludedAt, label: null }]);
  });
});
