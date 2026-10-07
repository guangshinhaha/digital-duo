import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { IngestRecord, RecordAudience, RecordAuthor, RecordClassification, RecordKind } from "./record.js";
import { parseRecord } from "./record.js";

/**
 * Creates the records table and its FTS5 index if they don't exist yet.
 * Run at the start of every records operation rather than only at `duo
 * init`, so an encrypted store created before this schema existed (or a
 * fresh staging database — see #21) still gets it on first use.
 *
 * The FTS5 table duplicates `text` rather than using SQLite's
 * external-content mode: there's no rowid-sync trigger machinery to keep
 * consistent, so every write path that touches a record's text
 * (`writeRecords`, `deleteRecords`, and digital-duo#286's `updateRecordText`
 * below) is responsible for keeping `records` and `records_fts` in step by
 * hand — a plain duplicate is the simpler correct choice at this corpus
 * scale, not a claim that records never change.
 *
 * `edited_at` (digital-duo#286) is null on every record written by an
 * import adapter and set only by `updateRecordText` — it is how the Knows
 * tab's record browser tells an owner-corrected row from an originally
 * ingested one. Added via `RECORDS_MIGRATIONS` below rather than in this
 * literal `CREATE TABLE`, the same reasoning `drafting/draft-log.ts`'s own
 * migration list gives: `CREATE TABLE IF NOT EXISTS` is a no-op against a
 * `records` table a pre-#286 store already created.
 *
 * Exported (not just called internally) so #20's embeddings module can
 * ensure the `records` table exists before querying it — a store that has
 * never had a record written to it has no `records` table yet either.
 */
export function ensureRecordsSchema(db: Database): void {
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
      topics TEXT NOT NULL DEFAULT '[]',
      edited_at TEXT
    ) STRICT
  `);
  const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(records)`).all() as unknown as { name: string }[]).map((row) => row.name),
  );
  for (const migration of RECORDS_MIGRATIONS) {
    if (!existingColumns.has(migration.column)) {
      db.exec(migration.ddl);
    }
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, text)`);
}

/** Columns added to `records` after its first release — see `ensureRecordsSchema`'s doc comment. */
const RECORDS_MIGRATIONS: readonly { readonly column: string; readonly ddl: string }[] = [
  { column: "edited_at", ddl: "ALTER TABLE records ADD COLUMN edited_at TEXT" },
];

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
  classification: string;
  topics: string;
  edited_at: string | null;
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
    classification: row.classification as RecordClassification,
    topics: JSON.parse(row.topics) as string[],
  };
}

/** A record as the Knows tab's browser needs it (digital-duo#286): the normalised `IngestRecord` plus whether — and when — the owner last corrected its text. `null` for every record no edit has ever touched. */
export interface StoredRecord extends IngestRecord {
  readonly editedAt: string | null;
}

function rowToStoredRecord(row: RecordRow): StoredRecord {
  return { ...rowToRecord(row), editedAt: row.edited_at };
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
    ensureRecordsSchema(db);
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
    ensureRecordsSchema(db);
    const row = db.prepare(`SELECT * FROM records WHERE id = ?`).get(id) as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  });
}

export class RecordNotFoundError extends Error {
  constructor(id: string) {
    super(`No record "${id}"`);
    this.name = "RecordNotFoundError";
  }
}

export class InvalidRecordEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecordEditError";
  }
}

/**
 * digital-duo#286: the Knows tab's record browser editing a record's text
 * in place — "correct the stored text going forward", never a re-run of
 * derivation. Deliberately narrow: only `text` (and the `edited_at` marker)
 * changes. Everything else about the record — its `id` (still the content
 * hash of the *original* text, by design: a later re-import of the
 * unedited source material looks up that same id and, via `writeRecords`'s
 * `INSERT OR IGNORE`, leaves the owner's edit in place rather than
 * overwriting it), `classification`, `topics`, `source` — is untouched.
 * `classification` in particular is never re-detected here: it is
 * policy-set, read once at ingest (`detectClassification`, #48), and an
 * edit silently loosening or tightening it without the owner naming that
 * as the intent would be the wrong kind of surprise for a classification
 * field (concept.md §5).
 *
 * Keeps `records_fts` in step by hand (no triggers — see
 * `ensureRecordsSchema`'s doc comment) and best-effort drops any stored
 * embedding for this record, the same "doesn't exist yet is not a failure"
 * shape `deleteRecords` already uses: the next `duo embed` / `POST
 * /corpus/embed` run re-embeds it under the corrected text rather than a
 * search silently ranking it by its old wording.
 *
 * Does **not** touch anything the derivation pipeline already produced
 * from this record (qa_pairs, rules, the voice profile): those are the
 * output of an explicit `duo derive` run over the corpus as it stood at
 * that time, never recomputed live off a single record the way retrieval
 * and search are. An edit here changes what the record says for every
 * *future* draft, re-embed and re-derive; it does not reach back and alter
 * a rule already confirmed from the old wording — the same "stops future
 * use, never rewrites the past" contract `evidence-exclusions.ts` and
 * `source-exclusions.ts` already keep.
 */
export function updateRecordText(storePath: string, passphrase: string, id: string, text: string): StoredRecord {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new InvalidRecordEditError("A record's text can't be edited down to nothing.");
  }
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureRecordsSchema(db);
    const existing = db.prepare(`SELECT * FROM records WHERE id = ?`).get(id) as RecordRow | undefined;
    if (!existing) {
      throw new RecordNotFoundError(id);
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE records SET text = ?, edited_at = ? WHERE id = ?`).run(trimmed, now, id);
    db.prepare(`UPDATE records_fts SET text = ? WHERE id = ?`).run(trimmed, id);
    try {
      db.prepare(`DELETE FROM record_embeddings WHERE record_id = ?`).run(id);
    } catch {
      // record_embeddings doesn't exist in this store yet — nothing to invalidate.
    }
    return rowToStoredRecord({ ...existing, text: trimmed, edited_at: now });
  });
}

