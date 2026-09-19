import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  DuoNotConsultableError,
  InvalidLifecycleActionError,
  archiveDuo,
  assertOwnerConsultable,
  assertPredecessorConsultable,
  declareOrphaned,
  endDuo,
  listDuoDirFiles,
  readLifecycle,
  recordEndDuo,
} from "../src/continuity/lifecycle.js";
import { loadLifecycleLog } from "../src/continuity/lifecycle-log.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { listGrid, revokeAllAutonomy } from "../src/trust/grid.js";
import { listLedgerEntries } from "../src/trust/ledger.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
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

function lifecycleLogPath(): string {
  return join(tempDir(), "lifecycle-log", "events.json");
}

describe("revokeAllAutonomy — #63 AC1: archiving revokes every grant, not just the ones named", () => {
  it("drops every touched cell to ask and logs a revoked entry per cell", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [
      { id: "topic-a", label: "Deploy access", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-b", label: "Pricing", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "deploy access", tier: "T0" });
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "pricing", tier: "T1" });

    const revoked = revokeAllAutonomy(storePath, PASSPHRASE, "test reason");
    expect(revoked).toBe(2);

    const grid = listGrid(storePath, PASSPHRASE, dir);
    expect(grid.every((cell) => cell.level === "ask")).toBe(true);

    const entries = listLedgerEntries(storePath, PASSPHRASE);
    expect(entries.filter((entry) => entry.eventType === "revoked")).toHaveLength(2);
  });

  it("is a no-op (revokes 0) when nothing has ever been granted", () => {
    const storePath = initStore();
    expect(revokeAllAutonomy(storePath, PASSPHRASE, "test reason")).toBe(0);
  });
});

describe("archiveDuo — #63 AC1: a duo is archived with an explicit decision", () => {
  it("records who and when, and revokes every autonomy grant", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-a", label: "Deploy access", createdAt: "2026-01-01T00:00:00.000Z" }]);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "deploy access", tier: "T0" });

    const record = archiveDuo(storePath, PASSPHRASE, dir, lifecycleLogPath(), "Dana Cole");

    expect(record.status).toBe("archived");
    expect(record.archivedBy).toBe("Dana Cole");
    expect(record.archivedAt).toBeTruthy();
    expect(listGrid(storePath, PASSPHRASE, dir).every((cell) => cell.level === "ask")).toBe(true);

    const events = loadLifecycleLog(lifecycleLogPath());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "archived", actor: "Dana Cole" });

    expect(readLifecycle(dir).status).toBe("archived");
  });

  it("refuses an empty decider name", () => {
    const storePath = initStore();
    expect(() => archiveDuo(storePath, PASSPHRASE, duoDir(), lifecycleLogPath(), "  ")).toThrow(InvalidLifecycleActionError);
  });

  it("refuses to archive over an existing orphan declaration", () => {
    const storePath = initStore();
    const dir = duoDir();
    declareOrphaned(dir, lifecycleLogPath(), "Bob", "owner left the organisation");
    expect(() => archiveDuo(storePath, PASSPHRASE, dir, lifecycleLogPath(), "Dana Cole")).toThrow(InvalidLifecycleActionError);
  });
});

