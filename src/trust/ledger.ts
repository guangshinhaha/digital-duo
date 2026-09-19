import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { TrustTier } from "./grid.js";

/**
 * Every mutation the trust grid ever makes to a cell is justified by one of
 * these, appended alongside it in the same write transaction. Mirrors
 * `src/permissions/audit.ts`'s append-only pattern (insert-only export, plus
 * DB-level `BEFORE UPDATE`/`BEFORE DELETE` triggers that refuse to touch a
 * row once written) rather than that module's answer-shaped schema — a
 * demotion or a grant isn't an answer, and forcing one into `audit_log`'s
 * columns (which include a `clearanceApplied` classification value that has
 * no meaning for a trust event) would fabricate data rather than record it.
 * This ledger is the trust epic's own audit trail, purpose-built for its
 * own event shape.
 */
export const TRUST_LEDGER_EVENT_TYPES = ["instance", "granted", "promotion_accepted", "promotion_declined", "demoted"] as const;
export type TrustLedgerEventType = (typeof TRUST_LEDGER_EVENT_TYPES)[number];

export interface TrustLedgerEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly topicId: string;
  readonly tier: TrustTier;
  readonly eventType: TrustLedgerEventType;
  /** Event-specific details (e.g. a grant's source text, a demotion's correctionRef) — deliberately untyped here so each writer's own module documents its own shape. */
  readonly detail: Record<string, unknown>;
}

interface TrustLedgerRow {
  id: string;
  created_at: string;
  topic_id: string;
  tier: string;
  event_type: string;
  detail: string;
}

function rowToEntry(row: TrustLedgerRow): TrustLedgerEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    topicId: row.topic_id,
    tier: row.tier as TrustTier,
    eventType: row.event_type as TrustLedgerEventType,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  };
}

/** Created on demand, matching every other table in this codebase. The two triggers are the actual enforcement (not just an absent update/delete export) behind this being append-only, following #51's `ensureAuditSchema` precedent exactly. */
export function ensureTrustLedgerSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_ledger (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trust_ledger_append_only_no_update
    BEFORE UPDATE ON trust_ledger
    BEGIN
      SELECT RAISE(ABORT, 'trust_ledger is append-only: record a new event, never edit an existing one');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trust_ledger_append_only_no_delete
    BEFORE DELETE ON trust_ledger
    BEGIN
      SELECT RAISE(ABORT, 'trust_ledger is append-only: entries are never deleted');
    END
  `);
}

/**
 * Appends one ledger entry and returns its id. Deliberately the only write
 * this module offers, taking an already-open `db` so a caller (grants,
 * promotion, demotion) can append it inside the same `withDatabase`
 * transaction as the cell mutation it justifies — never as a separate,
 * potentially-inconsistent write.
 */
export function appendLedgerEntry(
  db: Database,
  input: { topicId: string; tier: TrustTier; eventType: TrustLedgerEventType; detail: Record<string, unknown> },
): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO trust_ledger (id, created_at, topic_id, tier, event_type, detail) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, createdAt, input.topicId, input.tier, input.eventType, JSON.stringify(input.detail));
  return id;
}

/** Every ledger entry, oldest first, optionally narrowed to one cell — the owner-facing "why did this cell move" reconstruction read. */
export function listLedgerEntries(
  storePath: string,
  passphrase: string,
  filter?: { topicId: string; tier: TrustTier },
): TrustLedgerEntry[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTrustLedgerSchema(db);
    const rows = filter
      ? (db
          .prepare(`SELECT * FROM trust_ledger WHERE topic_id = ? AND tier = ? ORDER BY created_at ASC, id ASC`)
          .all(filter.topicId, filter.tier) as unknown as TrustLedgerRow[])
      : (db.prepare(`SELECT * FROM trust_ledger ORDER BY created_at ASC, id ASC`).all() as unknown as TrustLedgerRow[]);
    return rows.map(rowToEntry);
  });
}
