import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { TrustTier } from "../trust/grid.js";

/**
 * The shared draft-and-approve queue T2 (#58, when an action turns out not
 * to be reversible here, or isn't yet granted "auto") and T3 (#59, every
 * binding action, always) both escalate into. `tier` is a `TrustTier`
 * (T0-T3), never T4 — a T4 action has its own, structurally separate gate
 * (`src/actions/t4-guard.ts`); this queue is "ask the owner once, then
 * proceed or don't," which is not the guarantee T4 needs.
 *
 * #58 introduced this module with only what its own escalation path needs
 * (create + list). #59 (this change) extends it with the owner's
 * approve/expire/retract actions and the approval-fatigue digest — the two
 * issues share one mechanism rather than each inventing its own
 * pending-item table.
 */

export const PENDING_ACTION_STATUSES = ["pending", "approved", "expired", "retracted"] as const;
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

export interface PendingAction {
  readonly id: string;
  readonly actionId: string;
  readonly topicId: string;
  readonly tier: TrustTier;
  readonly reasoning: string;
  /** Set only for a T3 commitment (#59 AC3) — a plain description of what the owner is being committed to (a date, a deliverable). Null for a T2 escalation, which commits to nothing. */
  readonly commitsTo: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly status: PendingActionStatus;
  /** When the item left "pending" — approved or expired. Never set for a later retraction, which has its own timestamp (see `retractedAt`), since a retraction is a distinct event after an approval, not the same resolution happening twice. */
  readonly resolvedAt: string | null;
  /** Set only once approved — the "stated in thread as made by the duo on the owner's behalf" text (#59 AC3). */
  readonly announcement: string | null;
  /** Set only when an approved commitment is later retracted (#59 AC3) — kept separate from `resolvedAt` so both "when approved" and "when retracted" stay visible. */
  readonly retractedAt: string | null;
}

interface PendingActionRow {
  id: string;
  action_id: string;
  topic_id: string;
  tier: string;
  reasoning: string;
  commits_to: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
  resolved_at: string | null;
  announcement: string | null;
  retracted_at: string | null;
}

function rowToPendingAction(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    actionId: row.action_id,
    topicId: row.topic_id,
    tier: row.tier as TrustTier,
    reasoning: row.reasoning,
    commitsTo: row.commits_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as PendingActionStatus,
    resolvedAt: row.resolved_at,
    announcement: row.announcement,
    retractedAt: row.retracted_at,
  };
}

