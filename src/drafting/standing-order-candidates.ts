import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { DraftNotFoundError, getDraft } from "./draft-log.js";

/**
 * #34 AC3: "an escalation the owner knows the answer to" — answering it on
 * the spot and choosing to record it queues a candidate here, entering
 * the same batched review v1-tech-design.md §1.9 describes for any other
 * correction ("queue it; do not write immediately ... weekly review").
 * That review step is epic e7's (#37-#39), not yet built — this table is
 * the landing place it's meant to consume, the same "build the surface
 * ahead of its first real consumer" precedent as #48-#51's audit log.
 */
export interface StandingOrderCandidate {
  readonly id: string;
  readonly draftId: string;
  readonly question: string;
  readonly answerText: string;
  readonly status: "pending";
  readonly createdAt: string;
}

export function ensureStandingOrderCandidateSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS standing_order_candidates (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
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
 * Queues a standing-order candidate from the owner's own answer to an
 * escalated draft. Looks the draft up first — by id, not by trusting the
 * caller's own copy of its question — both to get the exact original
 * question text and to enforce that only an escalation (never a draft
 * the pipeline was confident enough to answer) can be turned into one of
 * these.
 */
export function queueStandingOrderCandidate(storePath: string, passphrase: string, draftId: string, answerText: string): string {
  const draft = getDraft(storePath, passphrase, draftId);
  if (!draft) {
    throw new DraftNotFoundError(draftId);
  }
  if (!draft.escalated) {
    throw new NotAnEscalationError(draftId);
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureStandingOrderCandidateSchema(db);
    db.prepare(
      `INSERT INTO standing_order_candidates (id, draft_id, question, answer_text, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(id, draftId, draft.question, answerText, createdAt);
  });
  return id;
}

interface StandingOrderCandidateRow {
  id: string;
  draft_id: string;
  question: string;
  answer_text: string;
  status: string;
  created_at: string;
}

function rowToCandidate(row: StandingOrderCandidateRow): StandingOrderCandidate {
  return {
    id: row.id,
    draftId: row.draft_id,
    question: row.question,
    answerText: row.answer_text,
    status: row.status as "pending",
    createdAt: row.created_at,
  };
}

/** Every queued candidate, oldest first — what the (not-yet-built) weekly batched review will read. */
export function listStandingOrderCandidates(storePath: string, passphrase: string): StandingOrderCandidate[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureStandingOrderCandidateSchema(db);
    const rows = db.prepare(`SELECT * FROM standing_order_candidates ORDER BY created_at, id`).all() as unknown as StandingOrderCandidateRow[];
    return rows.map(rowToCandidate);
  });
}
