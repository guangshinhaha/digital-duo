import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyActionTier, getRegisteredAction, listRegisteredActions, registerAction, resolveActionForUse, type ActionDescriptor } from "../src/actions/registry.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import { InvalidBooleanFlagError, runActionsRegister } from "../src/commands/actions.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { listLedgerEntries } from "../src/trust/ledger.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { createEncryptedStore } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";

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

function descriptor(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return {
    id: "route-ticket",
    description: "Route a ticket to the owning team",
    reversible: true,
    obligates: false,
    audience: "internal",
    topicIds: ["topic-a"],
    ...overrides,
  };
}

describe("classifyActionTier — the pure risk classifier (#56 AC1)", () => {
  it("audience 'none' is always T0, regardless of reversibility/obligation", () => {
    expect(classifyActionTier({ audience: "none", reversible: false, obligates: true })).toBe("T0");
    expect(classifyActionTier({ audience: "none", reversible: true, obligates: false })).toBe("T0");
  });

  it("audience 'owner' is always T1", () => {
    expect(classifyActionTier({ audience: "owner", reversible: true, obligates: false })).toBe("T1");
    expect(classifyActionTier({ audience: "owner", reversible: false, obligates: true })).toBe("T1");
  });

  it("audience 'internal', reversible, non-obligating is T2", () => {
    expect(classifyActionTier({ audience: "internal", reversible: true, obligates: false })).toBe("T2");
  });

  it("audience 'internal' but obligating is T3, even if reversible", () => {
    expect(classifyActionTier({ audience: "internal", reversible: true, obligates: true })).toBe("T3");
  });

  it("audience 'internal' but irreversible is T3, even without obligation", () => {
    expect(classifyActionTier({ audience: "internal", reversible: false, obligates: false })).toBe("T3");
  });

  it("audience 'external' is always T4, regardless of reversibility/obligation — concept.md §6's 'never autonomous' line", () => {
    expect(classifyActionTier({ audience: "external", reversible: true, obligates: false })).toBe("T4");
    expect(classifyActionTier({ audience: "external", reversible: false, obligates: true })).toBe("T4");
  });
});

describe("registerAction — a registered action carries its tier (#56 AC1)", () => {
  it("stores the tier resolved from the risk shape, not asserted directly", () => {
    const storePath = initStore();
    const result = registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: false }));
    expect(result.action.tier).toBe("T2");
    expect(getRegisteredAction(storePath, PASSPHRASE, "route-ticket")?.tier).toBe("T2");
  });

  it("lists every registered action", () => {
    const storePath = initStore();
    registerAction(storePath, PASSPHRASE, descriptor({ id: "a" }));
    registerAction(storePath, PASSPHRASE, descriptor({ id: "b", audience: "owner" }));
    expect(listRegisteredActions(storePath, PASSPHRASE).map((a) => a.id).sort()).toEqual(["a", "b"]);
  });
});

describe("resolveActionForUse — an unregistered tool cannot be used (#56 AC2)", () => {
  it("refuses and logs the attempt, rather than executing at an assumed tier", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "never-registered", "topic-a");
    expect(outcome).toEqual({ status: "refused_unregistered" });

    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ actionId: "never-registered", outcome: "refused_unregistered" });
  });

  it("resolves a registered action against the trust grid, defaulting to 'ask' when the cell was never touched", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: false }));

    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "route-ticket", "topic-a");
    expect(outcome).toEqual({ status: "resolved", tier: "T2", level: "ask", stale: false });
  });

  it("reflects a granted cell's autonomy level", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: false }));
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T2" });

    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "route-ticket", "topic-a");
    expect(outcome).toEqual({ status: "resolved", tier: "T2", level: "auto", stale: false });
  });

  it("always resolves a T4 action to confirm_required, never to a grid-derived level", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "external", reversible: true, obligates: false, topicIds: ["topic-a"] }));

    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "route-ticket", "topic-a");
    expect(outcome).toEqual({ status: "resolved", tier: "T4", level: "confirm_required", stale: false });

    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.at(-1)).toMatchObject({ outcome: "requires_human_confirmation", tier: "T4" });
  });
});

describe("registerAction — re-tiering revokes stale grants (#56 AC3)", () => {
  it("rising risk revokes a granted cell at the old tier and reports it as lapsed", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: false, topicIds: ["topic-a"] }));
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T2" });

    // Re-register the same action, now obligating (T2 -> T3 is a rise).
    const result = registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: true, topicIds: ["topic-a"] }));

    expect(result.tierChanged).toBe(true);
    expect(result.previousTier).toBe("T2");
    expect(result.lapsedGrants).toEqual([{ topicId: "topic-a", tier: "T2", previousLevel: "auto" }]);
  });

  it("the revoked cell itself reads back as 'ask'", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: false, topicIds: ["topic-a"] }));
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T2" });
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: true, topicIds: ["topic-a"] }));

    const outcome = resolveActionForUse(storePath, PASSPHRASE, duoDir(), "route-ticket", "topic-a");
    expect(outcome).toMatchObject({ level: "ask" });
  });

  it("records the revocation in the trust ledger", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: false, topicIds: ["topic-a"] }));
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T2" });
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: true, topicIds: ["topic-a"] }));

    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T2" });
    expect(entries.some((e) => e.eventType === "revoked")).toBe(true);
  });

  it("a falling or unchanged tier never revokes anything", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: true, topicIds: ["topic-a"] })); // T3
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T3" });

    // Re-register unchanged (still T3).
    const result = registerAction(storePath, PASSPHRASE, descriptor({ audience: "internal", reversible: true, obligates: true, topicIds: ["topic-a"] }));
    expect(result.tierChanged).toBe(false);
    expect(result.lapsedGrants).toEqual([]);
  });
});

describe("runActionsRegister — a typo in --reversible/--obligates must not silently misclassify (#56 AC1)", () => {
  it("throws InvalidBooleanFlagError rather than treating an unrecognised value as false", () => {
    const storePath = initStore();
    seedTopics([{ id: "topic-a", label: "Alpha" }]);
    const config = loadConfig({ DUO_STORE_PATH: storePath, DUO_DIR: duoDir() });
    expect(() =>
      runActionsRegister("x", { description: "d", reversible: "yes", obligates: "false", audience: "internal", topics: "topic-a" }, config),
    ).toThrow(InvalidBooleanFlagError);
  });
});
