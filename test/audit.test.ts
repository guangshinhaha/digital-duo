import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAuditEntry, appendCorrection, getAuditEntry, listAuditEntries } from "../src/permissions/audit.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    question: "what is the policy?",
    askerRef: "alice",
    askerResolved: true,
    clearanceApplied: "official_open" as const,
    recordsUsed: ["rec-1"],
    recordsExcluded: [],
    rulesUsed: [],
    confidence: "high" as const,
    declined: false,
    answerText: "the answer",
    ...overrides,
  };
}

describe("appendAuditEntry / getAuditEntry / listAuditEntries", () => {
  it("writes an entry that reads back with every field intact, creating the schema on demand", () => {
    const storePath = initStore();
    const id = appendAuditEntry(storePath, PASSPHRASE, baseEntry());
    const entry = getAuditEntry(storePath, PASSPHRASE, id);

    expect(entry?.id).toBe(id);
    expect(typeof entry?.createdAt).toBe("string");
    expect(entry).toMatchObject({ ...baseEntry(), correctsEntryId: null });
  });

  it("gives every entry a distinct id, even for identical-looking input", () => {
    const storePath = initStore();
    const first = appendAuditEntry(storePath, PASSPHRASE, baseEntry());
    const second = appendAuditEntry(storePath, PASSPHRASE, baseEntry());
    expect(first).not.toBe(second);
    expect(listAuditEntries(storePath, PASSPHRASE)).toHaveLength(2);
  });

  it("returns undefined for an id that was never written", () => {
    const storePath = initStore();
    expect(getAuditEntry(storePath, PASSPHRASE, "nope")).toBeUndefined();
  });

  it("lists every entry, oldest first", () => {
    const storePath = initStore();
    const first = appendAuditEntry(storePath, PASSPHRASE, baseEntry({ question: "first" }));
    const second = appendAuditEntry(storePath, PASSPHRASE, baseEntry({ question: "second" }));
    expect(listAuditEntries(storePath, PASSPHRASE).map((e) => e.id)).toEqual([first, second]);
  });

  it("logs a declined answer with every field a given one has (#51 AC3, carried from #50)", () => {
    const storePath = initStore();
    const id = appendAuditEntry(
      storePath,
      PASSPHRASE,
      baseEntry({ declined: true, answerText: "I don't have anything I can share with you on that.", confidence: "low" }),
    );
    const entry = getAuditEntry(storePath, PASSPHRASE, id);
    expect(entry?.declined).toBe(true);
    expect(entry?.confidence).toBe("low");
    expect(entry?.answerText).toBe("I don't have anything I can share with you on that.");
  });
});

describe("append-only (#51 AC2): the log cannot be edited through the product", () => {
  it("offers no update or delete function anywhere in the module — there is no surface to edit through", async () => {
    const auditModule = await import("../src/permissions/audit.js");
    const exportNames = Object.keys(auditModule);
    expect(exportNames.some((name) => /update|delete|remove|edit|patch|modify/i.test(name))).toBe(false);
  });

  it("refuses an UPDATE at the database level too, even bypassing this module's own functions", () => {
    const storePath = initStore();
    const id = appendAuditEntry(storePath, PASSPHRASE, baseEntry());

    expect(() =>
      withDatabase(storePath, PASSPHRASE, true, (db) => {
        db.prepare(`UPDATE audit_log SET answer_text = 'tampered' WHERE id = ?`).run(id);
      }),
    ).toThrow();

    // Unchanged: the attempted write never took effect.
    expect(getAuditEntry(storePath, PASSPHRASE, id)?.answerText).toBe("the answer");
  });

  it("refuses a DELETE at the database level too", () => {
    const storePath = initStore();
    const id = appendAuditEntry(storePath, PASSPHRASE, baseEntry());

    expect(() =>
      withDatabase(storePath, PASSPHRASE, true, (db) => {
        db.prepare(`DELETE FROM audit_log WHERE id = ?`).run(id);
      }),
    ).toThrow();

    expect(getAuditEntry(storePath, PASSPHRASE, id)).toBeDefined();
  });

  it("records a correction as a brand-new entry that references the original, leaving the original exactly as written", () => {
    const storePath = initStore();
    const originalId = appendAuditEntry(storePath, PASSPHRASE, baseEntry({ answerText: "the original answer" }));

    const correctionId = appendCorrection(
      storePath,
      PASSPHRASE,
      originalId,
      baseEntry({ answerText: "the corrected answer" }),
    );

    expect(correctionId).not.toBe(originalId);
    const original = getAuditEntry(storePath, PASSPHRASE, originalId);
    const correction = getAuditEntry(storePath, PASSPHRASE, correctionId);

    expect(original?.answerText).toBe("the original answer"); // untouched
    expect(correction?.answerText).toBe("the corrected answer");
    expect(correction?.correctsEntryId).toBe(originalId);
    expect(listAuditEntries(storePath, PASSPHRASE)).toHaveLength(2); // appended, not replaced
  });
});