describe("declareOrphaned / assertOwnerConsultable / assertPredecessorConsultable — #63 AC4: an orphaned duo fails safe", () => {
  it("declines both the owner's own draft surface and the historical-record surface, naming why", () => {
    const dir = duoDir();
    const record = declareOrphaned(dir, lifecycleLogPath(), "Bob", "owner left the organisation with nothing handed over");

    expect(record.status).toBe("orphaned");
    expect(() => assertOwnerConsultable(dir)).toThrow(DuoNotConsultableError);
    expect(() => assertPredecessorConsultable(dir)).toThrow(DuoNotConsultableError);
    try {
      assertOwnerConsultable(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(DuoNotConsultableError);
      expect((error as DuoNotConsultableError).status).toBe("orphaned");
      expect((error as Error).message).toContain("no accountable owner");
    }
  });

  it("refuses an empty reporter or reason", () => {
    const dir = duoDir();
    expect(() => declareOrphaned(dir, lifecycleLogPath(), "", "reason")).toThrow(InvalidLifecycleActionError);
    expect(() => declareOrphaned(dir, lifecycleLogPath(), "Bob", "")).toThrow(InvalidLifecycleActionError);
  });

  it("refuses to declare orphaned over an existing archival", () => {
    const storePath = initStore();
    const dir = duoDir();
    archiveDuo(storePath, PASSPHRASE, dir, lifecycleLogPath(), "Dana Cole");
    expect(() => declareOrphaned(dir, lifecycleLogPath(), "Bob", "left")).toThrow(InvalidLifecycleActionError);
  });
});

describe("assertOwnerConsultable — an archived duo refuses the owner's own live surface, but names the historical alternative", () => {
  it("throws naming the archival decision and pointing at duo continuity consult", () => {
    const storePath = initStore();
    const dir = duoDir();
    archiveDuo(storePath, PASSPHRASE, dir, lifecycleLogPath(), "Dana Cole");

    expect(() => assertOwnerConsultable(dir)).toThrow(DuoNotConsultableError);
    try {
      assertOwnerConsultable(dir);
    } catch (error) {
      expect((error as DuoNotConsultableError).status).toBe("archived");
      expect((error as Error).message).toContain("Dana Cole");
      expect((error as Error).message).toContain("duo continuity consult");
    }
  });

  it("does not refuse the historical-record surface for a merely archived (not orphaned) duo", () => {
    const storePath = initStore();
    const dir = duoDir();
    archiveDuo(storePath, PASSPHRASE, dir, lifecycleLogPath(), "Dana Cole");
    expect(() => assertPredecessorConsultable(dir)).not.toThrow();
  });

  it("never throws for a plain active duo", () => {
    const dir = duoDir();
    expect(() => assertOwnerConsultable(dir)).not.toThrow();
    expect(() => assertPredecessorConsultable(dir)).not.toThrow();
  });
});

describe("endDuo / recordEndDuo — #63 AC3: deletion is complete and irreversible", () => {
  it("without --yes, only describes what would be deleted and deletes nothing", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-a", label: "Leave", createdAt: "2026-01-01T00:00:00.000Z" }]);

    const result = endDuo(storePath, dir, false);
    expect(result.confirmed).toBe(false);
    expect(result.storePaths.length).toBeGreaterThan(0);
    expect(result.duoDirPaths).toContain("topics.json");
    expect(existsSync(storePath)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("with --yes, removes the corpus, derived artifacts, and standing orders, reporting exactly what was deleted", () => {
    const storePath = initStore();
    const dir = duoDir();
    writeTopicsFile(dir, [{ id: "topic-a", label: "Leave", createdAt: "2026-01-01T00:00:00.000Z" }]);

    const result = endDuo(storePath, dir, true);
    expect(result.confirmed).toBe(true);
    expect(result.storePaths.length).toBeGreaterThan(0);
    expect(result.duoDirPaths).toContain("topics.json");
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(dir)).toBe(false);

    recordEndDuo(lifecycleLogPath(), "Dana Cole", result);
    const events = loadLifecycleLog(lifecycleLogPath());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "ended", actor: "Dana Cole" });
    // The log itself must survive the deletion it just recorded.
    expect(existsSync(lifecycleLogPath())).toBe(true);
  });

  it("reports nothing to delete, and stays a no-op, when neither the store nor duoDir exist", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const dir = join(tempDir(), "duo");
    const result = endDuo(storePath, dir, true);
    expect(result.storePaths).toEqual([]);
    expect(result.duoDirPaths).toEqual([]);
  });
});

describe("listDuoDirFiles", () => {
  it("returns [] for a duoDir that doesn't exist yet", () => {
    expect(listDuoDirFiles(join(tempDir(), "nope"))).toEqual([]);
  });
});
