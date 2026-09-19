import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { appendActionAttempt, ensureActionAttemptLogSchema } from "./attempt-log.js";
import { createPendingActionRow, ensurePendingActionsSchema, type PendingAction } from "./approvals.js";
import { ensureActionRegistrySchema, getActionRow } from "./registry.js";
import { ensureTrustSchema, getCellRow } from "../trust/grid.js";
import { readTopicsFile } from "../derivation/topics.js";

/**
 * T2 from `docs/concept.md` §6: "Post a link, label, triage, tentative
 * hold, route ... One-click undo, duo announces what it did." #58's own
 * story: the small mechanical, procedural things a colleague's question
 * has a real answer to, run without asking each time once granted, always
 * announced, always undoable.
 */

export class NotAT2ActionError extends Error {
  constructor(actionId: string) {
    super(`"${actionId}" did not resolve to a T2 (reversible-internal) action.`);
    this.name = "NotAT2ActionError";
  }
}

export const REVERSIBLE_ACTION_STATUSES = ["active", "reverted", "failed"] as const;
export type ReversibleActionStatus = (typeof REVERSIBLE_ACTION_STATUSES)[number];

export interface ReversibleActionRecord {
  readonly id: string;
  readonly actionId: string;
  readonly topicId: string;
  readonly description: string;
  readonly performedAt: string;
  readonly revertedAt: string | null;
  readonly status: ReversibleActionStatus;
}

interface ReversibleActionRow {
  id: string;
  action_id: string;
  topic_id: string;
  description: string;
  performed_at: string;
  reverted_at: string | null;
  status: string;
}

function rowToRecord(row: ReversibleActionRow): ReversibleActionRecord {
  return { id: row.id, actionId: row.action_id, topicId: row.topic_id, description: row.description, performedAt: row.performed_at, revertedAt: row.reverted_at, status: row.status as ReversibleActionStatus };
}

/** Created on demand, matching every other table in this codebase. Not append-only — `reverted_at`/`status` legitimately move exactly once, via `undoReversibleAction` alone. */
function ensureReversibleLogSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reversible_actions (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      description TEXT NOT NULL,
      performed_at TEXT NOT NULL,
      reverted_at TEXT,
      status TEXT NOT NULL
    ) STRICT
  `);
}

export type PerformReversibleOutcome =
  | { readonly status: "performed"; readonly record: ReversibleActionRecord; readonly announcement: string }
  | { readonly status: "escalated"; readonly pendingAction: PendingAction; readonly reason: string }
  | { readonly status: "failed"; readonly record: ReversibleActionRecord; readonly error: string };

export interface PerformReversibleActionInput {
  readonly actionId: string;
  readonly topicId: string;
  /** What the action does, in plain words — becomes both the announcement and the escalation's reasoning. */
  readonly description: string;
  /** Whether *this particular target* can actually be reverted — a runtime fact about the specific instance, independent of the action's own T2 registration (AC3: a T2-registered action can still turn out not to be revertible here). */
  readonly canRevertHere: boolean;
  /** The actual side effect. Called at most once, only once every gate below has passed. */
  readonly perform: () => void;
  /** Best-effort compensation if `perform` throws partway (AC4) — this module cannot know what a partial effect looks like for an arbitrary action, so it can only invoke what the caller supplies. */
  readonly rollbackPartial?: () => void;
}

/**
 * Runs a T2 action if — and only if — it is genuinely registered T2, the
 * trust grid has granted `"auto"` for this topic, and the caller attests
 * the target can actually be reverted here. Any of those failing routes to
 * an escalation rather than running: a target that can't be reverted here
 * escalates as a T3 pending action (AC3 — "escalated as T3 instead"), not
 * granted-yet-for-this-topic escalates as a T2 one instead. A failure
 * partway rolls back what it can, records the failure (never silently),
 * and reports it rather than leaving `perform`'s partial effect unaccounted
 * for (AC4).
 */
type PerformReversibleResult = { readonly ok: true; readonly outcome: PerformReversibleOutcome } | { readonly ok: false };

/**
 * As with #60's `createT4Request`: `withDatabase` only persists a
 * mutation when its callback *returns*, so a refusal that needs its
 * attempt-log entry to survive can never throw from inside the callback —
 * it returns `{ ok: false }` (after the log entry is already written and
 * about to persist), and `performReversibleAction` throws only once that
 * call has returned.
 */
export function performReversibleAction(storePath: string, passphrase: string, duoDir: string, input: PerformReversibleActionInput): PerformReversibleOutcome {
  const result = withDatabase(storePath, passphrase, true, (db): PerformReversibleResult => {
    ensureActionRegistrySchema(db);
    ensureTrustSchema(db);
    ensureActionAttemptLogSchema(db);
    ensurePendingActionsSchema(db);
    ensureReversibleLogSchema(db);

    const action = getActionRow(db, input.actionId);
    if (!action || action.tier !== "T2") {
      appendActionAttempt(db, {
        actionId: input.actionId,
        topicId: input.topicId,
        tier: action?.tier ?? null,
        outcome: "refused_unregistered",
        detail: { reason: action ? "action is not classified T2" : "action is not registered" },
      });
      return { ok: false };
    }

    if (!input.canRevertHere) {
      const pendingAction = createPendingActionRow(db, {
        actionId: input.actionId,
        topicId: input.topicId,
        tier: "T3",
        reasoning: `Registered as T2 but not reversible here: ${input.description}`,
      });
      appendActionAttempt(db, { actionId: input.actionId, topicId: input.topicId, tier: "T2", outcome: "escalated", detail: { pendingActionId: pendingAction.id, reason: "not_revertible_here" } });
      return { ok: true, outcome: { status: "escalated", pendingAction, reason: "Not reversible here — escalated as a binding (T3) action instead of running unrecoverably." } };
    }

    const topicExists = readTopicsFile(duoDir).some((topic) => topic.id === input.topicId);
    const cell = getCellRow(db, input.topicId, "T2");
    const level = !cell || !topicExists ? "ask" : cell.level;

    if (level !== "auto") {
      const pendingAction = createPendingActionRow(db, { actionId: input.actionId, topicId: input.topicId, tier: "T2", reasoning: input.description });
      appendActionAttempt(db, { actionId: input.actionId, topicId: input.topicId, tier: "T2", outcome: "escalated", detail: { pendingActionId: pendingAction.id, reason: "not_yet_autonomous" } });
      return { ok: true, outcome: { status: "escalated", pendingAction, reason: "T2 autonomy not yet granted for this topic — awaiting approval." } };
    }

    const id = randomUUID();
    const performedAt = new Date().toISOString();
    try {
      input.perform();
    } catch (error) {
      input.rollbackPartial?.();
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`INSERT INTO reversible_actions (id, action_id, topic_id, description, performed_at, reverted_at, status) VALUES (?, ?, ?, ?, ?, NULL, 'failed')`).run(
        id,
        input.actionId,
        input.topicId,
        input.description,
        performedAt,
      );
      appendActionAttempt(db, { actionId: input.actionId, topicId: input.topicId, tier: "T2", outcome: "execution_failed", detail: { error: message, description: input.description } });
      return {
        ok: true,
        outcome: { status: "failed", record: { id, actionId: input.actionId, topicId: input.topicId, description: input.description, performedAt, revertedAt: null, status: "failed" }, error: message },
      };
    }

    db.prepare(`INSERT INTO reversible_actions (id, action_id, topic_id, description, performed_at, reverted_at, status) VALUES (?, ?, ?, ?, ?, NULL, 'active')`).run(
      id,
      input.actionId,
      input.topicId,
      input.description,
      performedAt,
    );
    appendActionAttempt(db, { actionId: input.actionId, topicId: input.topicId, tier: "T2", outcome: "resolved", detail: { reversibleActionId: id } });
    return {
      ok: true,
      outcome: {
        status: "performed",
        record: { id, actionId: input.actionId, topicId: input.topicId, description: input.description, performedAt, revertedAt: null, status: "active" },
        announcement: `Did it: ${input.description}. Undo with \`duo actions undo ${id}\`.`,
      },
    };
  });

  if (!result.ok) {
    throw new NotAT2ActionError(input.actionId);
  }
  return result.outcome;
}

