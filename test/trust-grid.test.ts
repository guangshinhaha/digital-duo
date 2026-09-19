import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTONOMY_LEVELS,
  TRUST_TIERS,
  ensureTrustSchema,
  getCellRow,
  listGrid,
  resolveAutonomy,
  upsertCellRow,
  type TrustCell,
} from "../src/trust/grid.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { readTopicsFile, runTopicAssignment, writeTopicsFile } from "../src/derivation/topics.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";

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

function grantedCell(topicId: string, tier: (typeof TRUST_TIERS)[number], level: (typeof AUTONOMY_LEVELS)[number] = "auto"): TrustCell {
  return {
    topicId,
    tier,
    level,
    source: "granted",
    cleanStreak: 0,
    lastOfferStreak: null,
    lastOfferStatus: null,
    demotionAnnounced: true,
    updatedAt: new Date().toISOString(),
  };
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: `ref-${counter}`,
    kind: "my_thinking",
    author: "other",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

async function seedTopic(storePath: string, dir: string, questionText: string): Promise<string> {
  const question = record({ kind: "question_to_me", author: "other", text: questionText });
  const answer = record({ kind: "my_answer", author: "me", text: "answered", threadId: question.threadId });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs);
  const result = await runTopicAssignment(storePath, PASSPHRASE, dir, createFakeEmbeddingProvider());
  return result.newTopics[0]?.id ?? result.matchedTopicIds[0];
}

describe("resolveAutonomy — a grant is scoped to one cell (#52 AC1)", () => {
  it("does not apply a topic's grant to a different topic, or a tier's grant to a different tier", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [
      { id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-b", label: "Topic B", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensureTrustSchema(db);
      upsertCellRow(db, grantedCell("topic-a", "T0"));
    });

    expect(resolveAutonomy(storePath, PASSPHRASE, dir, "topic-a", "T0")).toEqual({ level: "auto", stale: false });
    // Different topic, same tier: ungranted, behaves at its own (default) level.
    expect(resolveAutonomy(storePath, PASSPHRASE, dir, "topic-b", "T0")).toEqual({ level: "ask", stale: false });
    // Same topic, different tier: also ungranted.
    expect(resolveAutonomy(storePath, PASSPHRASE, dir, "topic-a", "T1")).toEqual({ level: "ask", stale: false });
  });
});

describe("resolveAutonomy — a grant referencing a missing topic fails safe (#52 AC2)", () => {
  it("resolves to no autonomy, and reports the cell as stale, once the topic is gone from topics.json", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" }]);
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensureTrustSchema(db);
      upsertCellRow(db, grantedCell("topic-a", "T2"));
    });
    expect(resolveAutonomy(storePath, PASSPHRASE, dir, "topic-a", "T2")).toEqual({ level: "auto", stale: false });

    // The topic is merged/removed — the file no longer names it, though the DB row (from before) still does.
    writeTopicsFile(dir, []);

    expect(resolveAutonomy(storePath, PASSPHRASE, dir, "topic-a", "T2")).toEqual({ level: "ask", stale: true });
  });

  it("lists the stale cell in the grid view too, rather than a live label", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" }]);
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensureTrustSchema(db);
      upsertCellRow(db, grantedCell("topic-a", "T2"));
    });
    writeTopicsFile(dir, []);

    const grid = listGrid(storePath, PASSPHRASE, dir);
    expect(grid).toEqual([{ topicId: "topic-a", topicLabel: undefined, tier: "T2", level: "auto", source: "granted", stale: true }]);
  });
});

describe("resolveAutonomy — re-derivation preserves grants (#52 AC3)", () => {
  it("keeps a grant attached to a topic after new pairs re-cluster into it under the same stable id", async () => {
    const storePath = initStore();
    const dir = duoDir();

    const topicId = await seedTopic(storePath, dir, "what's our vacation policy?");
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensureTrustSchema(db);
      upsertCellRow(db, grantedCell(topicId, "T0"));
    });
    expect(resolveAutonomy(storePath, PASSPHRASE, dir, topicId, "T0")).toEqual({ level: "auto", stale: false });

    // Re-derivation: a new, related question arrives and matches the existing topic rather than minting a new one.
    const secondTopicId = await seedTopic(storePath, dir, "how many holiday days do we get?");
    expect(secondTopicId).toBe(topicId);
    expect(readTopicsFile(dir)).toHaveLength(1);

    expect(resolveAutonomy(storePath, PASSPHRASE, dir, topicId, "T0")).toEqual({ level: "auto", stale: false });
  });
});

describe("resolveAutonomy — no code path defaults an unknown cell to allow (#52 also-true-when-done)", () => {
  it("resolves every tier of a topic that was never touched to 'ask'", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" }]);

    for (const tier of TRUST_TIERS) {
      expect(resolveAutonomy(storePath, PASSPHRASE, dir, "topic-a", tier)).toEqual({ level: "ask", stale: false });
    }
  });

  it("resolves a topic id that never existed at all to 'ask', same as a real but untouched one", () => {
    const storePath = initStore();
    const dir = duoDir();
    expect(resolveAutonomy(storePath, PASSPHRASE, dir, "no-such-topic", "T3")).toEqual({ level: "ask", stale: false });
  });

  it("never synthesizes a row on a plain read: getCellRow still reports no row after resolveAutonomy has been called", () => {
    const storePath = initStore();
    const dir = duoDir();
    resolveAutonomy(storePath, PASSPHRASE, dir, "topic-a", "T0");
    withDatabase(storePath, PASSPHRASE, false, (db) => {
      ensureTrustSchema(db);
      expect(getCellRow(db, "topic-a", "T0")).toBeUndefined();
    });
  });
});

describe("TRUST_TIERS excludes T4 (concept.md §6: 'never autonomous, product principle')", () => {
  it("has exactly T0-T3, never T4", () => {
    expect(TRUST_TIERS).toEqual(["T0", "T1", "T2", "T3"]);
  });
});
