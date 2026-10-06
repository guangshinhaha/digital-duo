import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * v1-tech-design.md §1.9: a style edit becomes a voice-profile candidate, a
 * substance edit becomes a standing-order candidate, a mixed edit becomes
 * one of each. Both kinds are queued here — "queue it; do not write
 * immediately" — leaving the actual write to `duo/rules/` or
 * `duo/voice.md` to #38's batched review.
 */
export const CORRECTION_CANDIDATE_KINDS = ["style", "substance"] as const;
export type CorrectionCandidateKind = (typeof CORRECTION_CANDIDATE_KINDS)[number];

export const CORRECTION_CANDIDATE_STATUSES = ["pending", "approved", "rejected"] as const;
export type CorrectionCandidateStatus = (typeof CORRECTION_CANDIDATE_STATUSES)[number];

/** One classified edit, queued for the weekly batched review (#38) rather than acted on immediately. */
export interface CorrectionCandidate {
  readonly id: string;
  readonly kind: CorrectionCandidateKind;
  readonly draftId: string;
  readonly question: string;
  readonly draftText: string;
  readonly sentText: string;
  readonly status: CorrectionCandidateStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export function ensureCorrectionCandidateSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS correction_candidates (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      question TEXT NOT NULL,
      draft_text TEXT NOT NULL,
      sent_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    ) STRICT
  `);
}

interface CorrectionCandidateRow {
  id: string;
  kind: string;
  draft_id: string;
  question: string;
  draft_text: string;
  sent_text: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

function rowToCandidate(row: CorrectionCandidateRow): CorrectionCandidate {
  return {
    id: row.id,
    kind: row.kind as CorrectionCandidateKind,
    draftId: row.draft_id,
    question: row.question,
    draftText: row.draft_text,
    sentText: row.sent_text,
    status: row.status as CorrectionCandidateStatus,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/**
 * "A similar edit occurs again later ... the same candidate is not
 * re-proposed unchanged" (#38): a rejected candidate for this exact
 * (question, kind, sentText) triple must not be queued again. Interpreted
 * literally rather than fuzzily — matching #28's own precedent for what
 * "not re-proposed" means for a rejected rule (the same id/content, not
 * every future thing that resembles it).
 */
function findRejectedDuplicate(db: Database, kind: CorrectionCandidateKind, question: string, sentText: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM correction_candidates WHERE kind = ? AND question = ? AND sent_text = ? AND status = 'rejected' LIMIT 1`)
    .get(kind, question, sentText);
  return row !== undefined;
}

export interface QueueCorrectionCandidateInput {
  readonly kind: CorrectionCandidateKind;
  readonly draftId: string;
  readonly question: string;
  readonly draftText: string;
  readonly sentText: string;
}

/**
 * Queues one candidate on an already-open handle, unless an identical one
 * was already rejected (see findRejectedDuplicate) or is already pending
 * for the same draft+kind (idempotency — classifying the same recorded
 * outcome twice must not duplicate the queue). Returns the candidate's id,
 * or the id of the existing row that made this call a no-op.
 */
function queueOnHandle(db: Database, input: QueueCorrectionCandidateInput): { id: string; queued: boolean } {
  ensureCorrectionCandidateSchema(db);

  if (findRejectedDuplicate(db, input.kind, input.question, input.sentText)) {
    return { id: "", queued: false };
  }

  const existing = db
    .prepare(`SELECT id FROM correction_candidates WHERE draft_id = ? AND kind = ?`)
    .get(input.draftId, input.kind) as { id: string } | undefined;
  if (existing) {
    return { id: existing.id, queued: false };
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO correction_candidates (id, kind, draft_id, question, draft_text, sent_text, status, created_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(id, input.kind, input.draftId, input.question, input.draftText, input.sentText, createdAt);
  return { id, queued: true };
}

export function queueCorrectionCandidate(storePath: string, passphrase: string, input: QueueCorrectionCandidateInput): { id: string; queued: boolean } {
  return withDatabase(storePath, passphrase, true, (db) => queueOnHandle(db, input));
}

/** Queues several candidates (e.g. both halves of a "both" classification) against one open handle, in one re-encrypt round trip. */
export function queueCorrectionCandidates(
  storePath: string,
  passphrase: string,
  inputs: readonly QueueCorrectionCandidateInput[],
): { id: string; queued: boolean }[] {
  return withDatabase(storePath, passphrase, true, (db) => inputs.map((input) => queueOnHandle(db, input)));
}

export function getCorrectionCandidate(storePath: string, passphrase: string, id: string): CorrectionCandidate | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureCorrectionCandidateSchema(db);
    const row = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(id) as CorrectionCandidateRow | undefined;
    return row ? rowToCandidate(row) : undefined;
  });
}

