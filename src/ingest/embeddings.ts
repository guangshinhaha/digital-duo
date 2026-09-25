import type { EmbeddingProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { IngestRecord } from "./record.js";
import { ensureRecordsSchema, getRecord, searchRecords, type RankedRecord } from "./record-store.js";

/**
 * Embeddings are stored one row per record, keyed only by `record_id` —
 * not by (record_id, model) — so there is always at most one vector per
 * record. Vectors go in as a JSON array of numbers, not a BLOB: it's
 * simpler to inspect and test, and at a personal corpus's scale the
 * overhead is irrelevant (out of scope per #20: no sqlite-vec, no
 * dedicated vector index — brute-force cosine over this table is enough).
 */
export function ensureEmbeddingSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS record_embeddings (
      record_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector TEXT NOT NULL
    ) STRICT
  `);
}

export interface EmbedRecordsResult {
  /** Records newly embedded (or re-embedded under a new model) this call. */
  embedded: number;
  /** Total record count in the store. */
  total: number;
}

/**
 * Embeds every record that doesn't yet have a vector stored under
 * `provider.model`, and overwrites that record's stored vector with the
 * freshly computed one. Model and dimensions travel with every vector
 * (#20's "recorded so a model change triggers a re-embed"): switching
 * `provider.model` makes every record look un-embedded again — under the
 * *new* model — so the next `embedRecords` call re-embeds everything
 * rather than a vector search silently comparing vectors from two
 * different embedding spaces.
 *
 * Two separate `withDatabase` calls bookend the actual embedding calls:
 * `withDatabase`'s callback is synchronous (it re-encrypts the store the
 * moment it returns), so the async network round-trips to Ollama happen
 * outside it, between a read pass (what needs embedding) and a write pass
 * (persisting what got computed).
 *
 * `opts.limit` (#176) embeds at most that many pending records per call —
 * the serve layer's embed job calls in batches so a client can watch the
 * count climb rather than waiting on one opaque whole-corpus call. The
 * result shape is unchanged (a partial batch still reports only what this
 * call embedded); the CLI passes no limit and embeds everything, exactly
 * as before.
 */
export async function embedRecords(
  storePath: string,
  passphrase: string,
  provider: EmbeddingProvider,
  opts: { limit?: number } = {},
): Promise<EmbedRecordsResult> {
  const { pending, total } = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    ensureEmbeddingSchema(db);
    const pendingRows = db
      .prepare(
        `
        SELECT records.id AS id, records.text AS text
        FROM records
        LEFT JOIN record_embeddings
          ON record_embeddings.record_id = records.id AND record_embeddings.model = ?
        WHERE record_embeddings.record_id IS NULL
      `,
      )
      .all(provider.model) as unknown as { id: string; text: string }[];
    const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM records`).get() as unknown as { count: number };
    return { pending: pendingRows, total: totalRow.count };
  });

  const batch = opts.limit === undefined ? pending : pending.slice(0, opts.limit);
  if (batch.length === 0) {
    return { embedded: 0, total };
  }

  const computed: { id: string; vector: readonly number[] }[] = [];
  for (const record of batch) {
    computed.push({ id: record.id, vector: await provider.embed(record.text) });
  }

  withDatabase(storePath, passphrase, true, (db) => {
    ensureEmbeddingSchema(db);
    const upsert = db.prepare(`
      INSERT INTO record_embeddings (record_id, model, dimensions, vector)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions, vector = excluded.vector
    `);
    for (const { id, vector } of computed) {
      upsert.run(id, provider.model, vector.length, JSON.stringify(vector));
    }
  });

  return { embedded: computed.length, total };
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Ranks records by cosine similarity to `queryVector`, dropping anything
 * at or below zero similarity. Reciprocal rank fusion (below) only looks
 * at rank position, not the underlying score — so without this filter, a
 * record with *no* real relationship to the query would still get a
 * "free" fusion boost merely for occupying a low rank in this list, ahead
 * of records that legitimately share no vocabulary and no embedding
 * signal with the query. Zero similarity is exactly the "no signal"
 * case, so it's excluded rather than ranked last.
 */
