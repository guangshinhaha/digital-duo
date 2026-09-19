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
 * #58 introduces this module with only what its own escalation path needs
 * (create + list). #59 extends it with the owner's approve/expire/retract
 * actions and the approval-fatigue digest — see that module's own history
 * for why: the two issues share one mechanism rather than each inventing
 * its own pending-item table.
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
  readonly resolvedAt: string | null;
  /** Set only once approved — the "stated in thread as made by the duo on the owner's behalf" text (#59 AC3). */
  readonly announcement: string | null;
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
      announcement TEXT
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
    `INSERT INTO pending_actions (id, action_id, topic_id, tier, reasoning, commits_to, created_at, expires_at, status, resolved_at, announcement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
  ).run(id, input.actionId, input.topicId, input.tier, input.reasoning, input.commitsTo ?? null, createdAt, input.expiresAt ?? null);
  return { id, actionId: input.actionId, topicId: input.topicId, tier: input.tier, reasoning: input.reasoning, commitsTo: input.commitsTo ?? null, createdAt, expiresAt: input.expiresAt ?? null, status: "pending", resolvedAt: null, announcement: null };
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
