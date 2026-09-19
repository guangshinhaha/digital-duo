import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grantAutonomy, matchTopicsForGrant } from "../src/trust/grants.js";
import { ensureTrustSchema, getCellRow } from "../src/trust/grid.js";
import { listLedgerEntries } from "../src/trust/ledger.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
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

function seedTopics(topics: { id: string; label: string }[]): void {
  writeTopicsFile(
    duoDir(),
    topics.map((topic) => ({ ...topic, createdAt: "2026-01-01T00:00:00.000Z" })),
  );
}

function writeRefusals(text: string): void {
  mkdirSync(duoDir(), { recursive: true });
  writeFileSync(join(duoDir(), "refusals.md"), text, "utf8");
}

describe("matchTopicsForGrant", () => {
  it("scores a topic by how much of its label the scope text covers", () => {
    seedTopics([
      { id: "topic-deploy", label: "Deploy access" },
      { id: "topic-pricing", label: "Pricing" },
    ]);
    const candidates = matchTopicsForGrant(duoDir(), "point people at the runbook for deploy access");
    expect(candidates[0]).toMatchObject({ topicId: "topic-deploy", score: 1 });
  });

  it("returns [] when nothing overlaps at all", () => {
    seedTopics([{ id: "topic-pricing", label: "Pricing" }]);
    expect(matchTopicsForGrant(duoDir(), "totally unrelated text")).toEqual([]);
  });
});

describe("grantAutonomy — a written grant takes effect (#53 AC1)", () => {
  it("moves the corresponding cell to auto immediately when the topic is unambiguous", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-deploy", label: "Deploy access" }]);

    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "deploy access questions", tier: "T0" });

    expect(outcome).toEqual({ status: "applied", topicId: "topic-deploy", topicLabel: "Deploy access", tier: "T0" });
    withDatabase(storePath, PASSPHRASE, false, (db) => {
      const cell = getCellRow(db, "topic-deploy", "T0");
      expect(cell?.level).toBe("auto");
      expect(cell?.source).toBe("granted");
    });
  });

  it("records the grant in the ledger", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-deploy", label: "Deploy access" }]);
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "deploy access questions", tier: "T0" });

    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-deploy", tier: "T0" });
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe("granted");
    expect(entries[0].detail).toMatchObject({ scopeText: "deploy access questions" });
  });

  it("applies immediately given an explicit --topic, bypassing matching entirely", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "anything, doesn't matter", tier: "T1", topicId: "topic-a" });
    expect(outcome).toMatchObject({ status: "applied", topicId: "topic-a" });
  });

  it("reports topic_not_found for an explicit --topic that doesn't exist, without writing anything", () => {
    const storePath = initStore();
    seedTopics([]);
    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "x", tier: "T0", topicId: "no-such-topic" });
    expect(outcome).toEqual({ status: "topic_not_found", topicId: "no-such-topic" });
  });
});

describe("grantAutonomy — an ambiguous grant is confirmed before taking effect (#53 AC2)", () => {
  it("changes nothing and reports every tied candidate when the scope text matches more than one topic equally", () => {
    const storePath = initStore();
    seedTopics([
      { id: "topic-deploy", label: "deploy access" },
      { id: "topic-deploy-2", label: "deploy access" },
    ]);

    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "deploy access", tier: "T0" });
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") {
      expect(outcome.candidates.map((c) => c.topicId).sort()).toEqual(["topic-deploy", "topic-deploy-2"]);
    }

    withDatabase(storePath, PASSPHRASE, false, (db) => {
      ensureTrustSchema(db);
      expect(getCellRow(db, "topic-deploy", "T0")).toBeUndefined();
      expect(getCellRow(db, "topic-deploy-2", "T0")).toBeUndefined();
    });
  });

  it("reports no_match, changing nothing, when nothing matches at all", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "completely unrelated", tier: "T0" });
    expect(outcome).toEqual({ status: "no_match" });
  });
});

describe("grantAutonomy — a grant cannot exceed a refusal (#53 AC3)", () => {
  it("refuses the grant and shows the conflicting refusal, without writing anything", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-headcount", label: "Headcount" }]);
    writeRefusals("## Headcount\nNever speak for me on comp, headcount, or anything touching a renewal.\n");

    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "headcount questions", tier: "T0" });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.refusal.heading).toBe("Headcount");
    }

    withDatabase(storePath, PASSPHRASE, false, (db) => {
      ensureTrustSchema(db);
      expect(getCellRow(db, "topic-headcount", "T0")).toBeUndefined();
    });
    expect(listLedgerEntries(storePath, PASSPHRASE)).toEqual([]);
  });

  it("still refuses when the topic is named via an explicit --topic rather than matched text", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-headcount", label: "Headcount" }]);
    writeRefusals("## Headcount\nreason\n");

    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "anything", tier: "T0", topicId: "topic-headcount" });
    expect(outcome.status).toBe("refused");
  });
});

describe("grantAutonomy — grants are visible in one place (#53 AC4)", () => {
  it("shows up in the grid with source 'granted'", async () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-deploy", label: "Deploy access" }]);
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "deploy access", tier: "T0" });

    const { listGrid } = await import("../src/trust/grid.js");
    const grid = listGrid(storePath, PASSPHRASE, duoDir());
    expect(grid).toEqual([{ topicId: "topic-deploy", topicLabel: "Deploy access", tier: "T0", level: "auto", source: "granted", stale: false }]);
  });
});

describe("grantAutonomy — a T3 grant never lands at 'auto' (#59: no T3 action is autonomous on first grant)", () => {
  it("caps a T3 grant at 'approve', unlike every other tier", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-deploy", label: "Deploy access" }]);
    const outcome = grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "deploy access", tier: "T3" });
    expect(outcome).toMatchObject({ status: "applied", tier: "T3" });
    withDatabase(storePath, PASSPHRASE, false, (db) => {
      expect(getCellRow(db, "topic-deploy", "T3")?.level).toBe("approve");
    });
  });

  it("still caps T0/T1/T2 grants at 'auto', unaffected by the T3-specific cap", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-deploy", label: "Deploy access" }]);
    for (const tier of ["T0", "T1", "T2"] as const) {
      grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "deploy access", tier });
      withDatabase(storePath, PASSPHRASE, false, (db) => {
        expect(getCellRow(db, "topic-deploy", tier)?.level).toBe("auto");
      });
    }
  });
});