/** Created on demand, matching every other table in this codebase. */
export function ensurePendingActionsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('T0', 'T1', 'T2', 'T3')),
      reasoning TEXT NOT NULL,
      commits_to TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL,
      resolved_at TEXT,
      announcement TEXT,
      retracted_at TEXT
    ) STRICT
  `);
}

export interface CreatePendingActionInput {
  readonly actionId: string;
  readonly topicId: string;
  readonly tier: TrustTier;
  readonly reasoning: string;
  readonly commitsTo?: string | null;
  readonly expiresAt?: string | null;
}

/**
 * The raw, db-taking primitive — takes an already-open handle so a caller
 * mid-transaction (`performReversibleAction`'s escalation path) can create
 * a pending action without nesting a second `withDatabase` against the
 * same file (the exact class of bug #28 found, and the same fix #56/#60
 * already applied throughout this epic).
 */
export function createPendingActionRow(db: Database, input: CreatePendingActionInput): PendingAction {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO pending_actions (id, action_id, topic_id, tier, reasoning, commits_to, created_at, expires_at, status, resolved_at, announcement, retracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
  ).run(id, input.actionId, input.topicId, input.tier, input.reasoning, input.commitsTo ?? null, createdAt, input.expiresAt ?? null);
  return {
    id,
    actionId: input.actionId,
    topicId: input.topicId,
    tier: input.tier,
    reasoning: input.reasoning,
    commitsTo: input.commitsTo ?? null,
    createdAt,
    expiresAt: input.expiresAt ?? null,
    status: "pending",
    resolvedAt: null,
    announcement: null,
    retractedAt: null,
  };
}

/** Stages a pending action from scratch (opens its own handle) — for a caller that isn't already inside a transaction. */
export function createPendingAction(storePath: string, passphrase: string, input: CreatePendingActionInput): PendingAction {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePendingActionsSchema(db);
    return createPendingActionRow(db, input);
  });
}

export function getPendingAction(storePath: string, passphrase: string, id: string): PendingAction | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePendingActionsSchema(db);
    const row = db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as PendingActionRow | undefined;
    return row ? rowToPendingAction(row) : undefined;
  });
}

/** Every pending action, oldest first, optionally narrowed to one status. */
export function listPendingActions(storePath: string, passphrase: string, status?: PendingActionStatus): PendingAction[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePendingActionsSchema(db);
    const rows = status
      ? (db.prepare(`SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at ASC`).all(status) as unknown as PendingActionRow[])
      : (db.prepare(`SELECT * FROM pending_actions ORDER BY created_at ASC`).all() as unknown as PendingActionRow[]);
    return rows.map(rowToPendingAction);
  });
}

export class NoPendingActionError extends Error {
  constructor(id: string) {
    super(`No pending action with id "${id}".`);
    this.name = "NoPendingActionError";
  }
}

export class PendingActionNotPendingError extends Error {
  constructor(id: string, status: PendingActionStatus) {
    super(`Pending action "${id}" is "${status}", not "pending" — it cannot be approved.`);
    this.name = "PendingActionNotPendingError";
  }
}

export class PendingActionExpiredError extends Error {
  constructor(id: string) {
    super(`Pending action "${id}" expired before this approval arrived — it has not executed.`);
    this.name = "PendingActionExpiredError";
  }
}

type ApprovePendingActionResult = { readonly ok: true; readonly action: PendingAction } | { readonly ok: false; readonly reason: "not_found" } | { readonly ok: false; readonly reason: "not_pending"; readonly status: PendingActionStatus } | { readonly ok: false; readonly reason: "expired" };

/**
 * The owner's one-tap approval (#59 AC1/AC3): "nothing happens until the
 * owner approves" — `execute` is the only side effect this function runs,
 * called at most once, only for an item still genuinely `"pending"` (never
 * a second time for one already approved, expired, or retracted).
 * `announcement` is recorded alongside the approval as the "stated in
 * thread as made by the duo on the owner's behalf" text (AC3).
 *
 * Checks expiry itself, inline — rather than only relying on a separate
 * sweep (`expirePendingActions`) having run recently — so AC2's guarantee
 * ("expires without executing") holds even for an approval that arrives
 * after the window has passed but before anything swept it: it is turned
 * into an expiry, not honoured as a late approval, and `execute` is never
 * called. As with #58/#60's own throw-from-inside-a-mutation fix,
 * `withDatabase` only persists a mutation when its callback returns, so
 * every early exit here returns a result rather than throwing — the throw
 * (and the error naming which case) happens once the transaction, and
 * whatever state change it recorded, has already committed.
 */
export function approvePendingAction(storePath: string, passphrase: string, id: string, execute: () => void, announcement: string): PendingAction {
  const result = withDatabase(storePath, passphrase, true, (db): ApprovePendingActionResult => {
    ensurePendingActionsSchema(db);
    const row = db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as PendingActionRow | undefined;
    if (!row) {
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "pending") {
      return { ok: false, reason: "not_pending", status: row.status as PendingActionStatus };
    }

    const now = new Date();
    if (row.expires_at !== null && row.expires_at <= now.toISOString()) {
      db.prepare(`UPDATE pending_actions SET status = 'expired', resolved_at = ? WHERE id = ?`).run(now.toISOString(), id);
      return { ok: false, reason: "expired" };
    }

    execute();

    const resolvedAt = now.toISOString();
    db.prepare(`UPDATE pending_actions SET status = 'approved', resolved_at = ?, announcement = ? WHERE id = ?`).run(resolvedAt, announcement, id);
    return { ok: true, action: { ...rowToPendingAction(row), status: "approved", resolvedAt, announcement } };
  });

  if (!result.ok) {
    if (result.reason === "not_found") throw new NoPendingActionError(id);
    if (result.reason === "expired") throw new PendingActionExpiredError(id);
    throw new PendingActionNotPendingError(id, result.status);
  }
  return result.action;
}

/**
 * Sweeps every `"pending"` item whose `expiresAt` has passed to
 * `"expired"` — never executing anything (#59 AC2: "expires without
 * executing"). The caller is expected to surface the underlying request in
 * its own digest afterward; this function's job is only the state
 * transition, not the notification.
 */
export function expirePendingActions(storePath: string, passphrase: string, now: Date = new Date()): PendingAction[] {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePendingActionsSchema(db);
    const nowIso = now.toISOString();
    const rows = db.prepare(`SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`).all(nowIso) as unknown as PendingActionRow[];
    const expired: PendingAction[] = [];
    for (const row of rows) {
      db.prepare(`UPDATE pending_actions SET status = 'expired', resolved_at = ? WHERE id = ?`).run(nowIso, row.id);
      expired.push({ ...rowToPendingAction(row), status: "expired", resolvedAt: nowIso });
    }
    return expired;
  });
}

export class PendingActionNotApprovedError extends Error {
  constructor(id: string, status: PendingActionStatus) {
    super(`Pending action "${id}" is "${status}", not "approved" — only an approved commitment can be retracted.`);
    this.name = "PendingActionNotApprovedError";
  }
}

/**
 * Retracts an already-approved commitment (#59 AC3: "the owner can
 * retract it from there"). `retract` is the only call site of whatever
 * undoes the commitment's real-world effect, invoked exactly once, only
 * for an item that is currently `"approved"` — an item still pending has
 * nothing to retract yet (it hasn't run), and one already retracted cannot
 * be retracted twice.
 */
export function retractApprovedAction(storePath: string, passphrase: string, id: string, retract: () => void): PendingAction {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePendingActionsSchema(db);
    const row = db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as PendingActionRow | undefined;
    if (!row) {
      throw new NoPendingActionError(id);
    }
    if (row.status !== "approved") {
      throw new PendingActionNotApprovedError(id, row.status as PendingActionStatus);
    }

    retract();

    const retractedAt = new Date().toISOString();
    db.prepare(`UPDATE pending_actions SET status = 'retracted', retracted_at = ? WHERE id = ?`).run(retractedAt, id);
    return { ...rowToPendingAction(row), status: "retracted", retractedAt };
  });
}

export interface ApprovalStats {
  readonly totalCreated: number;
  readonly pendingCount: number;
  readonly approvedCount: number;
  readonly expiredCount: number;
  readonly retractedCount: number;
  /** Of everything that ever left "pending" (approved or expired — a retraction happens later and doesn't change whether the original approval counted), the fraction that was approved. 0, never NaN, when nothing has been resolved yet — same "never NaN when unused" convention #71's usage report established. */
  readonly approvalRate: number;
}

/**
 * #59 AC4 ("approval fatigue is visible"): the raw counts and the
 * approval rate, so a topic generating constant approval requests can be
 * granted properly or revoked rather than quietly ignored. A plain count
 * over the whole table, not a windowed rate — #59 doesn't ask for a trend
 * the way #71's usage report does, only that the volume and rate are
 * reported at all.
 */
export function getApprovalStats(storePath: string, passphrase: string): ApprovalStats {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePendingActionsSchema(db);
    const countByStatus = (status: PendingActionStatus): number =>
      (db.prepare(`SELECT COUNT(*) as count FROM pending_actions WHERE status = ?`).get(status) as { count: number }).count;
    const totalCreated = (db.prepare(`SELECT COUNT(*) as count FROM pending_actions`).get() as { count: number }).count;
    const pendingCount = countByStatus("pending");
    const approvedCount = countByStatus("approved");
    const expiredCount = countByStatus("expired");
    const retractedCount = countByStatus("retracted");
    // A retracted item's *current* status is "retracted", not "approved"
    // — but it was approved before it was retracted, and the doc comment
    // on `approvalRate` promises retracting later "doesn't change whether
    // the original approval counted." So the rate's numerator is every
    // item ever approved (currently approved, plus currently retracted —
    // there is no third way to reach "retracted"), not just the ones
    // still sitting in "approved" today.
    const everApprovedCount = approvedCount + retractedCount;
    const resolvedCount = everApprovedCount + expiredCount;
    return { totalCreated, pendingCount, approvedCount, expiredCount, retractedCount, approvalRate: resolvedCount === 0 ? 0 : everApprovedCount / resolvedCount };
  });
}
