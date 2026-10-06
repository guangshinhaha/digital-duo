import { getRecord } from "../ingest/record-store.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * Issue duo#272: the owner removing a bad "past exchange" source from a
 * draft's Why panel must stop that record being cited again, not just hide
 * it from the one draft already shown. This table is the record of that
 * decision — separate from `records` itself (the record stays in the
 * corpus, searchable and importable, exactly as `deleteRecords` is for
 * actually erasing it) and separate from `rejected rule` (a rule's own
 * review status already carries that, see `derivation/rule-review.ts`).
 *
 * Reversible by design (the same shape as a rule's reject/approve): the
 * owner can restore an exclusion from the Knows tab if they change their
 * mind, same as "Set aside" rules can be approved again.
 */
export function ensureEvidenceExclusionsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_exclusions (
      record_id TEXT PRIMARY KEY,
      excluded_at TEXT NOT NULL
    ) STRICT
  `);
}

/** One record the owner said never to draw on again, as the Knows tab lists it. */
export interface ExcludedEvidence {
  readonly recordId: string;
  readonly excludedAt: string;
  /**
   * The record's own text, truncated the same way a draft's source label
   * is (80 chars) — or null when the record itself is gone (deleted, or
   * never in this store to begin with), in which case the exclusion still
   * holds: a record re-imported later under the same id stays excluded
   * until the owner restores it.
   */
  readonly label: string | null;
}

const LABEL_MAX = 80;
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Sync, within an already-open connection — `gatherDraftContext` calls this alongside its other per-draft reads, never a separate round trip. */
export function listExcludedEvidenceIds(db: Database): ReadonlySet<string> {
  ensureEvidenceExclusionsSchema(db);
  const rows = db.prepare(`SELECT record_id FROM evidence_exclusions`).all() as { record_id: string }[];
  return new Set(rows.map((row) => row.record_id));
}

/** Idempotent: excluding an already-excluded record just refreshes nothing — the original `excludedAt` is kept, same as a rule reject does not re-stamp an already-rejected rule. */
export function excludeEvidence(storePath: string, passphrase: string, recordId: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureEvidenceExclusionsSchema(db);
    db.prepare(`INSERT OR IGNORE INTO evidence_exclusions (record_id, excluded_at) VALUES (?, ?)`).run(recordId, new Date().toISOString());
  });
}

/** Idempotent: restoring a record that was never excluded is a no-op, not an error — same shape as the rule actions. */
export function restoreEvidence(storePath: string, passphrase: string, recordId: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureEvidenceExclusionsSchema(db);
    db.prepare(`DELETE FROM evidence_exclusions WHERE record_id = ?`).run(recordId);
  });
}

/** What the Knows tab shows: every excluded record, newest exclusion first, with enough of its own text to recognise it — or an honest "gone" label when the record itself no longer exists. */
export function listExcludedEvidence(storePath: string, passphrase: string): ExcludedEvidence[] {
  const rows = withDatabase(storePath, passphrase, false, (db) => {
    ensureEvidenceExclusionsSchema(db);
    return db.prepare(`SELECT record_id, excluded_at FROM evidence_exclusions ORDER BY excluded_at DESC`).all() as {
      record_id: string;
      excluded_at: string;
    }[];
  });
  return rows.map((row) => {
    const record = getRecord(storePath, passphrase, row.record_id);
    return { recordId: row.record_id, excludedAt: row.excluded_at, label: record ? truncate(record.text, LABEL_MAX) : null };
  });
}
