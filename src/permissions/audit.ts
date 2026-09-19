import { randomUUID } from "node:crypto";
import type { ClassificationLevel, RecordClassification } from "../ingest/record.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { ExclusionReason } from "./retrieval.js";

/** One record #50's permission filter kept out of an answer, and why — carried into the audit entry so the exclusion itself is reconstructible later. */
export interface AuditExcludedRecord {
  readonly id: string;
  readonly classification: RecordClassification;
  readonly reason: ExclusionReason;
}

/**
 * A coarse, honest signal about how an answer was produced — not a
 * calibrated probability (that's a later epic's job; v1-tech-design.md's
 * eval work hasn't landed yet). `"low"` for a decline (there was nothing
 * to be confident about), `"degraded"` when retrieval fell back to
 * full-text-only (the embedding channel was unavailable — see #20's
 * hybridSearch), `"high"` otherwise.
 */
export const AUDIT_CONFIDENCE_LEVELS = ["low", "degraded", "high"] as const;
export type AuditConfidence = (typeof AUDIT_CONFIDENCE_LEVELS)[number];

/**
 * What one call to answerForAsker writes. `rulesUsed` starts always `[]`
 * — the answering built in #50 draws on raw retrieved records, not
 * derived rules, so there is honestly nothing to name yet; the field
 * exists now (same "field present, logic deferred" idiom #18/#23 used for
 * `classification`/`topic_id`) so a later, rule-driven answering epic
 * needs no schema migration to start populating it. `correctsEntryId` is
 * how a correction is recorded (#51 AC2): set it to point at the entry
 * being corrected rather than mutating that entry — there is no function
 * anywhere in this module that could do the latter.
 */
export interface AuditEntryInput {
  readonly question: string;
  readonly askerRef: string;
  readonly askerResolved: boolean;
  readonly clearanceApplied: ClassificationLevel;
  readonly recordsUsed: readonly string[];
  readonly recordsExcluded: readonly AuditExcludedRecord[];
  readonly rulesUsed: readonly string[];
  readonly confidence: AuditConfidence;
  readonly declined: boolean;
  readonly answerText: string;
  /** Set only when this entry corrects an earlier one; the earlier entry is left exactly as written. */
  readonly correctsEntryId?: string | null;
}

/** The full, reconstructible shape a read returns — #51 AC1: "they see the question, the asker, the rules and records used, the confidence, the classification ceiling, and the exact text sent." */
export interface AuditEntry extends AuditEntryInput {
  readonly id: string;
  readonly createdAt: string;
}

interface AuditRow {
  id: string;
  created_at: string;
  question: string;
  asker_ref: string;
  asker_resolved: number;
  clearance_applied: string;
  records_used: string;
  records_excluded: string;
  rules_used: string;
  confidence: string;
  declined: number;
  answer_text: string;
  corrects_entry_id: string | null;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    question: row.question,
    askerRef: row.asker_ref,
    askerResolved: row.asker_resolved === 1,
    clearanceApplied: row.clearance_applied as ClassificationLevel,
    recordsUsed: JSON.parse(row.records_used) as string[],
    recordsExcluded: JSON.parse(row.records_excluded) as AuditExcludedRecord[],
    rulesUsed: JSON.parse(row.rules_used) as string[],
    confidence: row.confidence as AuditConfidence,
    declined: row.declined === 1,
    answerText: row.answer_text,
    correctsEntryId: row.corrects_entry_id,
  };
}

/**
 * Created on demand, matching every other table in this codebase
 * (ensureRecordsSchema et al.) rather than only at `duo init`. The two
 * triggers are the actual enforcement behind #51 AC2 ("an attempt to
 * alter it via any surface... is refused") — not just an absent function,
 * but a database-level refusal that holds even against a future bug in
 * this codebase that tries to update or delete a row, not only against
 * a hypothetical external tool.
 */
export function ensureAuditSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      question TEXT NOT NULL,
      asker_ref TEXT NOT NULL,
      asker_resolved INTEGER NOT NULL,
      clearance_applied TEXT NOT NULL,
      records_used TEXT NOT NULL,
      records_excluded TEXT NOT NULL,
      rules_used TEXT NOT NULL,
      confidence TEXT NOT NULL,
      declined INTEGER NOT NULL,
      answer_text TEXT NOT NULL,
      corrects_entry_id TEXT
    ) STRICT
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_append_only_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only: record a correction as a new entry, never edit an existing one');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_append_only_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only: entries are never deleted');
    END
  `);
}

/**
 * Appends one audit entry and returns its id. Deliberately the only write
 * this module offers — there is no update function anywhere in it (and
 * the schema's own triggers refuse one at the database level too), which
 * is what makes the log append-only.
 */
export function appendAuditEntry(storePath: string, passphrase: string, input: AuditEntryInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureAuditSchema(db);
    db.prepare(
      `
      INSERT INTO audit_log
        (id, created_at, question, asker_ref, asker_resolved, clearance_applied, records_used, records_excluded, rules_used, confidence, declined, answer_text, corrects_entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      createdAt,
      input.question,
      input.askerRef,
      input.askerResolved ? 1 : 0,
      input.clearanceApplied,
      JSON.stringify(input.recordsUsed),
      JSON.stringify(input.recordsExcluded),
      JSON.stringify(input.rulesUsed),
      input.confidence,
      input.declined ? 1 : 0,
      input.answerText,
      input.correctsEntryId ?? null,
    );
  });
  return id;
}

/**
 * Records a correction as a brand-new entry referencing the one it
 * corrects, rather than touching that entry at all (#51 AC2). A thin,
 * clearly-named wrapper over appendAuditEntry so "how a correction is
 * recorded" is a named, discoverable operation rather than something a
 * caller has to remember to do by setting a field correctly.
 */
export function appendCorrection(
  storePath: string,
  passphrase: string,
  correctedEntryId: string,
  input: Omit<AuditEntryInput, "correctsEntryId">,
): string {
  return appendAuditEntry(storePath, passphrase, { ...input, correctsEntryId: correctedEntryId });
}

/** One audit entry by id, or undefined — the "owner opens the audit log" reconstruction read (#51 AC1). */
export function getAuditEntry(storePath: string, passphrase: string, id: string): AuditEntry | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureAuditSchema(db);
    const row = db.prepare(`SELECT * FROM audit_log WHERE id = ?`).get(id) as AuditRow | undefined;
    return row ? rowToEntry(row) : undefined;
  });
}

/** Every audit entry, oldest first — a full enumeration for the owner's own review, not a paginated or filtered query (the log is owner-only per #51's scope). */
export function listAuditEntries(storePath: string, passphrase: string): AuditEntry[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureAuditSchema(db);
    const rows = db.prepare(`SELECT * FROM audit_log ORDER BY created_at ASC, id ASC`).all() as unknown as AuditRow[];
    return rows.map(rowToEntry);
  });
}
