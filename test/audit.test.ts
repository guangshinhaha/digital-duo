import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAuditEntry } from "../src/permissions/audit.js";
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
    declined: false,
    answerText: "the answer",
    ...overrides,
  };
}

describe("appendAuditEntry", () => {
  it("writes a retrievable row, creating the schema on demand", () => {
    const storePath = initStore();
    const id = appendAuditEntry(storePath, PASSPHRASE, baseEntry());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const rows = withDatabase(storePath, PASSPHRASE, false, (db) => db.prepare(`SELECT * FROM audit_log`).all());
    expect(rows).toHaveLength(1);
  });

  it("gives every entry a distinct id, even for identical-looking input", () => {
    const storePath = initStore();
    const first = appendAuditEntry(storePath, PASSPHRASE, baseEntry());
    const second = appendAuditEntry(storePath, PASSPHRASE, baseEntry());
    expect(first).not.toBe(second);

    const rows = withDatabase(storePath, PASSPHRASE, false, (db) => db.prepare(`SELECT * FROM audit_log`).all());
    expect(rows).toHaveLength(2);
  });

  it("offers no update or delete surface — the module exports only append, by construction", async () => {
    const auditModule = await import("../src/permissions/audit.js");
    const exportNames = Object.keys(auditModule);
    expect(exportNames.some((name) => /update|delete|remove|edit|patch/i.test(name))).toBe(false);
  });
});
