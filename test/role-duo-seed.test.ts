import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { putRule, type Rule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { resolveOrCreatePassphrase } from "../src/store/passphrase.js";
import { RoleDuoDefinitionError, parseRoleDuoDefinition } from "../src/role-duo/loader.js";
import {
  AmbiguousCurrentHolderError,
  NoCurrentHolderError,
  RoleHolderNotFoundError,
  seedFilePath,
  seedRoleDuo,
  withdrawHolderConsent,
} from "../src/role-duo/seed.js";
import type { RoleDuoDefinition, RoleHolder } from "../src/role-duo/types.js";

const tempDir = useTempDir();

function holderPaths(holderId: string): { storePath: string; duoDir: string } {
  return {
    storePath: join(tempDir(), holderId, "data", "duo.db"),
    duoDir: join(tempDir(), holderId, "duo"),
  };
}

/**
 * Directly seeds one approved, confirmed rule for a holder's own store —
 * bypassing the full induction pipeline (embeddings, qa-pairs) since this
 * module cares only about `listActiveRules`'s output shape, already covered
 * by rule-review.test.ts. Resolves (and persists) each holder's own
 * passphrase the same way production does — `seedRoleDuo` itself calls
 * `resolveOrCreatePassphrase`, so a test-fixed passphrase never written to
 * that file would decrypt to nothing.
 */
function seedHolderRule(storePath: string, duoDir: string, topicId: string, topicLabel: string, text: string, createdAt: string): void {
  const passphrase = resolveOrCreatePassphrase(storePath, {});
  createEncryptedStore(storePath, passphrase);
  writeTopicsFile(duoDir, [{ id: topicId, label: topicLabel, createdAt }]);
  const rule: Rule = {
    id: topicId,
    topicId,
    text,
    status: "confirmed",
    supportCount: 3,
    consistency: 1,
    createdAt,
    lastConfirmedAt: createdAt,
    reviewStatus: "approved",
    origin: "derived",
    supersededByRuleId: null,
    correctionDraftId: null,
    correctionQuestion: null,
  };
  withDatabase(storePath, passphrase, true, (db) => putRule(db, rule, []));
}

function holder(overrides: Partial<RoleHolder> & { holderId: string }): RoleHolder {
  const paths = holderPaths(overrides.holderId);
  return {
    holderName: overrides.holderId,
    storePath: paths.storePath,
    duoDir: paths.duoDir,
    heldFrom: "2020-01-01",
    heldUntil: null,
    consent: "given",
    ...overrides,
  };
}

function definitionPath(): string {
  return join(tempDir(), "role-duos", "deploy-desk.json");
}

function writeDefinition(definition: RoleDuoDefinition): string {
  const path = definitionPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(definition), "utf8");
  return path;
}

describe("parseRoleDuoDefinition", () => {
  it("rejects a definition with an unknown consent value", () => {
    expect(() =>
      parseRoleDuoDefinition({
        roleId: "r",
        roleName: "R",
        holders: [{ holderId: "a", holderName: "A", storePath: "s", duoDir: "d", heldFrom: "2020", heldUntil: null, consent: "maybe" }],
      }),
    ).toThrow(RoleDuoDefinitionError);
  });

  it("rejects duplicate holder ids", () => {
    const base = { holderName: "A", storePath: "s", duoDir: "d", heldFrom: "2020", heldUntil: null as string | null, consent: "given" as const };
    expect(() =>
      parseRoleDuoDefinition({ roleId: "r", roleName: "R", holders: [{ holderId: "a", ...base }, { holderId: "a", ...base }] }),
    ).toThrow(RoleDuoDefinitionError);
  });
});

describe("seedRoleDuo — AC1: seeded from multiple consenting contributors", () => {
  it("carries standing orders from all consenting holders, each attributed to who established it and when", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Overtime policy", "Claim within 30 days", "2024-01-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021-01-01", heldUntil: "2023-12-31" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024-01-01", heldUntil: null }),
      ],
    });

    const seed = seedRoleDuo(path);
    expect(seed.standingOrders).toHaveLength(2);
    const leave = seed.standingOrders.find((order) => order.topicLabel === "Leave policy");
    expect(leave?.holderName).toBe("Alice");
    expect(leave?.establishedAt).toBe("2022-01-01T00:00:00.000Z");
    const overtime = seed.standingOrders.find((order) => order.topicLabel === "Overtime policy");
    expect(overtime?.holderName).toBe("Bob");
    expect(seed.includedHolderIds.sort()).toEqual(["alice", "bob"]);
    expect(seed.currentHolderId).toBe("bob");
    expect(seed.singleHolderBasis).toBe(false);

    // Persisted alongside the definition, not merely returned.
    const writtenPath = seedFilePath(path);
    expect(existsSync(writtenPath)).toBe(true);
    const written = JSON.parse(readFileSync(writtenPath, "utf8"));
    expect(written.roleId).toBe("deploy-desk");
    expect(written.standingOrders).toHaveLength(2);
  });
});

