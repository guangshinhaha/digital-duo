import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPendingActions } from "../src/actions/approvals.js";
import { registerAction } from "../src/actions/registry.js";
import {
  CannotUndoError,
  NotAT2ActionError,
  ReversibleActionNotFoundError,
  getReversibleAction,
  listReversibleActions,
  performReversibleAction,
  undoReversibleAction,
} from "../src/actions/reversible.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { createEncryptedStore } from "../src/store/store.js";
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

function registerT2(storePath: string, topicId = "topic-a"): void {
  registerAction(storePath, PASSPHRASE, { id: "route-ticket", description: "route", reversible: true, obligates: false, audience: "internal", topicIds: [topicId] });
}

function grantAuto(storePath: string, topicId = "topic-a", tier: "T2" = "T2"): void {
  seedTopics([{ id: topicId, label: "Alpha" }]);
  grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier });
}

describe("performReversibleAction — refuses anything not genuinely a granted, revertible T2 action", () => {
  it("throws NotAT2ActionError for an unregistered action, and logs the attempt (not lost to the throw)", () => {
    const storePath = initStore();
    expect(() =>
      performReversibleAction(storePath, PASSPHRASE, duoDir(), { actionId: "ghost", topicId: "topic-a", description: "x", canRevertHere: true, perform: () => {} }),
    ).toThrow(NotAT2ActionError);

    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.actionId === "ghost" && a.outcome === "refused_unregistered")).toBe(true);
  });

  it("throws NotAT2ActionError for an action registered at a different tier, and logs the attempt", () => {
    const storePath = initStore();
    registerAction(storePath, PASSPHRASE, { id: "send-notice", description: "send", reversible: false, obligates: true, audience: "external", topicIds: ["topic-a"] }); // T4
    expect(() =>
      performReversibleAction(storePath, PASSPHRASE, duoDir(), { actionId: "send-notice", topicId: "topic-a", description: "x", canRevertHere: true, perform: () => {} }),
    ).toThrow(NotAT2ActionError);

    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.actionId === "send-notice" && a.outcome === "refused_unregistered")).toBe(true);
  });
});

describe("performReversibleAction — a reversible action runs and is announced (#58 AC1)", () => {
  it("performs the action and returns an announcement when granted 'auto' and genuinely revertible", () => {
    const storePath = initStore();
    registerT2(storePath);
    grantAuto(storePath);

    let ran = false;
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), {
      actionId: "route-ticket",
      topicId: "topic-a",
      description: "Routed the deploy-access question to the platform team",
      canRevertHere: true,
      perform: () => { ran = true; },
    });

    expect(ran).toBe(true);
    expect(outcome.status).toBe("performed");
    if (outcome.status === "performed") {
      expect(outcome.announcement).toMatch(/Routed the deploy-access question/);
      expect(outcome.record.status).toBe("active");
    }
  });

  it("never calls perform when autonomy isn't granted — escalates instead", () => {
    const storePath = initStore();
    registerT2(storePath);
    seedTopics([{ id: "topic-a", label: "Alpha" }]); // no grant

    let called = false;
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), {
      actionId: "route-ticket",
      topicId: "topic-a",
      description: "x",
      canRevertHere: true,
      perform: () => { called = true; },
    });

    expect(called).toBe(false);
    expect(outcome.status).toBe("escalated");
    if (outcome.status === "escalated") {
      expect(outcome.pendingAction.tier).toBe("T2");
    }
  });
});

describe("performReversibleAction — a target that isn't reversible here escalates as T3, never runs (#58 AC3)", () => {
  it("never calls perform, and stages a T3 pending action instead of a T2 one", () => {
    const storePath = initStore();
    registerT2(storePath);
    grantAuto(storePath);

    let called = false;
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), {
      actionId: "route-ticket",
      topicId: "topic-a",
      description: "irrevocable in this system",
      canRevertHere: false,
      perform: () => { called = true; },
    });

    expect(called).toBe(false);
    expect(outcome.status).toBe("escalated");
    if (outcome.status === "escalated") {
      expect(outcome.pendingAction.tier).toBe("T3");
    }
    const pending = listPendingActions(storePath, PASSPHRASE);
    expect(pending).toHaveLength(1);
    expect(pending[0].tier).toBe("T3");
  });
});

describe("undoReversibleAction — undo restores the prior state completely (#58 AC2)", () => {
  it("calls revert exactly once and marks the record reverted", () => {
    const storePath = initStore();
    registerT2(storePath);
    grantAuto(storePath);
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), { actionId: "route-ticket", topicId: "topic-a", description: "x", canRevertHere: true, perform: () => {} });
    if (outcome.status !== "performed") throw new Error("expected performed");

    let revertCount = 0;
    const record = undoReversibleAction(storePath, PASSPHRASE, outcome.record.id, () => { revertCount += 1; });
    expect(revertCount).toBe(1);
    expect(record.status).toBe("reverted");
    expect(getReversibleAction(storePath, PASSPHRASE, outcome.record.id)?.status).toBe("reverted");
  });

  it("refuses to undo the same action twice", () => {
    const storePath = initStore();
    registerT2(storePath);
    grantAuto(storePath);
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), { actionId: "route-ticket", topicId: "topic-a", description: "x", canRevertHere: true, perform: () => {} });
    if (outcome.status !== "performed") throw new Error("expected performed");

    undoReversibleAction(storePath, PASSPHRASE, outcome.record.id, () => {});
    expect(() => undoReversibleAction(storePath, PASSPHRASE, outcome.record.id, () => {})).toThrow(CannotUndoError);
  });

  it("throws for an unknown id", () => {
    const storePath = initStore();
    expect(() => undoReversibleAction(storePath, PASSPHRASE, "no-such-id", () => {})).toThrow(ReversibleActionNotFoundError);
  });
});

describe("performReversibleAction — a failed action leaves no partial change and is escalated (#58 AC4)", () => {
  it("rolls back what it can, records the failure, and reports it rather than the announcement", () => {
    const storePath = initStore();
    registerT2(storePath);
    grantAuto(storePath);

    let rolledBack = false;
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), {
      actionId: "route-ticket",
      topicId: "topic-a",
      description: "will fail",
      canRevertHere: true,
      perform: () => { throw new Error("downstream system unavailable"); },
      rollbackPartial: () => { rolledBack = true; },
    });

    expect(rolledBack).toBe(true);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toMatch(/downstream system unavailable/);
      expect(outcome.record.status).toBe("failed");
    }
    expect(listReversibleActions(storePath, PASSPHRASE).at(-1)?.status).toBe("failed");

    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.outcome === "execution_failed")).toBe(true);
  });

  it("a failed record can never be undone", () => {
    const storePath = initStore();
    registerT2(storePath);
    grantAuto(storePath);
    const outcome = performReversibleAction(storePath, PASSPHRASE, duoDir(), {
      actionId: "route-ticket",
      topicId: "topic-a",
      description: "will fail",
      canRevertHere: true,
      perform: () => { throw new Error("boom"); },
    });
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(() => undoReversibleAction(storePath, PASSPHRASE, outcome.record.id, () => {})).toThrow(CannotUndoError);
  });
});
