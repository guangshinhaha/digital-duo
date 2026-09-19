import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { ActionTier } from "./registry.js";

/**
 * The action epic's own audit trail — same purpose-built idiom
 * `src/trust/ledger.ts` uses over `src/permissions/audit.ts`'s answer-shaped
 * schema: an action attempt isn't a question/asker/classification event, so
 * forcing it into `audit_log`'s columns would fabricate data rather than
 * record it. `"refused_unregistered"` is #56 AC2 ("the attempt is logged");
 * `"requires_human_confirmation"` and `"refused_t4_bypass"` are #60 AC1/AC3
 * ("an attempt to bypass is refused and recorded... the owner is notified" —
 * this log, readable via `duo actions attempts`, is that notification
 * surface, the same "durable, owner-reviewable" idiom #69/#71 used where no
 * live push channel exists yet). `"escalated"` and `"execution_failed"`
 * are #58's T2 path: a reversible action that couldn't run autonomously
 * here (not yet granted, or not actually revertible in this context) or
 * that failed partway.
 */
export const ACTION_ATTEMPT_OUTCOMES = [
  "refused_unregistered",
  "resolved",
  "requires_human_confirmation",
  "refused_t4_bypass",
  "t4_executed",
  "escalated",
  "execution_failed",
] as const;
export type ActionAttemptOutcome = (typeof ACTION_ATTEMPT_OUTCOMES)[number];

export interface ActionAttemptEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly actionId: string;
  readonly topicId: string | null;
  readonly tier: ActionTier | null;
  readonly outcome: ActionAttemptOutcome;
  readonly detail: Record<string, unknown>;
}

interface ActionAttemptRow {
  id: string;
  created_at: string;
  action_id: string;
  topic_id: string | null;
  tier: string | null;
  outcome: string;
  detail: string;
}

function rowToEntry(row: ActionAttemptRow): ActionAttemptEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    actionId: row.action_id,
    topicId: row.topic_id,
    tier: row.tier as ActionTier | null,
    outcome: row.outcome as ActionAttemptOutcome,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  };
}

/** Created on demand, matching every other table in this codebase. Append-only via the same `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` trigger pattern `src/permissions/audit.ts`/`src/trust/ledger.ts` established — a database-level refusal, not just an absent update/delete export. */
export function ensureActionAttemptLogSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_attempts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      action_id TEXT NOT NULL,
      topic_id TEXT,
      tier TEXT,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS action_attempts_append_only_no_update
    BEFORE UPDATE ON action_attempts
    BEGIN
      SELECT RAISE(ABORT, 'action_attempts is append-only: record a new attempt, never edit an existing one');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS action_attempts_append_only_no_delete
    BEFORE DELETE ON action_attempts
    BEGIN
      SELECT RAISE(ABORT, 'action_attempts is append-only: entries are never deleted');
    END
  `);
}

/**
 * Appends one attempt entry using an already-open handle — mirrors
 * `appendLedgerEntry`'s shape rather than `appendAuditEntry`'s (which opens
 * its own), specifically so a caller already inside a `withDatabase(mutate:
 * true)` transaction (the registry's re-tiering, the T4 guard's
 * confirm-and-execute) can log in the *same* transaction instead of nesting
 * a second `withDatabase` call against the same file — #28's own review
 * finding, on the exact same class of bug, is the precedent for avoiding it
 * here from the start.
 */
export function appendActionAttempt(
  db: Database,
  input: { actionId: string; topicId: string | null; tier: ActionTier | null; outcome: ActionAttemptOutcome; detail: Record<string, unknown> },
): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO action_attempts (id, created_at, action_id, topic_id, tier, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, createdAt, input.actionId, input.topicId, input.tier, input.outcome, JSON.stringify(input.detail));
  return id;
}

/** Every attempt, oldest first — the owner opening the log (`duo actions attempts`). */
export function listActionAttempts(storePath: string, passphrase: string): ActionAttemptEntry[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureActionAttemptLogSchema(db);
    const rows = db.prepare(`SELECT * FROM action_attempts ORDER BY created_at ASC, id ASC`).all() as unknown as ActionAttemptRow[];
    return rows.map(rowToEntry);
  });
}