function vectorSearchIds(db: Database, queryVector: readonly number[], model: string, limit: number): string[] {
  const rows = db.prepare(`SELECT record_id, vector FROM record_embeddings WHERE model = ?`).all(model) as unknown as {
    record_id: string;
    vector: string;
  }[];
  return rows
    .map((row) => ({ id: row.record_id, score: cosineSimilarity(queryVector, JSON.parse(row.vector) as number[]) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.id);
}

/**
 * Reciprocal rank fusion: a record's fused score is the sum, over every
 * ranked list it appears in, of 1/(k + rank). A record near the top of
 * either list scores well; one that both the lexical and the semantic
 * search agree on scores best of all — without needing FTS5's bm25 score
 * and cosine similarity to be on comparable scales, which they aren't.
 */
const RRF_K = 60;

function fuseRankings(lists: readonly (readonly string[])[]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export interface HybridSearchOutcome {
  readonly results: readonly RankedRecord[];
  /** False when the query couldn't be embedded (e.g. Ollama unreachable) — results are full-text-only in that case. */
  readonly usedEmbeddings: boolean;
  /** Set only when usedEmbeddings is false, explaining why retrieval fell back to full-text search alone. */
  readonly warning?: string;
}

/**
 * Hybrid retrieval: full-text (FTS5, via #18's searchRecords) fused with
 * vector similarity over `record_embeddings`, via reciprocal rank fusion.
 * Neither alone is sufficient (v1-tech-design.md §1.2) — full-text catches
 * exact terms and names, vectors catch the same question asked in
 * different words.
 *
 * Embedding the query is the one network call in this function, and the
 * one thing that can make retrieval unavailable: if it fails for any
 * reason (Ollama not running, unreachable host, a bad response), this
 * doesn't propagate the failure — it degrades to full-text-only and says
 * so via `warning`, per #20's acceptance criteria. An empty corpus
 * produces empty ranked lists from both `searchRecords` and the vector
 * scan, so `results` comes back `[]` with no error either way.
 *
 * `limit`/`offset` page the fused ranking (#174): candidates are gathered
 * for the whole span (`offset + limit`) and the fused list is sliced to
 * `[offset, offset + limit)`, so a second page is ranked against the same
 * candidate universe as the first, not a truncated one. A result's `rank`
 * is its position in the full fused list, stable across pages.
 */
export async function hybridSearch(
  storePath: string,
  passphrase: string,
  query: string,
  provider: EmbeddingProvider,
  limit = 10,
  offset = 0,
): Promise<HybridSearchOutcome> {
  let queryVector: readonly number[] | undefined;
  let warning: string | undefined;
  try {
    queryVector = await provider.embed(query);
  } catch (error) {
    warning = `Embeddings unavailable (${
      error instanceof Error ? error.message : String(error)
    }); falling back to full-text search only.`;
  }

  // Both candidate lists must cover the whole span being paged into —
  // gathering only `limit` deep and slicing the fused list afterwards would
  // rank page two against a candidate set that never saw page one (#174).
  // The ×3 headroom is the same over-gathering the unpaged path always did,
  // applied to the full span instead of the single page.
  const span = offset + limit;
  const ftsMatches = searchRecords(storePath, passphrase, query, span * 3);
  const ftsIds = ftsMatches.map((match) => match.record.id);
  const byId = new Map(ftsMatches.map((match) => [match.record.id, match.record]));

  let vectorIds: string[] = [];
  if (queryVector) {
    const capturedVector = queryVector;
    vectorIds = withDatabase(storePath, passphrase, false, (db) => {
      ensureEmbeddingSchema(db);
      return vectorSearchIds(db, capturedVector, provider.model, span * 3);
    });
    for (const id of vectorIds) {
      if (!byId.has(id)) {
        const record = getRecord(storePath, passphrase, id);
        if (record) {
          byId.set(id, record);
        }
      }
    }
  }

  const fusedIds = fuseRankings([ftsIds, vectorIds]).slice(offset, offset + limit);
  const results: RankedRecord[] = fusedIds
    .map((id) => byId.get(id))
    .filter((record): record is IngestRecord => record !== undefined)
    // Rank is the position in the full fused list, not within this page —
    // a page-two result keeps the rank it earned, so ranks stay stable
    // identities across pages (and "cursor = last rank + 1" pages forward).
    .map((record, index) => ({ record, rank: offset + index }));

  return { results, usedEmbeddings: queryVector !== undefined, warning };
}
