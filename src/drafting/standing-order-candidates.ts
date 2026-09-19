import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { DraftNotFoundError, ensureDraftLogSchema, getDraft } from "./draft-log.js";

/**
 * #34 AC3: "an escalation the owner knows the answer to" — answering it on
 * the spot and choosing to record it queues a candidate here, entering
 * the same batched review v1-tech-design.md §1.9 describes for any other
 * correction ("queue it; do not write immediately ... weekly review").
 * That review step is epic e7's (#37-#39), not yet built — this table is
 * the landing place it's meant to consume, the same "build the surface
 * ahead of its first real consumer" precedent as #48-#51's audit log.
 */
/** #38: the batched review approves or rejects a candidate, same as #37's own correction_candidates. */
export const STANDING_ORDER_CANDIDATE_STATUSES = ["pending", "approved", "rejected"] as const;
export type StandingOrderCandidateStatus = (typeof STANDING_ORDER_CANDIDATE_STATUSES)[number];

export interface StandingOrderCandidate {
  readonly id: string;
  readonly draftId: string;
  readonly question: string;
  readonly answerText: string;
  readonly status: StandingOrderCandidateStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export function ensureStandingOrderCandidateSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS standing_order_candidates (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    ) STRICT
  `);
}

/** Thrown when the owner tries to turn a non-escalated draft into a standing-order candidate — #34 is specifically about turning an *escalation* into a rule, not re-recording an answer the pipeline already drafted confidently. */
export class NotAnEscalationError extends Error {
  constructor(draftId: string) {
    super(`Draft "${draftId}" was not escalated — there's nothing to record an answer against`);
    this.name = "NotAnEscalationError";
  }
}

/**
 * Thrown when the owner tries to answer a *refused* escalation.
 * `client-tech-design.md` §1.6: a refusal "is a boundary the owner set"
 * and only a non-refused, low-confidence escalation invites an answer —
 * the client's own UI already hides the answer box for one
 * (`DraftCard.tsx`), but that's a UI convenience, not the enforcement.
 * Without this check, a direct call here (a different client, a bug, a
 * raw API request) could turn a subject the owner deliberately refused
 * to speak on into a standing-order candidate and, eventually, a rule
 * the duo answers with automatically — silently overriding the refusal
 * the whole feature exists to hold.
 */
export class DraftIsRefusedError extends Error {
  constructor(draftId: string) {
    super(`Draft "${draftId}" is a refused escalation — the owner set that boundary; it cannot be answered into a standing-order candidate`);
    this.name = "DraftIsRefusedError";
  }
}

/**
 * Queues a standing-order candidate from the owner's own answer to an
 * escalated draft. Looks the draft up first — by id, not by trusting the
 * caller's own copy of its question — both to get the exact original
 * question text and to enforce that only an escalation (never a draft
 * the pipeline was confident enough to answer) can be turned into one of
 * these.
 */
/**
 * Idempotent by `draftId`: an escalation can only ever be "answered" once
 * in the sense this table records, so a second call against the same
 * draft (a retried request, a client remounting and re-showing an answer
 * box that hasn't caught up with a just-recorded outcome) returns the
 * already-queued candidate's id rather than inserting a duplicate. Same
 * dedup shape `corrections/queue.ts`'s `queueCorrectionCandidate` already
 * uses for the same reason. The *text* of a resubmission is ignored on a
 * repeat call — the first answer queued is the one of record.
 */
export function queueStandingOrderCandidate(storePath: string, passphrase: string, draftId: string, answerText: string): string {
  const draft = getDraft(storePath, passphrase, draftId);
  if (!draft) {
    throw new DraftNotFoundError(draftId);
  }
  if (!draft.escalated) {
    throw new NotAnEscalationError(draftId);
  }
  if (draft.refused) {
    throw new DraftIsRefusedError(draftId);
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  // Both writes — the candidate row and the draft's outcome — happen on
  // the same open `db` handle, inside this one `withDatabase` call, so
  // they persist or fail together. An earlier version made these two
  // separate `withDatabase` calls: each one independently decrypts,
  // mutates, and re-encrypts the whole store, so a crash between them
  // left a queued candidate whose draft never got marked
  // "escalation_answered" — permanently stuck "pending", the exact bug
  // this outcome exists to fix. The idempotency check below means a
  // resumed/retried call after such a crash still can't recover (it
  // finds the candidate and returns early, as intended for a genuine
  // repeat), which is exactly why this must not be able to happen at all.
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureStandingOrderCandidateSchema(db);
    const existing = db.prepare(`SELECT id FROM standing_order_candidates WHERE draft_id = ?`).get(draftId) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    db.prepare(
      `INSERT INTO standing_order_candidates (id, draft_id, question, answer_text, status, created_at, reviewed_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)`,
    ).run(id, draftId, draft.question, answerText, createdAt);

    // Inlined rather than calling recordDraftOutcome: that function is
    // typed to SettableDraftOutcome specifically so escalation_answered
    // can never reach it from any other caller (see its own doc comment).
    ensureDraftLogSchema(db);
    db.prepare(`UPDATE drafts SET outcome = 'escalation_answered', outcome_recorded_at = ?, sent_text = ? WHERE id = ?`).run(
      createdAt,
      answerText,
      draftId,
    );
    return id;
  });
}

interface StandingOrderCandidateRow {
  id: string;
  draft_id: string;
  question: string;
  answer_text: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

function rowToCandidate(row: StandingOrderCandidateRow): StandingOrderCandidate {
  return {
    id: row.id,
    draftId: row.draft_id,
    question: row.question,
    answerText: row.answer_text,
    status: row.status as StandingOrderCandidateStatus,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/** Every queued candidate, oldest first — what #38's batched review reads. */
export function listStandingOrderCandidates(storePath: string, passphrase: string): StandingOrderCandidate[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureStandingOrderCandidateSchema(db);
    const rows = db.prepare(`SELECT * FROM standing_order_candidates ORDER BY created_at, id`).all() as unknown as StandingOrderCandidateRow[];
    return rows.map(rowToCandidate);
  });
}

/** Thrown by requirePendingStandingOrderCandidate when no row with the given id exists in this table — the caller (#38's review) tries #37's correction_candidates next before giving up. */
export class StandingOrderCandidateNotFoundError extends Error {
  constructor(id: string) {
    super(`No standing-order candidate with id "${id}"`);
    this.name = "StandingOrderCandidateNotFoundError";
  }
}

/** Reads one candidate on an already-open handle, requiring it to still be pending — mirrors #37's queue.ts requirePendingCandidate for the same review precondition. */
export function requirePendingStandingOrderCandidate(db: Database, id: string): StandingOrderCandidate {
  ensureStandingOrderCandidateSchema(db);
  const row = db.prepare(`SELECT * FROM standing_order_candidates WHERE id = ?`).get(id) as StandingOrderCandidateRow | undefined;
  if (!row) {
    throw new StandingOrderCandidateNotFoundError(id);
  }
  const candidate = rowToCandidate(row);
  if (candidate.status !== "pending") {
    throw new Error(`Standing-order candidate "${id}" was already reviewed (status: "${candidate.status}")`);
  }
  return candidate;
}

/** Marks a standing-order candidate approved or rejected on an already-open handle — called only after any file write the decision implies has already succeeded. */
export function setStandingOrderCandidateStatus(db: Database, id: string, status: "approved" | "rejected"): void {
  ensureStandingOrderCandidateSchema(db);
  db.prepare(`UPDATE standing_order_candidates SET status = ?, reviewed_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
}
