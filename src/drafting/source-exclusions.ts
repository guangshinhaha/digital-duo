import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { countRecordsBySource } from "../ingest/record-store.js";

/**
 * duo#278: the owner turning a whole source off from the Privacy settings
 * page — "stop using my Claude export" rather than one bad record at a
 * time. Same reviewable shape as duo#272's evidence_exclusions
 * (src/drafting/evidence-exclusions.ts), one level up: keyed by `source`
 * (the adapter's own string — "claude-export", "paste", "connector" —
 * never a value this module invents) instead of `record_id`. Deliberately
 * a second table rather than a flag column on each record: a record
 * imported later under an already-excluded source must come up excluded
 * without this module ever touching the records table, the same
 * "exclusion survives a re-import" guarantee evidence_exclusions already
 * gives per record.
 *
 * Soft by design, same as #272 and the off-the-record marker (duo#274):
 * excluding a source stops it being cited in any future draft
 * (gatherDraftContext's admissibility filter, alongside the per-record
 * exclusion check) without deleting a single record — the corpus copy
 * stays, searchable and importable, and the owner can restore a source
 * from the same screen if they change their mind.
 */
export function ensureSourceExclusionsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_exclusions (
      source TEXT PRIMARY KEY,
      excluded_at TEXT NOT NULL
    ) STRICT
  `);
}

/** One source the owner turned off, as the Privacy page lists it. */
export interface ExcludedSource {
  readonly source: string;
  readonly excludedAt: string;
}

/** Sync, within an already-open connection — gatherDraftContext calls this alongside its other per-draft reads, never a separate round trip. */
export function listExcludedSources(db: Database): ReadonlySet<string> {
  ensureSourceExclusionsSchema(db);
  const rows = db.prepare(`SELECT source FROM source_exclusions`).all() as { source: string }[];
  return new Set(rows.map((row) => row.source));
}

/** Idempotent: excluding an already-excluded source just refreshes nothing — the original excludedAt is kept, same as evidence-exclusions and a rule's reject. */
export function excludeSource(storePath: string, passphrase: string, source: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureSourceExclusionsSchema(db);
    db.prepare(`INSERT OR IGNORE INTO source_exclusions (source, excluded_at) VALUES (?, ?)`).run(source, new Date().toISOString());
  });
}

/** Idempotent: restoring a source that was never excluded is a no-op, not an error — same shape as restoreEvidence. */
export function restoreSource(storePath: string, passphrase: string, source: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureSourceExclusionsSchema(db);
    db.prepare(`DELETE FROM source_exclusions WHERE source = ?`).run(source);
  });
}

/**
 * Every source the Privacy page can offer a switch for — the union of
 * every source actually present in the corpus (`countRecordsBySource`,
 * the same GROUP BY the Knows tab's "What it has read" section reads) and
 * every source still excluded though its last record is gone, so turning
 * a source back on stays possible even after the corpus it covered has
 * been otherwise cleared out. Newest exclusion first for the excluded
 * ones; sources that were never excluded follow, in the order
 * countRecordsBySource reports them.
 */
export interface SourceControl {
  readonly source: string;
  /** Records currently in the corpus under this source — 0 for a source that is excluded but whose records are all gone. */
  readonly recordCount: number;
  readonly excluded: boolean;
  /** null when this source has never been excluded. */
  readonly excludedAt: string | null;
}

export function listSourceControls(storePath: string, passphrase: string): SourceControl[] {
  const bySource = countRecordsBySource(storePath, passphrase);
  const exclusions = withDatabase(storePath, passphrase, false, (db) => {
    ensureSourceExclusionsSchema(db);
    return db.prepare(`SELECT source, excluded_at FROM source_exclusions ORDER BY excluded_at DESC`).all() as {
      source: string;
      excluded_at: string;
    }[];
  });
  const excludedAtBySource = new Map(exclusions.map((row) => [row.source, row.excluded_at]));

  const sources = new Set([...Object.keys(bySource), ...excludedAtBySource.keys()]);
  const controls = [...sources].map((source) => ({
    source,
    recordCount: bySource[source] ?? 0,
    excluded: excludedAtBySource.has(source),
    excludedAt: excludedAtBySource.get(source) ?? null,
  }));

  // Excluded sources first (newest exclusion first, same ordering
  // listExcludedEvidence uses), then the rest.
  return controls.sort((a, b) => {
    if (a.excluded && b.excluded) {
      return (b.excludedAt ?? "").localeCompare(a.excludedAt ?? "");
    }
    if (a.excluded !== b.excluded) {
      return a.excluded ? -1 : 1;
    }
    return a.source.localeCompare(b.source);
  });
}
