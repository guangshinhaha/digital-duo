import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { IngestOutcome } from "./two-phase.js";

/**
 * One row per completed `ingestRecords` run (#175: "when did the last
 * import run"). Before this table, the IngestOutcome an import returned
 * existed only in the caller's process — once printed, it was gone, so
 * "what did the last import do and when" was unanswerable afterwards.
 *
 * Deliberately append-only and run-scoped: it records what one batch did,
 * not a rolling summary, so the counts are the counts that run reported —
 * never re-derived, never updated in place.
 */
export interface ImportRun {
  /** When the run completed (ISO timestamp, millisecond precision). */
  readonly runAt: string;
  readonly staged: number;
  readonly written: number;
  readonly alreadyPresent: number;
  readonly skippedDmConversations: number;
  readonly discardedOtherText: number;
  readonly discardedAboveCeiling: number;
}

/** Creates the import_runs table if it doesn't exist yet — same self-migrating discipline as every other `ensure*Schema`. */
export function ensureImportRunsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_runs (
      run_at TEXT NOT NULL,
      staged INTEGER NOT NULL,
      written INTEGER NOT NULL,
      already_present INTEGER NOT NULL,
      skipped_dm_conversations INTEGER NOT NULL,
      discarded_other_text INTEGER NOT NULL,
      discarded_above_ceiling INTEGER NOT NULL
    ) STRICT
  `);
}

interface ImportRunRow {
  run_at: string;
  staged: number;
  written: number;
  already_present: number;
  skipped_dm_conversations: number;
  discarded_other_text: number;
  discarded_above_ceiling: number;
}

function rowToRun(row: ImportRunRow): ImportRun {
  return {
    runAt: row.run_at,
    staged: row.staged,
    written: row.written,
    alreadyPresent: row.already_present,
    skippedDmConversations: row.skipped_dm_conversations,
    discardedOtherText: row.discarded_other_text,
    discardedAboveCeiling: row.discarded_above_ceiling,
  };
}

/**
 * Records a completed run on an already-open handle. Called by
 * `ingestRecords` itself, in its own `withDatabase` write *after* phase B's
 * write has succeeded — so the run row is advisory statistics, not
 * correctness state: a crash between phase B and here loses only the run
 * record, never a retained record. Nothing else writes this table.
 */
export function recordImportRunOnHandle(db: Database, outcome: IngestOutcome): void {
  ensureImportRunsSchema(db);
  db.prepare(`
    INSERT INTO import_runs (run_at, staged, written, already_present, skipped_dm_conversations, discarded_other_text, discarded_above_ceiling)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    outcome.staged,
    outcome.written,
    outcome.alreadyPresent,
    outcome.skippedDmConversations,
    outcome.discardedOtherText,
    outcome.discardedAboveCeiling,
  );
}

/** The most recent completed run, or null when this store has never seen an import. */
export function getLastImportRun(storePath: string, passphrase: string): ImportRun | null {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureImportRunsSchema(db);
    // rowid as the tiebreaker: two runs in the same millisecond still read
    // back in the order they were written.
    const row = db
      .prepare(`SELECT * FROM import_runs ORDER BY run_at DESC, rowid DESC LIMIT 1`)
      .get() as ImportRunRow | undefined;
    return row ? rowToRun(row) : null;
  });
}
