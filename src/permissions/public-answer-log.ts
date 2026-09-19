import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * The public-answering epic's own audit trail (#43 AC1: "the exchange is
 * logged against the owner"). Deliberately not `src/permissions/audit.ts`'s
 * `audit_log`: that table's columns (`clearanceApplied`, `recordsExcluded`
 * keyed on a resolved *asker's* clearance) exist for #49/#50's per-asker
 * retrieval filtering, which #43 explicitly does not do — "answering
 * differently per asker...needs #10" is out of scope for this epic, so
 * there is no per-asker clearance here to record. Forcing this event into
 * that shape would fabricate columns that have no meaning for it, the same
 * reasoning `src/trust/ledger.ts` gives for not reusing `audit_log` for
 * trust events either. This is a plain "what did the public see, and why"
 * trail keyed on topic autonomy instead.
 *
 * Append-only, same two-trigger pattern as `audit_log`/`trust_ledger`:
 * `correctsEntryId` exists now (unused by #43 itself) so #45's "retract and
 * correct an answer in the same thread" needs no schema migration to start
 * writing corrections here, the same "field present, logic deferred" idiom
 * used throughout this codebase (e.g. #50's `rulesUsed`).
 */
export const PUBLIC_ANSWER_OUTCOMES = ["answered", "passed_on", "declined_refused"] as const;
export type PublicAnswerOutcomeKind = (typeof PUBLIC_ANSWER_OUTCOMES)[number];

export interface PublicAnswerLogEntryInput {
  readonly question: string;
  readonly askerRef: string;
  /** null when no topic could be resolved for the question at all (e.g. no evidence, or a refusal short-circuit before retrieval ever ran). */
  readonly topicId: string | null;
  readonly outcome: PublicAnswerOutcomeKind;
  /** Exactly what the asker saw — the public answer text, or the fixed passed-on/refusal message. */
  readonly text: string;
  /** The private draft-log row (#32's `drafts` table) this same exchange also produced — every public answer has a private counterpart, since the T1 draft pipeline always runs first. */
  readonly draftId: string;
  /** Set only when this entry corrects an earlier one (#45); the earlier entry is left exactly as written. */
  readonly correctsEntryId?: string | null;
}

export interface PublicAnswerLogEntry extends PublicAnswerLogEntryInput {
  readonly id: string;
  readonly createdAt: string;
}

interface PublicAnswerLogRow {
  id: string;
  created_at: string;
  question: string;
  asker_ref: string;
  topic_id: string | null;
  outcome: string;
  text: string;
  draft_id: string;
  corrects_entry_id: string | null;
}

function rowToEntry(row: PublicAnswerLogRow): PublicAnswerLogEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    question: row.question,
    askerRef: row.asker_ref,
    topicId: row.topic_id,
    outcome: row.outcome as PublicAnswerOutcomeKind,
    text: row.text,
    draftId: row.draft_id,
    correctsEntryId: row.corrects_entry_id,
  };
}

/** Created on demand, matching every other table in this codebase. */
export function ensurePublicAnswerLogSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_answer_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      question TEXT NOT NULL,
      asker_ref TEXT NOT NULL,
      topic_id TEXT,
      outcome TEXT NOT NULL,
      text TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      corrects_entry_id TEXT
    ) STRICT
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS public_answer_log_append_only_no_update
    BEFORE UPDATE ON public_answer_log
    BEGIN
      SELECT RAISE(ABORT, 'public_answer_log is append-only: record a correction as a new entry, never edit an existing one');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS public_answer_log_append_only_no_delete
    BEFORE DELETE ON public_answer_log
    BEGIN
      SELECT RAISE(ABORT, 'public_answer_log is append-only: entries are never deleted');
    END
  `);
}

/** Appends one entry and returns its id. Deliberately the only write this module offers — see the module doc above. */
export function appendPublicAnswerLogEntry(storePath: string, passphrase: string, input: PublicAnswerLogEntryInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensurePublicAnswerLogSchema(db);
    db.prepare(
      `
      INSERT INTO public_answer_log
        (id, created_at, question, asker_ref, topic_id, outcome, text, draft_id, corrects_entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(id, createdAt, input.question, input.askerRef, input.topicId, input.outcome, input.text, input.draftId, input.correctsEntryId ?? null);
  });
  return id;
}

/** One entry by id, or undefined — the owner's own reconstruction read, same shape as #51's getAuditEntry. */
export function getPublicAnswerLogEntry(storePath: string, passphrase: string, id: string): PublicAnswerLogEntry | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePublicAnswerLogSchema(db);
    const row = db.prepare(`SELECT * FROM public_answer_log WHERE id = ?`).get(id) as PublicAnswerLogRow | undefined;
    return row ? rowToEntry(row) : undefined;
  });
}

/** Every entry, oldest first — the owner's full list to scan or pipe. */
export function listPublicAnswerLogEntries(storePath: string, passphrase: string): PublicAnswerLogEntry[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePublicAnswerLogSchema(db);
    const rows = db.prepare(`SELECT * FROM public_answer_log ORDER BY created_at ASC, id ASC`).all() as unknown as PublicAnswerLogRow[];
    return rows.map(rowToEntry);
  });
}