describe("seedRoleDuo — AC2: conflicting positions are surfaced, not merged", () => {
  it("shows both dated, attributed positions and synthesises no averaged rule", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Deploy freeze window", "Freeze is 3 days before release", "2022-06-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Deploy freeze window", "Freeze is 7 days before release", "2024-06-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });

    const seed = seedRoleDuo(path);
    expect(seed.standingOrders).toHaveLength(0);
    expect(seed.conflicts).toHaveLength(1);
    expect(seed.conflicts[0].topicLabel).toBe("Deploy freeze window");
    expect(seed.conflicts[0].positions.map((p) => p.holderName)).toEqual(["Alice", "Bob"]);
    expect(seed.conflicts[0].positions.map((p) => p.text)).toEqual([
      "Freeze is 3 days before release",
      "Freeze is 7 days before release",
    ]);
  });

  it("does not treat the same policy stated identically by two holders as a conflict", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Leave policy", "5 days per quarter", "2024-01-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });

    const seed = seedRoleDuo(path);
    expect(seed.conflicts).toHaveLength(0);
    expect(seed.standingOrders).toHaveLength(2);
  });
});

describe("seedRoleDuo — AC3: seeding requires each contributor's consent", () => {
  it("excludes a holder who has not consented, and reports the exclusion", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Overtime policy", "Claim within 30 days", "2024-01-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023", consent: "withheld" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });

    const seed = seedRoleDuo(path);
    expect(seed.standingOrders).toHaveLength(1);
    expect(seed.standingOrders[0].holderName).toBe("Bob");
    expect(seed.excludedHolders).toEqual([{ holderId: "alice", holderName: "Alice", reason: "did not consent to sharing their material with the role duo" }]);
  });

  it("excludes a holder who cannot be asked, with its own reason", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Overtime policy", "Claim within 30 days", "2024-01-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023", consent: "unreachable" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });

    const seed = seedRoleDuo(path);
    expect(seed.excludedHolders[0].reason).toBe("could not be asked for consent (no longer reachable)");
  });
});

describe("seedRoleDuo — AC4: a single-holder role duo is honest about its basis", () => {
  it("states that it reflects one holder rather than the accumulated practice of the desk", () => {
    const alice = holderPaths("alice");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: null })],
    });

    const seed = seedRoleDuo(path);
    expect(seed.singleHolderBasis).toBe(true);
    expect(seed.basisStatement).toContain("reflects one holder");
    expect(seed.standingOrders).toHaveLength(1);
  });

  it("still works and is honest when every non-current holder was excluded, leaving one consenting holder", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Overtime policy", "Claim within 30 days", "2024-01-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023", consent: "withheld" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });

    const seed = seedRoleDuo(path);
    expect(seed.singleHolderBasis).toBe(true);
    expect(seed.basisStatement).toContain("Bob");
  });
});

describe("seedRoleDuo — no current holder", () => {
  it("refuses to seed a role duo for a post nobody currently holds", () => {
    const alice = holderPaths("alice");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023" })],
    });

    expect(() => seedRoleDuo(path)).toThrow(NoCurrentHolderError);
  });

  it("refuses an internally inconsistent definition naming two current holders", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Overtime policy", "Claim within 30 days", "2024-01-01T00:00:00.000Z");
    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: null }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });

    expect(() => seedRoleDuo(path)).toThrow(AmbiguousCurrentHolderError);
  });
});

describe("withdrawHolderConsent — withdrawal removes a contributor's material and rules resting only on it", () => {
  it("drops the withdrawn holder's standing order and collapses a conflict that rested only on their position", () => {
    const alice = holderPaths("alice");
    const bob = holderPaths("bob");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Deploy freeze window", "Freeze is 3 days before release", "2022-06-01T00:00:00.000Z");
    seedHolderRule(bob.storePath, bob.duoDir, "topic-b1", "Deploy freeze window", "Freeze is 7 days before release", "2024-06-01T00:00:00.000Z");

    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [
        holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: "2023" }),
        holder({ holderId: "bob", holderName: "Bob", storePath: bob.storePath, duoDir: bob.duoDir, heldFrom: "2024", heldUntil: null }),
      ],
    });
    seedRoleDuo(path);

    const seed = withdrawHolderConsent(path, "alice");
    expect(seed.conflicts).toHaveLength(0);
    expect(seed.standingOrders).toHaveLength(1);
    expect(seed.standingOrders[0].holderName).toBe("Bob");
    expect(seed.excludedHolders).toEqual([{ holderId: "alice", holderName: "Alice", reason: "withdrew their earlier consent" }]);

    const updatedDefinition = JSON.parse(readFileSync(path, "utf8")) as RoleDuoDefinition;
    expect(updatedDefinition.holders.find((h) => h.holderId === "alice")?.consent).toBe("withdrawn");

    const writtenSeed = JSON.parse(readFileSync(seedFilePath(path), "utf8"));
    expect(writtenSeed.standingOrders).toHaveLength(1);
  });

  it("throws for an unknown holder id", () => {
    const alice = holderPaths("alice");
    seedHolderRule(alice.storePath, alice.duoDir, "topic-a1", "Leave policy", "5 days per quarter", "2022-01-01T00:00:00.000Z");
    const path = writeDefinition({
      roleId: "deploy-desk",
      roleName: "Deployment Access Desk",
      holders: [holder({ holderId: "alice", holderName: "Alice", storePath: alice.storePath, duoDir: alice.duoDir, heldFrom: "2021", heldUntil: null })],
    });

    expect(() => withdrawHolderConsent(path, "nobody")).toThrow(RoleHolderNotFoundError);
  });
});
