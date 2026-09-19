import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { retrieveForAsker } from "../src/permissions/retrieval.js";
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

function writeDirectoryFile(dir: string, contents: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "directory.json"), JSON.stringify(contents), "utf8");
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

describe("retrieveForAsker — permission-scoped retrieval (#49)", () => {
  it("only admits records within the asker's clearance into the generation context, tracing what was excluded and why", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectoryFile(dir, [{ id: "alice", name: "Alice", clearance: "official_open", groups: [] }]);

    const openRecord = record({ text: "OFFICIAL (OPEN)\neveryone gets 14 days of vacation per year" });
    const restrictedRecord = record({ text: "RESTRICTED\nsenior staff get 21 days of vacation per year" });
    writeRecords(storePath, PASSPHRASE, [openRecord, restrictedRecord]);
    const provider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, provider);

    const outcome = await retrieveForAsker(storePath, PASSPHRASE, "holiday absence policy", provider, "alice", dir);

    const contextIds = outcome.generationContext.map((r) => r.record.id);
    expect(contextIds).toContain(openRecord.id);
    expect(contextIds).not.toContain(restrictedRecord.id);

    // No ungranted record is ever loaded into the generation context.
    for (const { record: r } of outcome.generationContext) {
      expect(r.classification === "official_open" || r.classification === "unknown").toBe(true);
    }

    const excludedIds = outcome.excluded.map((e) => e.record.id);
    expect(excludedIds).toContain(restrictedRecord.id);
    expect(outcome.excluded.find((e) => e.record.id === restrictedRecord.id)?.reason).toBe("above_clearance");
    expect(outcome.asker).toEqual({
      resolved: true,
      identity: { id: "alice", name: "Alice", clearance: "official_open", groups: [] },
    });
    expect(outcome.clearance).toBe("official_open");
  });

  it("gives an unresolvable asker the same most-restrictive treatment as the lowest-clearance known asker", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectoryFile(dir, []);

    const openRecord = record({ text: "OFFICIAL (OPEN)\neveryone gets 14 days of vacation per year" });
    const restrictedRecord = record({ text: "RESTRICTED\nsenior staff get 21 days of vacation per year" });
    writeRecords(storePath, PASSPHRASE, [openRecord, restrictedRecord]);
    const provider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, provider);

    const outcome = await retrieveForAsker(storePath, PASSPHRASE, "holiday absence policy", provider, "mallory", dir);

    expect(outcome.asker).toEqual({ resolved: false, askerRef: "mallory" });
    expect(outcome.clearance).toBe("official_open");
    expect(outcome.generationContext.map((r) => r.record.id)).toContain(openRecord.id);
    expect(outcome.generationContext.map((r) => r.record.id)).not.toContain(restrictedRecord.id);
  });

  it("keeps unmarked ('unknown') material out of the generation context unless the asker holds top clearance", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectoryFile(dir, [
      { id: "low", name: "Low Clearance", clearance: "official_open", groups: [] },
      { id: "top", name: "Top Clearance", clearance: "secret", groups: [] },
    ]);

    const unmarkedRecord = record({ text: "vacation policy notes, no marking on this one" });
    writeRecords(storePath, PASSPHRASE, [unmarkedRecord]);
    const provider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, provider);

    const forLow = await retrieveForAsker(storePath, PASSPHRASE, "holiday absence policy", provider, "low", dir);
    expect(forLow.generationContext.map((r) => r.record.id)).not.toContain(unmarkedRecord.id);
    expect(forLow.excluded.find((e) => e.record.id === unmarkedRecord.id)?.reason).toBe("unknown_requires_top_clearance");

    const forTop = await retrieveForAsker(storePath, PASSPHRASE, "holiday absence policy", provider, "top", dir);
    expect(forTop.generationContext.map((r) => r.record.id)).toContain(unmarkedRecord.id);
  });

  it("resolves the asker before retrieval runs — an empty corpus still resolves cleanly and returns no results", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeDirectoryFile(dir, [{ id: "alice", name: "Alice", clearance: "restricted", groups: [] }]);

    const outcome = await retrieveForAsker(storePath, PASSPHRASE, "anything", createFakeEmbeddingProvider(), "alice", dir);
    expect(outcome.asker).toEqual({ resolved: true, identity: { id: "alice", name: "Alice", clearance: "restricted", groups: [] } });
    expect(outcome.generationContext).toEqual([]);
    expect(outcome.excluded).toEqual([]);
  });
});
