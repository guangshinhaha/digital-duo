import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { GateReason } from "./relevance-gate.js";

/**
 * Every gate decision, whatever it was — #31's own acceptance criteria
 * requires this so precision (and, if ever wanted, recall) can be measured
 * later, including for the mentions the gate silently drops. Append-only in
 * spirit (nothing here exports an update/delete), same shape as #50/#51's
 * audit_log before it added its own DB-level triggers — this log doesn't
 * need that stronger guarantee, since nothing downstream depends on it for
 * a compliance record, only for the gate's own precision/recall.
 */
export interface GateDecisionEntry {
  readonly id: string;
  readonly mentionText: string;
  readonly from: string | null;
  readonly passes: boolean;
  readonly reason: GateReason;
  readonly createdAt: string;
}

export function ensureGateLogSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_decisions (
      id TEXT PRIMARY KEY,
      mention_text TEXT NOT NULL,
      mention_from TEXT,
      passes INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT
  `);
}

export interface AppendGateDecisionInput {
  readonly mentionText: string;
  readonly from?: string;
  readonly passes: boolean;
  readonly reason: GateReason;
}

/** Appends one gate decision and returns its id. */
export function appendGateDecision(storePath: string, passphrase: string, input: AppendGateDecisionInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureGateLogSchema(db);
    db.prepare(
      `INSERT INTO gate_decisions (id, mention_text, mention_from, passes, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.mentionText, input.from ?? null, input.passes ? 1 : 0, input.reason, createdAt);
  });
  return id;
}

interface GateDecisionRow {
  id: string;
  mention_text: string;
  mention_from: string | null;
  passes: number;
  reason: string;
  created_at: string;
}

function rowToEntry(row: GateDecisionRow): GateDecisionEntry {
  return {
    id: row.id,
    mentionText: row.mention_text,
    from: row.mention_from,
    passes: row.passes === 1,
    reason: row.reason as GateReason,
    createdAt: row.created_at,
  };
}

/** Every gate decision, oldest first — the trace #31's own acceptance criteria calls for. */
export function listGateDecisions(storePath: string, passphrase: string): GateDecisionEntry[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureGateLogSchema(db);
    const rows = db.prepare(`SELECT * FROM gate_decisions ORDER BY created_at, id`).all() as unknown as GateDecisionRow[];
    return rows.map(rowToEntry);
  });
}