/** Total record count in the store. */
export function countRecords(storePath: string, passphrase: string): number {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const row = db.prepare(`SELECT COUNT(*) AS count FROM records`).get() as { count: number };
    return row.count;
  });
}

/**
 * Record counts grouped by `source` (#175: "what does this duo know, and
 * where did it come from"). A plain read of what the store already keeps —
 * `source` is a column on every record — so an absent table or an empty
 * corpus is simply `{}`, never an error.
 */
export function countRecordsBySource(storePath: string, passphrase: string): Record<string, number> {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const rows = db.prepare(`SELECT source, COUNT(*) AS count FROM records GROUP BY source`).all() as unknown as {
      source: string;
      count: number;
    }[];
    return Object.fromEntries(rows.map((row) => [row.source, row.count]));
  });
}

/**
 * Every record in the store, unfiltered. Used by #21's phase B to read
 * back everything phase A staged before applying the retention filter —
 * this is a full enumeration, not a relevance search, so it doesn't go
 * through FTS5.
 */
export function listRecords(storePath: string, passphrase: string): IngestRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const rows = db.prepare(`SELECT * FROM records`).all() as unknown as RecordRow[];
    return rows.map(rowToRecord);
  });
}

export interface RecordsPage {
  readonly records: readonly StoredRecord[];
  /** The offset to pass back as `cursor` for the next page; null once this page came up short of `limit` (end of the list, same end-of-history signal `/escalations/history` already uses). */
  readonly nextCursor: number | null;
}

/**
 * digital-duo#286: the Knows tab's record browser — `GET
 * /knowledge/records`'s own read, paged (newest first) and optionally
 * narrowed to one `source` and/or a full-text `q`. This is the first
 * paginated, filterable read over the raw corpus itself (every existing
 * read over `records` is either unbounded — `listRecords`, used only by
 * #21's own retention pass, never by a client — or a relevance search with
 * no source filter — `searchRecords`); the gap `digital-duo#286` names.
 *
 * `q` reuses the same FTS5 index and the same query-sanitising
 * `toMatchQuery` `searchRecords` already uses, so a browse-with-search and
 * a plain "most recent records" read share one ranking/paging discipline
 * rather than inventing a second one. Without `q`, ordering is simply
 * `timestamp DESC, id` (a stable tiebreaker two records sharing a
 * timestamp still need) — browsing is "what's newest", not a relevance
 * rank.
 */
export function listRecordsPage(
  storePath: string,
  passphrase: string,
  opts: { readonly source?: string; readonly q?: string; readonly limit?: number; readonly cursor?: number } = {},
): RecordsPage {
  const limit = opts.limit ?? 20;
  const cursor = opts.cursor ?? 0;
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    // Built together, clause-then-its-own-param, so the two always line up
    // regardless of which filters are present.
    const whereClauses: string[] = [];
    const params: string[] = [];
    const hasQuery = opts.q !== undefined && opts.q.trim().length > 0;
    if (hasQuery) {
      whereClauses.push("records_fts MATCH ?");
      params.push(toMatchQuery(opts.q!));
    }
    if (opts.source !== undefined) {
      whereClauses.push("records.source = ?");
      params.push(opts.source);
    }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const sql = hasQuery
      ? `
        SELECT records.*
        FROM records_fts
        JOIN records ON records.id = records_fts.id
        ${where}
        ORDER BY records.timestamp DESC, records.id
        LIMIT ? OFFSET ?
      `
      : `
        SELECT * FROM records
        ${where}
        ORDER BY timestamp DESC, id
        LIMIT ? OFFSET ?
      `;
    const rows = db.prepare(sql).all(...params, limit + 1, cursor) as unknown as RecordRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { records: page.map(rowToStoredRecord), nextCursor: hasMore ? cursor + limit : null };
  });
}

export interface DeleteRecordsResult {
  /** Records actually removed — ids in `ids` that didn't exist are simply not counted, not an error. */
  removed: number;
}

/**
 * Removes records by id from both `records` and its FTS5 shadow, and best-
 * effort from `record_embeddings` (a store that has never run `duo embed`
 * has no such table yet, which is not a failure here — deleting from a
 * table that was never created is a no-op, not an error). Generic by
 * design: #48's ceiling re-evaluation (src/permissions/classification.ts)
 * is its first caller, but nothing here is classification-specific.
 */
export function deleteRecords(storePath: string, passphrase: string, ids: readonly string[]): DeleteRecordsResult {
  if (ids.length === 0) {
    return { removed: 0 };
  }
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureRecordsSchema(db);
    const deleteRecord = db.prepare(`DELETE FROM records WHERE id = ?`);
    const deleteFts = db.prepare(`DELETE FROM records_fts WHERE id = ?`);
    let removed = 0;
    for (const id of ids) {
      const result = deleteRecord.run(id);
      if (result.changes > 0) {
        deleteFts.run(id);
        removed += 1;
      }
    }
    try {
      const deleteEmbedding = db.prepare(`DELETE FROM record_embeddings WHERE record_id = ?`);
      for (const id of ids) {
        deleteEmbedding.run(id);
      }
    } catch {
      // record_embeddings doesn't exist in this store yet — nothing to clean up.
    }
    return { removed };
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
 * erroring — `ensureRecordsSchema` creates the table/index on demand, so
 * searching a store that has never had a record written to it is a normal
 * case, not a failure.
 */
export function searchRecords(storePath: string, passphrase: string, query: string, limit = 20): RankedRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
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
