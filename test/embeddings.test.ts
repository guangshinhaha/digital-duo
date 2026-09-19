import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFailingEmbeddingProvider, createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { embedRecords, hybridSearch } from "../src/ingest/embeddings.js";
import { createRecord } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function record(text: string, overrides: Partial<Parameters<typeof createRecord>[0]> = {}) {
  return createRecord({
    source: "paste",
    sourceRef: null,
    kind: "my_thinking",
    author: "me",
    text,
    timestamp: "2026-01-01T00:00:00.000Z",
    threadId: null,
    audience: "private",
    ...overrides,
  });
}

describe("embedRecords", () => {
  it("embeds every record that has no vector yet, and reports the total", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record("a"), record("b"), record("c", { threadId: "t2" })]);

    const provider = createFakeEmbeddingProvider();
    const result = await embedRecords(storePath, PASSPHRASE, provider);
    expect(result).toEqual({ embedded: 3, total: 3 });
  });

  it("is idempotent: a second call under the same model embeds nothing new", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record("a"), record("b")]);
    const provider = createFakeEmbeddingProvider();

    await embedRecords(storePath, PASSPHRASE, provider);
    const second = await embedRecords(storePath, PASSPHRASE, provider);
    expect(second).toEqual({ embedded: 0, total: 2 });
  });

  it("a model change makes every record look un-embedded again, triggering a re-embed rather than reusing stale vectors", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record("a"), record("b")]);

    const modelV1 = createFakeEmbeddingProvider("fake-embed-v1");
    await embedRecords(storePath, PASSPHRASE, modelV1);

    const modelV2 = createFakeEmbeddingProvider("fake-embed-v2");
    const afterModelChange = await embedRecords(storePath, PASSPHRASE, modelV2);
    expect(afterModelChange).toEqual({ embedded: 2, total: 2 });

    // Switching back to v1 doesn't find a v1 row anymore either — it was overwritten, not preserved.
    const backToV1 = await embedRecords(storePath, PASSPHRASE, modelV1);
    expect(backToV1).toEqual({ embedded: 2, total: 2 });
  });

  it("on an empty store, embeds nothing and reports zero total", async () => {
    const storePath = initStore();
    const result = await embedRecords(storePath, PASSPHRASE, createFakeEmbeddingProvider());
    expect(result).toEqual({ embedded: 0, total: 0 });
  });
});

describe("hybridSearch — similar questions retrieve past answers", () => {
  it("retrieves a record that shares no exact words with the query, via the embedding channel", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record("Employees get five paid vacation days per quarter.", { threadId: "leave" }),
      record("The printer on the third floor is broken again.", { threadId: "printer" }),
      record("Finalize the budget report before the deadline.", { threadId: "budget" }),
    ]);
    const provider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, provider);

    const outcome = await hybridSearch(storePath, PASSPHRASE, "What is our holiday absence policy?", provider);
    expect(outcome.usedEmbeddings).toBe(true);
    // Only the leave record has any real signal (shared FTS terms: none;
    // shared embedding group: time-off) — the printer/budget records have
    // zero similarity and zero lexical overlap, so they must not appear at
    // all, not just rank lower.
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].record.threadId).toBe("leave");
  });
});

describe("hybridSearch — zero-similarity vector matches never get a free rank boost", () => {
  it("excludes a record with no lexical overlap and no embedding-group overlap, rather than ranking it last", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [
      record("Employees get five paid vacation days per quarter.", { threadId: "leave" }),
      record("The printer on the third floor is broken again.", { threadId: "printer" }),
    ]);
    const provider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, provider);

    const outcome = await hybridSearch(storePath, PASSPHRASE, "holiday absence policy", provider);
    const threadIds = outcome.results.map((result) => result.record.threadId);
    expect(threadIds).toEqual(["leave"]);
    expect(threadIds).not.toContain("printer");
  });
});

describe("hybridSearch — degrades gracefully when the embedding service is down", () => {
  it("falls back to full-text only, says so explicitly, and still returns real full-text matches", async () => {
    const storePath = initStore();
    writeRecords(storePath, PASSPHRASE, [record("Employees get five paid vacation days per quarter.", { threadId: "leave" })]);

    const outcome = await hybridSearch(storePath, PASSPHRASE, "vacation days", createFailingEmbeddingProvider());
    expect(outcome.usedEmbeddings).toBe(false);
    expect(outcome.warning).toMatch(/full-text/i);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].record.threadId).toBe("leave");
  });
});

describe("hybridSearch — an empty corpus returns nothing rather than noise", () => {
  it("returns an empty result set with no error, embeddings available", async () => {
    const storePath = initStore();
    const outcome = await hybridSearch(storePath, PASSPHRASE, "anything", createFakeEmbeddingProvider());
    expect(outcome.results).toEqual([]);
  });

  it("returns an empty result set with no error, embeddings unavailable", async () => {
    const storePath = initStore();
    const outcome = await hybridSearch(storePath, PASSPHRASE, "anything", createFailingEmbeddingProvider());
    expect(outcome.results).toEqual([]);
    expect(outcome.usedEmbeddings).toBe(false);
  });
});
