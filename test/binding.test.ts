import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvePendingAction,
  expirePendingActions,
  getApprovalStats,
  getPendingAction,
  listPendingActions,
  NoPendingActionError,
  PendingActionExpiredError,
  PendingActionNotApprovedError,
  PendingActionNotPendingError,
  retractApprovedAction,
} from "../src/actions/approvals.js";
import { BINDING_ACTION_DEFAULT_EXPIRY_HOURS, NotAT3ActionError, prepareBindingAction } from "../src/actions/binding.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { registerAction } from "../src/actions/registry.js";
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

function registerT3(storePath: string, topicId = "topic-a"): void {
  registerAction(storePath, PASSPHRASE, { id: "assign-owner", description: "assign", reversible: true, obligates: true, audience: "internal", topicIds: [topicId] });
}

describe("prepareBindingAction — a binding action is prepared, never executed here (#59 AC1)", () => {
  it("refuses to stage anything not genuinely registered T3, and logs the attempt", () => {
    const storePath = initStore();
    expect(() => prepareBindingAction(storePath, PASSPHRASE, { actionId: "ghost", topicId: "topic-a", reasoning: "x" })).toThrow(NotAT3ActionError);
    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((a) => a.actionId === "ghost" && a.outcome === "refused_unregistered")).toBe(true);
  });

  it("stages a pending T3 item with the given reasoning and commitment, defaulting to a 24h expiry", () => {
    const storePath = initStore();
    registerT3(storePath);
    const before = Date.now();
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "Assign Jamie to the incident", commitsTo: "Response by Friday" });

    expect(pending.status).toBe("pending");
    expect(pending.tier).toBe("T3");
    expect(pending.commitsTo).toBe("Response by Friday");
    const expiresInHours = (new Date(pending.expiresAt!).getTime() - before) / (60 * 60 * 1000);
    expect(expiresInHours).toBeCloseTo(BINDING_ACTION_DEFAULT_EXPIRY_HOURS, 1);
  });

  it("never itself executes anything — there is no execute parameter to this function at all", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x" });
    expect(getPendingAction(storePath, PASSPHRASE, pending.id)?.status).toBe("pending");
  });

  it("ignores the trust grid entirely — staging happens the same way whether or not the topic has an 'auto' T3 grant", () => {
    const storePath = initStore();
    registerT3(storePath);
    writeTopicsFile(duoDir(), [{ id: "topic-a", label: "Alpha", createdAt: "2026-01-01T00:00:00.000Z" }]);
    grantAutonomy(storePath, PASSPHRASE, duoDir(), { scopeText: "Alpha", tier: "T3" }); // per #59's own review decision, grants.ts caps T3 at "approve", never "auto" — this proves staging doesn't even look
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x" });
    expect(pending.status).toBe("pending");
  });
});

describe("approvePendingAction — nothing happens until the owner approves (#59 AC1)", () => {
  it("calls execute exactly once and marks the item approved with the announcement", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x", commitsTo: "Friday" });

    let callCount = 0;
    const approved = approvePendingAction(storePath, PASSPHRASE, pending.id, () => { callCount += 1; }, "Approved: assign Jamie, response by Friday.");
    expect(callCount).toBe(1);
    expect(approved.status).toBe("approved");
    expect(approved.announcement).toMatch(/response by Friday/i);
  });

  it("throws for an unknown id, never calling execute", () => {
    const storePath = initStore();
    let called = false;
    expect(() => approvePendingAction(storePath, PASSPHRASE, "no-such-id", () => { called = true; }, "x")).toThrow(NoPendingActionError);
    expect(called).toBe(false);
  });

  it("refuses to approve the same item twice", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x" });
    approvePendingAction(storePath, PASSPHRASE, pending.id, () => {}, "x");
    expect(() => approvePendingAction(storePath, PASSPHRASE, pending.id, () => {}, "x")).toThrow(PendingActionNotPendingError);
  });
});