/** Every candidate, oldest first — optionally narrowed to one status (e.g. "pending" for #38's review screen). */
export function listCorrectionCandidates(storePath: string, passphrase: string, status?: CorrectionCandidateStatus): CorrectionCandidate[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureCorrectionCandidateSchema(db);
    const rows = (
      status
        ? db.prepare(`SELECT * FROM correction_candidates WHERE status = ? ORDER BY created_at, id`).all(status)
        : db.prepare(`SELECT * FROM correction_candidates ORDER BY created_at, id`).all()
    ) as unknown as CorrectionCandidateRow[];
    return rows.map(rowToCandidate);
  });
}

export class CorrectionCandidateNotFoundError extends Error {
  constructor(id: string) {
    super(`No correction candidate with id "${id}"`);
    this.name = "CorrectionCandidateNotFoundError";
  }
}

/** Thrown by setCandidateStatus when the candidate has already been reviewed — a review decision is final, never silently re-applied over a previous one. */
export class CandidateAlreadyReviewedError extends Error {
  constructor(id: string, status: CorrectionCandidateStatus) {
    super(`Correction candidate "${id}" was already reviewed (status: "${status}")`);
    this.name = "CandidateAlreadyReviewedError";
  }
}

/** Reads one candidate on an already-open handle, requiring it to still be pending — the shared precondition every review action (#38/#39) needs before acting. */
export function requirePendingCandidate(db: Database, id: string): CorrectionCandidate {
  ensureCorrectionCandidateSchema(db);
  const row = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(id) as CorrectionCandidateRow | undefined;
  if (!row) {
    throw new CorrectionCandidateNotFoundError(id);
  }
  const candidate = rowToCandidate(row);
  if (candidate.status !== "pending") {
    throw new CandidateAlreadyReviewedError(id, candidate.status);
  }
  return candidate;
}

/** Marks a candidate approved or rejected on an already-open handle — called only after any file write the decision implies has already succeeded (#39 AC2: the candidate stays queued if that write failed). */
export function setCandidateStatus(db: Database, id: string, status: "approved" | "rejected"): void {
  ensureCorrectionCandidateSchema(db);
  db.prepare(`UPDATE correction_candidates SET status = ?, reviewed_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
}

/**
 * guangshinhaha/duo#274's purge, the correction-candidate half: every
 * *pending* candidate queued from one of `draftIds` is rejected, the same
 * reviewably-recorded rejection `setCandidateStatus` already gives a single
 * candidate. An already-approved candidate already became a rule by the
 * time it was approved — `rejectRuleForDrafts` (rule-review.ts) is what
 * un-does that half. Returns how many rows were rejected.
 */
export function rejectPendingCorrectionCandidatesForDrafts(storePath: string, passphrase: string, draftIds: readonly string[]): number {
  if (draftIds.length === 0) {
    return 0;
  }
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureCorrectionCandidateSchema(db);
    const placeholders = draftIds.map(() => "?").join(", ");
    const result = db
      .prepare(`UPDATE correction_candidates SET status = 'rejected', reviewed_at = ? WHERE status = 'pending' AND draft_id IN (${placeholders})`)
      .run(new Date().toISOString(), ...draftIds);
    // node:sqlite types `.changes` as `number | bigint`; this row count
    // from a single UPDATE never approaches bigint range, and the
    // function's own callers (the purge orchestration's reported count)
    // need a plain number.
    return Number(result.changes);
  });
}