export class ReversibleActionNotFoundError extends Error {
  constructor(id: string) {
    super(`No reversible action with id "${id}".`);
    this.name = "ReversibleActionNotFoundError";
  }
}

export class CannotUndoError extends Error {
  constructor(id: string, status: ReversibleActionStatus) {
    super(`Reversible action "${id}" is "${status}", not "active" — it cannot be undone.`);
    this.name = "CannotUndoError";
  }
}

/**
 * Undoes an active reversible action: `revert` is the only call site of
 * whatever restores the prior state (this module has no domain knowledge
 * of what that means for an arbitrary action), invoked exactly once, only
 * for a record that is still `"active"`. The thread reflects the reversal
 * via the record's own `status`/`revertedAt` from here on (AC2 — "the
 * thread reflects the reversal, and the action is recorded as reverted").
 */
export function undoReversibleAction(storePath: string, passphrase: string, id: string, revert: () => void): ReversibleActionRecord {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureReversibleLogSchema(db);
    const row = db.prepare(`SELECT * FROM reversible_actions WHERE id = ?`).get(id) as ReversibleActionRow | undefined;
    if (!row) {
      throw new ReversibleActionNotFoundError(id);
    }
    if (row.status !== "active") {
      throw new CannotUndoError(id, row.status as ReversibleActionStatus);
    }

    revert();

    const revertedAt = new Date().toISOString();
    db.prepare(`UPDATE reversible_actions SET reverted_at = ?, status = 'reverted' WHERE id = ?`).run(revertedAt, id);
    return { ...rowToRecord(row), revertedAt, status: "reverted" };
  });
}

export function getReversibleAction(storePath: string, passphrase: string, id: string): ReversibleActionRecord | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureReversibleLogSchema(db);
    const row = db.prepare(`SELECT * FROM reversible_actions WHERE id = ?`).get(id) as ReversibleActionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  });
}

export function listReversibleActions(storePath: string, passphrase: string): ReversibleActionRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureReversibleLogSchema(db);
    const rows = db.prepare(`SELECT * FROM reversible_actions ORDER BY performed_at ASC`).all() as unknown as ReversibleActionRow[];
    return rows.map(rowToRecord);
  });
}
