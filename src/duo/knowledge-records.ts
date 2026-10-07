import { listExcludedEvidence } from "../drafting/evidence-exclusions.js";
import { listRecordsPage, type StoredRecord } from "../ingest/record-store.js";

/**
 * digital-duo#286: one record as the Knows tab's browser lists it — the
 * stored record itself, plus whether the owner has excluded it from
 * future citation (duo#272's `evidence_exclusions`, already shipped and
 * already HTTP-exposed at `POST /knowledge/evidence/:recordId/exclude`).
 *
 * This is the deliberate design choice behind "delete" for duo#273: there
 * is no second, parallel tombstone table for "deleted from the browser".
 * A record the owner removes from this list is excluded through the exact
 * same mechanism a record removed from a draft's Why panel already uses —
 * one soft-delete concept, one table, reversible from the Knows tab either
 * way. Inventing a second one would let a record be "deleted" from the
 * browser while still citable in a draft (or vice versa), which is exactly
 * the kind of drift #272's own exclusion table was built to prevent.
 */
export interface KnowledgeRecord extends StoredRecord {
  readonly excluded: boolean;
  readonly excludedAt: string | null;
}

export interface KnowledgeRecordsPage {
  readonly records: readonly KnowledgeRecord[];
  readonly nextCursor: number | null;
}

/**
 * Composes `GET /knowledge/records`'s page: `listRecordsPage`'s own read
 * (paged, optionally filtered by `source` and/or full-text `q`), joined
 * against the owner's exclusion list so the browser can show, and act on,
 * both halves from one row — same "a module composes, it never derives"
 * discipline `duo/knowledge-summary.ts` already holds for `GET /knowledge`.
 *
 * Two separate store reads, not one transaction: both are read-only, and
 * at this corpus scale (`drafting/evidence-exclusions.ts`'s own comment:
 * a personal exclusion list, not a second corpus) reading the whole
 * exclusion list per page is cheaper than it sounds, and far simpler than
 * a join that would have to live in `ingest/record-store.ts` and reach
 * upward into `drafting/` to know the exclusions table exists at all.
 */
export function describeKnowledgeRecords(
  storePath: string,
  passphrase: string,
  opts: { readonly source?: string; readonly q?: string; readonly limit?: number; readonly cursor?: number } = {},
): KnowledgeRecordsPage {
  const page = listRecordsPage(storePath, passphrase, opts);
  const excludedAtById = new Map(listExcludedEvidence(storePath, passphrase).map((row) => [row.recordId, row.excludedAt]));
  return {
    records: page.records.map((record) => ({
      ...record,
      excluded: excludedAtById.has(record.id),
      excludedAt: excludedAtById.get(record.id) ?? null,
    })),
    nextCursor: page.nextCursor,
  };
}
