import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeProvider } from "./fixtures/fake-provider.js";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { answerForAsker, DECLINE_MESSAGE } from "../src/permissions/answer.js";
import { getAuditEntry, listAuditEntries } from "../src/permissions/audit.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

function writeDirectory(dir: string, entries: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "directory.json"), JSON.stringify(entries), "utf8");
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

describe("answerForAsker — the same question, different askers, different answers (#50 AC1)", () => {
  it("gives each asker an answer drawn only from material they may see, and logs both independently", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [
      { id: "junior", name: "Junior", clearance: "official_open" },
      { id: "senior", name: "Senior", clearance: "confidential" },
    ]);

    const openRecord = record({ text: "OFFICIAL (OPEN)\nstandard leave is 14 days of vacation per year" });
    const restrictedRecord = record({ text: "CONFIDENTIAL\nsenior staff get 21 days of vacation per year" });
    writeRecords(storePath, PASSPHRASE, [openRecord, restrictedRecord]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const juniorResult = await answerForAsker(storePath, PASSPHRASE, dir, "holiday absence policy", "junior", embeddingProvider);
    const seniorResult = await answerForAsker(storePath, PASSPHRASE, dir, "holiday absence policy", "senior", embeddingProvider);

    expect(juniorResult.answer).toContain("standard leave is 14 days");
    expect(juniorResult.answer).not.toContain("21 days");
    expect(seniorResult.answer).toContain("21 days");

    // Neither answer is told what the other received.
    expect(juniorResult.answer).not.toBe(seniorResult.answer);
    expect(juniorResult.auditEntryId).not.toBe(seniorResult.auditEntryId);

    expect(listAuditEntries(storePath, PASSPHRASE)).toHaveLength(2);
  });
});

describe("answerForAsker — a restricted question is declined without leaking (#50 AC2)", () => {
  it("declines identically whether nothing matched at all or everything that matched was excluded", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [{ id: "low", name: "Low", clearance: "official_open" }]);

    const restrictedRecord = record({ text: "SECRET\nthe reorg announcement date is the 3rd" });
    writeRecords(storePath, PASSPHRASE, [restrictedRecord]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    // Everything that matched was excluded.
    const excludedCase = await answerForAsker(storePath, PASSPHRASE, dir, "budget deadline invoice", "low", embeddingProvider);
    // Nothing matched at all.
    const nothingCase = await answerForAsker(storePath, PASSPHRASE, dir, "completely unrelated topic", "low", embeddingProvider);

    expect(excludedCase.answer).toBe(DECLINE_MESSAGE);
    expect(excludedCase.declined).toBe(true);
    expect(nothingCase.answer).toBe(DECLINE_MESSAGE);
    expect(nothingCase.declined).toBe(true);
    // Byte-identical: the asker cannot tell "there was something restricted" from "there was nothing".
    expect(excludedCase.answer).toBe(nothingCase.answer);
  });

  it("falls back to the visible records' own text when no inference provider is configured", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [{ id: "asker", name: "Asker", clearance: "confidential" }]);

    const visibleRecord = record({ text: "CONFIDENTIAL\nbudget deadline is the end of the quarter" });
    writeRecords(storePath, PASSPHRASE, [visibleRecord]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const result = await answerForAsker(storePath, PASSPHRASE, dir, "budget deadline invoice", "asker", embeddingProvider);
    expect(result.declined).toBe(false);
    expect(result.answer).toContain("budget deadline is the end of the quarter");
  });

  it("uses the configured inference provider when one is given, over the visible records only", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [{ id: "asker", name: "Asker", clearance: "confidential" }]);

    const visibleRecord = record({ text: "CONFIDENTIAL\nbudget deadline is the end of the quarter" });
    writeRecords(storePath, PASSPHRASE, [visibleRecord]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const result = await answerForAsker(storePath, PASSPHRASE, dir, "budget deadline invoice", "asker", embeddingProvider, fakeProvider);
    expect(result.answer).toMatch(/^fake-response:/);
    expect(result.answer).toContain("budget deadline is the end of the quarter");
  });
});

describe("answerForAsker — every answer records the policy path that produced it (#50 AC3)", () => {
  it("logs the asker, clearance applied, and which records were excluded and why", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [{ id: "low", name: "Low", clearance: "official_open" }]);

    const openRecord = record({ text: "OFFICIAL (OPEN)\nbudget deadline is public knowledge" });
    const restrictedRecord = record({ text: "SECRET\nbudget deadline overrun is not public" });
    writeRecords(storePath, PASSPHRASE, [openRecord, restrictedRecord]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const result = await answerForAsker(storePath, PASSPHRASE, dir, "budget deadline invoice", "low", embeddingProvider);
    const entry = getAuditEntry(storePath, PASSPHRASE, result.auditEntryId);

    expect(entry).toBeDefined();
    expect(entry?.askerRef).toBe("low");
    expect(entry?.clearanceApplied).toBe("official_open");
    expect(entry?.recordsUsed).toEqual([openRecord.id]);
    expect(entry?.recordsExcluded).toEqual([{ id: restrictedRecord.id, classification: "secret", reason: "above_clearance" }]);
    expect(entry?.declined).toBe(false);
    expect(entry?.confidence).toBe("high");
    expect(entry?.rulesUsed).toEqual([]);
  });

  it("logs a declined answer as fully as a given one, with confidence 'low'", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [{ id: "low", name: "Low", clearance: "official_open" }]);

    const result = await answerForAsker(storePath, PASSPHRASE, dir, "anything at all", "low", createFakeEmbeddingProvider());
    const entry = getAuditEntry(storePath, PASSPHRASE, result.auditEntryId);

    expect(entry?.declined).toBe(true);
    expect(entry?.answerText).toBe(DECLINE_MESSAGE);
    expect(entry?.confidence).toBe("low");
  });

  it("survives a rules change or re-derivation untouched (#51 AC: append-only) — audit_log is a separate table the derive pipeline never touches", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectory(dir, [{ id: "low", name: "Low", clearance: "official_open" }]);

    const result = await answerForAsker(storePath, PASSPHRASE, dir, "anything at all", "low", createFakeEmbeddingProvider());

    const { runPairExtraction } = await import("../src/derivation/qa-pairs.js");
    await runPairExtraction(storePath, PASSPHRASE);

    expect(getAuditEntry(storePath, PASSPHRASE, result.auditEntryId)).toBeDefined();
    expect(getAuditEntry(storePath, PASSPHRASE, result.auditEntryId)?.answerText).toBe(DECLINE_MESSAGE);
  });
});
