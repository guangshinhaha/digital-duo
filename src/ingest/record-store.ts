import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { IngestRecord, RecordAudience, RecordAuthor, RecordKind } from "./record.js";
import { parseRecord } from "./record.js";

/**
 * Creates the records table and its FTS5 index if they don't exist yet.
 * Run at the start of every records operation rather than only at `duo
 * init`, so an encrypted store created before this schema existed (or a
 * fresh staging database — see #21) still gets it on first use.
 *
 * The FTS5 table duplicates `text` rather than using SQLite's
 * external-content mode: records are only ever inserted, never updated or
 * deleted in this store, so there's no rowid-sync trigger machinery to keep
 * consistent — a plain duplicate is the simpler correct choice at this
 * corpus scale.
 */
function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_ref TEXT,
      kind TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      thread_id TEXT,
      audience TEXT NOT NULL,
      classification TEXT,
      topics TEXT NOT NULL DEFAULT '[]'
    ) STRICT
  `);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, text)`);
}

interface RecordRow {
  id: string;
  source: string;
  source_ref: string | null;
  kind: string;
  author: string;
  text: string;
  timestamp: string;
  thread_id: string | null;
  audience: string;
  classification: string | null;
  topics: string;
}

function rowToRecord(row: RecordRow): IngestRecord {
  return {
    id: row.id,
    source: row.source,
    sourceRef: row.source_ref,
    kind: row.kind as RecordKind,
    author: row.author as RecordAuthor,
    text: row.text,
    timestamp: row.timestamp,
    threadId: row.thread_id,
    audience: row.audience as RecordAudience,
    classification: row.classification,
    topics: JSON.parse(row.topics) as string[],
  };
}

export interface WriteRecordsResult {
  /** Records newly inserted this call. */
  written: number;
  /** Records whose id already existed — re-import, not a duplicate (import-adapters.md §5). */
  skipped: number;
}

/**
 * Writes a batch of records to the store. Every record is validated
 * *before* any database write happens (see parseRecord), so a single
 * invalid record in the batch refuses the whole write — no partial batch
 * is ever committed, matching #18's acceptance criteria.
 *
 * Takes `readonly unknown[]` rather than `IngestRecord[]`: this is the
 * boundary where untrusted input (an adapter's output, a re-imported blob)
 * is first validated, so the type of what callers may pass here should not
 * imply it's already trusted.
 */
export function writeRecords(storePath: string, passphrase: string, records: readonly unknown[]): WriteRecordsResult {
  const parsed = records.map((record) => parseRecord(record));

  return withDatabase(storePath, passphrase, true, (db) => {
    ensureSchema(db);
    const insertRecord = db.prepare(`
      INSERT OR IGNORE INTO records (id, source, source_ref, kind, author, text, timestamp, thread_id, audience, classification, topics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`INSERT INTO records_fts (id, text) VALUES (?, ?)`);

    let written = 0;
    let skipped = 0;
    for (const record of parsed) {
      const result = insertRecord.run(
        record.id,
        record.source,
        record.sourceRef,
        record.kind,
        record.author,
        record.text,
        record.timestamp,
        record.threadId,
        record.audience,
        record.classification,
        JSON.stringify(record.topics),
      );
      if (result.changes > 0) {
        insertFts.run(record.id, record.text);
        written += 1;
      } else {
        skipped += 1;
      }
    }
    return { written, skipped };
  });
}

/** Retrieves a single record by id, or undefined if no record with that id exists. */
export function getRecord(storePath: string, passphrase: string, id: string): IngestRecord | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureSchema(db);
    const row = db.prepare(`SELECT * FROM records WHERE id = ?`).get(id) as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  });
}

/** Total record count in the store. */
export function countRecords(storePath: string, passphrase: string): number {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureSchema(db);
    const row = db.prepare(`SELECT COUNT(*) AS count FROM records`).get() as { count: number };
    return row.count;
  });
}

export interface RankedRecord {
  record: IngestRecord;
  /** FTS5's bm25-derived rank; lower is more relevant. Ordering, not an absolute score. */
  rank: number;
}

/**
 * Turns a raw, arbitrary search string into an FTS5 MATCH expression that
 * can never itself throw a query-syntax error. FTS5's query grammar gives
 * special meaning to characters a caller's search text may contain
 * incidentally — a bareword like "nonexistent-term-xyz" parses `-term` as
 * the NOT operator and fails with "no such column: term" rather than
 * "no results". Splitting on non-alphanumeric boundaries (the same
 * boundary the default tokenizer stores terms on) and quoting each word as
 * a literal phrase sidesteps every such operator: the words still combine
 * with FTS5's implicit AND, but none of them can be parsed as syntax.
 */
function toMatchQuery(query: string): string {
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) {
    return '""'; // no word-characters at all — a phrase that matches nothing, not a syntax error
  }
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Full-text search over `text` via the FTS5 index, best matches first. An
 * empty corpus (no records table rows) returns an empty array rather than
 * erroring — `ensureSchema` creates the table/index on demand, so searching
 * a store that has never had a record written to it is a normal case, not
 * a failure.
 */
export function searchRecords(storePath: string, passphrase: string, query: string, limit = 20): RankedRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureSchema(db);
    const rows = db
      .prepare(
        `
        SELECT records.*, records_fts.rank AS rank
        FROM records_fts
        JOIN records ON records.id = records_fts.id
        WHERE records_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(toMatchQuery(query), limit) as unknown as (RecordRow & { rank: number })[];
    return rows.map((row) => ({ record: rowToRecord(row), rank: row.rank }));
  });
}
