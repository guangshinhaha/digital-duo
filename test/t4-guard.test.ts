import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyActionTier, registerAction, resolveActionForUse } from "../src/actions/registry.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import {
  confirmAndExecuteT4Request,
  createT4Request,
  listPendingT4Requests,
  NoPendingT4RequestError,
  NotAT4ActionError,
  T4RequestAlreadyExecutedError,
} from "../src/actions/t4-guard.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { isTrustTier } from "../src/trust/grid.js";
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
  writeTopicsFile(duoDir(), topics.map((topic) => ({ ...topic, createdAt: "2026-01-01T00:00:00.000Z" })));
}

describe("T4 is structurally excluded from the trust grid (#60 AC1)", () => {
  it("isTrustTier('T4') is false — a compile-time exclusion, re-asserted here", () => {
    expect(isTrustTier("T4")).toBe(false);
  });

  it("the database refuses to insert a T4 row into trust_cells at all, even bypassing every typed function in this codebase", () => {
    const storePath = initStore();
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trust_cells (
          topic_id TEXT NOT NULL,
          tier TEXT NOT NULL CHECK (tier IN ('T0', 'T1', 'T2', 'T3')),
          level TEXT NOT NULL,
          source TEXT NOT NULL,
          clean_streak INTEGER NOT NULL DEFAULT 0,
          last_offer_streak INTEGER,
          last_offer_status TEXT,
          demotion_announced INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (topic_id, tier)
        ) STRICT
      `);
      expect(() =>
        db
          .prepare(
            `INSERT INTO trust_cells (topic_id, tier, level, source, clean_streak, last_offer_streak, last_offer_status, demotion_announced, updated_at) VALUES (?, 'T4', 'auto', 'granted', 0, NULL, NULL, 1, ?)`,
          )
          .run("topic-a", new Date().toISOString()),
      ).toThrow(/CHECK/i);
    });
  });
});

describe("classifyActionTier — audience 'external' is always T4 (#60, reprised from #56)", () => {
  it("is T4 regardless of reversibility or obligation", () => {
    expect(classifyActionTier({ audience: "external", reversible: true, obligates: false })).toBe("T4");
    expect(classifyActionTier({ audience: "external", reversible: false, obligates: true })).toBe("T4");
  });
});

describe("resolveActionForUse — a T4 action never resolves to a grid-derived level, no matter what's granted (#60 AC1)", () => {
  it("resolves to confirm_required even when a same-topic T3 grant exists at 'auto'", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T3" });
    registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: false, obligates: true, audience: "external", topicIds: ["topic-a"] });

    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "send-notice", "topic-a");
    expect(outcome).toEqual({ status: "resolved", tier: "T4", level: "confirm_required", stale: false });
  });
});

describe("registerAction — an action reclassified into T4 loses its autonomy immediately (#60 AC2)", () => {
  it("revokes the prior T3 grant and reports it lapsed when audience rises to external", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: true, obligates: true, audience: "internal", topicIds: ["topic-a"] }); // T3
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T3" });

    const result = registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: true, obligates: true, audience: "external", topicIds: ["topic-a"] }); // T4
    expect(result.action.tier).toBe("T4");
    expect(result.previousTier).toBe("T3");
    // #59 caps a T3 grant at "approve", not "auto" (no T3 action is
    // autonomous on first grant) — the revocation logic still fires for
    // any non-"ask" level, so this is the exact value that lapses now.
    expect(result.lapsedGrants).toEqual([{ topicId: "topic-a", tier: "T3", previousLevel: "approve" }]);

    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "send-notice", "topic-a");
    expect(outcome).toEqual({ status: "resolved", tier: "T4", level: "confirm_required", stale: false });
  });
});

describe("createT4Request — only stages a request for a genuinely registered T4 action (#60 AC1/AC3)", () => {
  it("refuses and logs the attempt for an unregistered action", () => {
    const storePath = initStore();
    expect(() => createT4Request(storePath, PASSPHRASE, { actionId: "ghost", topicId: "topic-a", reasoning: "because" })).toThrow(NotAT4ActionError);
    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.outcome === "refused_t4_bypass" && a.actionId === "ghost")).toBe(true);
  });

  it("refuses and logs the attempt for an action registered at a lower tier", () => {
    const storePath = initStore();
    registerAction(storePath, PASSPHRASE, { id: "route-ticket", description: "route", reversible: true, obligates: false, audience: "internal", topicIds: ["topic-a"] }); // T2
    expect(() => createT4Request(storePath, PASSPHRASE, { actionId: "route-ticket", topicId: "topic-a", reasoning: "because" })).toThrow(NotAT4ActionError);
    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.outcome === "refused_t4_bypass" && a.actionId === "route-ticket")).toBe(true);
  });

  it("stages a request for a genuinely T4 action, executing nothing", () => {
    const storePath = initStore();
    registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: false, obligates: true, audience: "external", topicIds: ["topic-a"] });
    const request = createT4Request(storePath, PASSPHRASE, { actionId: "send-notice", topicId: "topic-a", reasoning: "citizen asked" });
    expect(request.executedAt).toBeNull();
    expect(listPendingT4Requests(storePath, PASSPHRASE)).toHaveLength(1);
  });
});

describe("confirmAndExecuteT4Request — the only function anywhere that can run a T4 side effect (#60 AC1)", () => {
  it("refuses an unknown request id and never calls execute", () => {
    const storePath = initStore();
    let called = false;
    expect(() => confirmAndExecuteT4Request(storePath, PASSPHRASE, "no-such-id", () => { called = true; })).toThrow(NoPendingT4RequestError);
    expect(called).toBe(false);
  });

  it("calls execute exactly once, only after a real prior createT4Request", () => {
    const storePath = initStore();
    registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: false, obligates: true, audience: "external", topicIds: ["topic-a"] });
    const request = createT4Request(storePath, PASSPHRASE, { actionId: "send-notice", topicId: "topic-a", reasoning: "citizen asked" });

    let callCount = 0;
    const result = confirmAndExecuteT4Request(storePath, PASSPHRASE, request.id, () => { callCount += 1; });
    expect(callCount).toBe(1);
    expect(result.executedAt).not.toBeNull();

    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.outcome === "t4_executed")).toBe(true);
  });

  it("refuses to execute the same request twice", () => {
    const storePath = initStore();
    registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: false, obligates: true, audience: "external", topicIds: ["topic-a"] });
    const request = createT4Request(storePath, PASSPHRASE, { actionId: "send-notice", topicId: "topic-a", reasoning: "citizen asked" });

    let callCount = 0;
    confirmAndExecuteT4Request(storePath, PASSPHRASE, request.id, () => { callCount += 1; });
    expect(() => confirmAndExecuteT4Request(storePath, PASSPHRASE, request.id, () => { callCount += 1; })).toThrow(T4RequestAlreadyExecutedError);
    expect(callCount).toBe(1);
  });
});

describe("duo trust grant --tier T4 — refused and recorded (#60 AC3)", () => {
  it("refuses via the existing tier validation, and logs the bypass attempt", async () => {
    const { runTrustGrant, InvalidTrustTierError } = await import("../src/commands/trust.js");
    const { loadConfig } = await import("../src/config.js");
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    const config = loadConfig({ DUO_STORE_PATH: storePath, DUO_DIR: duoDir() });

    expect(() => runTrustGrant("Alpha", { tier: "T4" }, config, { DUO_PASSPHRASE: PASSPHRASE })).toThrow(InvalidTrustTierError);
    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.actionId === "trust_grant" && a.outcome === "refused_t4_bypass")).toBe(true);
  });
});

describe("t4-guard.ts reads no environment variable or configuration (#60 AC1: 'no setting exists to bypass this')", () => {
  it("has no reference to process.env in its source", () => {
    const path = fileURLToPath(new URL("../src/actions/t4-guard.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/process\.env/);
  });
});

describe("README states the T4 principle in concept.md's own words (#60 'also true when done')", () => {
  it("quotes concept.md §6's exact T4 line", () => {
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
    const conceptPath = fileURLToPath(new URL("../docs/concept.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    const concept = readFileSync(conceptPath, "utf8");
    expect(concept).toContain("Never autonomous. Product principle, not a limitation.");
    expect(readme).toContain("Never autonomous. Product principle, not a limitation.");
  });
});