describe("An unapproved action expires rather than executing (#59 AC2)", () => {
  it("expirePendingActions sweeps a past-window item to expired, and never runs anything", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x", expiresInHours: -1 }); // already in the past

    const expired = expirePendingActions(storePath, PASSPHRASE);
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(pending.id);
    expect(getPendingAction(storePath, PASSPHRASE, pending.id)?.status).toBe("expired");
  });

  it("never sweeps an item still within its window", () => {
    const storePath = initStore();
    registerT3(storePath);
    prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x" }); // default 24h, well in the future
    expect(expirePendingActions(storePath, PASSPHRASE)).toEqual([]);
  });

  it("an approval that arrives after the window has passed is turned into an expiry, never a late execution — even without a prior sweep", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x", expiresInHours: -1 });

    let called = false;
    expect(() => approvePendingAction(storePath, PASSPHRASE, pending.id, () => { called = true; }, "x")).toThrow(PendingActionExpiredError);
    expect(called).toBe(false);
    expect(getPendingAction(storePath, PASSPHRASE, pending.id)?.status).toBe("expired");
  });
});

describe("A commitment is announced and retractable (#59 AC3)", () => {
  it("retractApprovedAction calls retract exactly once and marks the item retracted, keeping its approval timestamp intact", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x", commitsTo: "Friday" });
    const approved = approvePendingAction(storePath, PASSPHRASE, pending.id, () => {}, "Committed to Friday.");

    let retractCount = 0;
    const retracted = retractApprovedAction(storePath, PASSPHRASE, pending.id, () => { retractCount += 1; });
    expect(retractCount).toBe(1);
    expect(retracted.status).toBe("retracted");
    expect(retracted.resolvedAt).toBe(approved.resolvedAt);
    expect(retracted.retractedAt).not.toBeNull();
  });

  it("refuses to retract something never approved", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x" });
    expect(() => retractApprovedAction(storePath, PASSPHRASE, pending.id, () => {})).toThrow(PendingActionNotApprovedError);
  });

  it("refuses to retract the same commitment twice", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "x" });
    approvePendingAction(storePath, PASSPHRASE, pending.id, () => {}, "x");
    retractApprovedAction(storePath, PASSPHRASE, pending.id, () => {});
    expect(() => retractApprovedAction(storePath, PASSPHRASE, pending.id, () => {})).toThrow(PendingActionNotApprovedError);
  });
});

describe("Approval fatigue is visible (#59 AC4)", () => {
  it("reports 0, never NaN, when nothing has been staged yet", () => {
    const storePath = initStore();
    expect(getApprovalStats(storePath, PASSPHRASE)).toEqual({ totalCreated: 0, pendingCount: 0, approvedCount: 0, expiredCount: 0, retractedCount: 0, approvalRate: 0 });
  });

  it("counts every status, and the rate reflects only what has left pending", () => {
    const storePath = initStore();
    registerT3(storePath);
    const approved = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "a" });
    approvePendingAction(storePath, PASSPHRASE, approved.id, () => {}, "x");
    prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "b", expiresInHours: -1 });
    expirePendingActions(storePath, PASSPHRASE);
    prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "c" }); // still pending

    const stats = getApprovalStats(storePath, PASSPHRASE);
    expect(stats).toEqual({ totalCreated: 3, pendingCount: 1, approvedCount: 1, expiredCount: 1, retractedCount: 0, approvalRate: 0.5 });
  });

  it("a later retraction doesn't change the approval rate that was already earned", () => {
    const storePath = initStore();
    registerT3(storePath);
    const pending = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "a" });
    approvePendingAction(storePath, PASSPHRASE, pending.id, () => {}, "x");
    retractApprovedAction(storePath, PASSPHRASE, pending.id, () => {});

    const stats = getApprovalStats(storePath, PASSPHRASE);
    // Current status moved from "approved" to "retracted" (that's the
    // whole point of tracking it) — but the item was genuinely approved
    // before it was retracted, so the rate still counts it as such.
    expect(stats.approvedCount).toBe(0);
    expect(stats.retractedCount).toBe(1);
    expect(stats.approvalRate).toBe(1);
  });
});

describe("listPendingActions — narrowed to one status", () => {
  it("filters correctly", () => {
    const storePath = initStore();
    registerT3(storePath);
    prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "a" });
    const toApprove = prepareBindingAction(storePath, PASSPHRASE, { actionId: "assign-owner", topicId: "topic-a", reasoning: "b" });
    approvePendingAction(storePath, PASSPHRASE, toApprove.id, () => {}, "x");

    expect(listPendingActions(storePath, PASSPHRASE, "pending")).toHaveLength(1);
    expect(listPendingActions(storePath, PASSPHRASE, "approved")).toHaveLength(1);
  });
});
