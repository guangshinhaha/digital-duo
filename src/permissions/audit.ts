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
 * What one call to answerForAsker writes. `rulesUsed` starts always `[]`
 * — the answering built in #50 draws on raw retrieved records, not
 * derived rules, so there is honestly nothing to name yet; the field
 * exists now (same "field present, logic deferred" idiom #18/#23 used for
 * `classification`/`topic_id`) so a later, rule-driven answering epic
 * needs no schema migration to start populating it.
 */
export interface AuditEntryInput {
  readonly question: string;
  readonly askerRef: string;
  readonly askerResolved: boolean;
  readonly clearanceApplied: ClassificationLevel;
  readonly recordsUsed: readonly string[];
  readonly recordsExcluded: readonly AuditExcludedRecord[];
  readonly rulesUsed: readonly string[];
  readonly declined: boolean;
  readonly answerText: string;
}

/** Created on demand, matching every other table in this codebase (ensureRecordsSchema et al.) rather than only at `duo init`. */
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
      declined INTEGER NOT NULL,
      answer_text TEXT NOT NULL
    ) STRICT
  `);
}

/**
 * Appends one audit entry and returns its id. Deliberately the only write
 * this module offers — there is no update or delete function anywhere in
 * it, which is what makes the log append-only: not a runtime check, but a
 * surface that was never built (#51 hardens and tests this explicitly).
 */
export function appendAuditEntry(storePath: string, passphrase: string, input: AuditEntryInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureAuditSchema(db);
    db.prepare(
      `
      INSERT INTO audit_log
        (id, created_at, question, asker_ref, asker_resolved, clearance_applied, records_used, records_excluded, rules_used, declined, answer_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.declined ? 1 : 0,
      input.answerText,
    );
  });
  return id;
}
