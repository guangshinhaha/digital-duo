import { randomUUID } from "node:crypto";
import type { ClassificationLevel } from "../ingest/record.js";
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
 * used throughout this codebase (e.g. #50's `rulesUsed`). `"corrected"` is
 * #45's own addition to the outcome vocabulary: a correction is recorded as
 * a brand-new entry (with `correctsEntryId` pointing at the one it
 * corrects) rather than by touching the original — the same
 * append-only-correction shape #51's `appendCorrection` uses for `audit_log`.
 *
 * #160 extends this log with the ask-link context the epic's askers now
 * arrive through: `ask_link_id` (the verified ask token's id, never the raw
 * secret), `asker_resolved` (tri-state — see the field comment below), and
 * `clearance_applied` (the same ceiling detail every `audit_log` entry
 * carries, recorded here at the one uniform public ceiling). This is the
 * reconciliation the issue's `listAuditEntries` wording needed: `POST /ask`
 * (#159) writes *this* log on its personal branch (and the shared usage log
 * on its shared branch), while `audit_log` stays written only by the CLI
 * per-asker path — so the asker-context parity #160 asks for lands here as
 * content parity with #51's column vocabulary, not table parity. Pre-#160
 * rows migrate in place reading null/null/`official_open`: those nulls mean
 * *not recorded* (the columns did not exist), which for rows written through
 * #159's route in the interim window is not the same as "no link"/"no lookup
 * ran" — an append-only trail cannot backfill what was never captured.
 */
export const PUBLIC_ANSWER_OUTCOMES = ["answered", "passed_on", "declined_refused", "corrected"] as const;
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
  /**
   * #160: the verified ask token's id when this ask came through an ask
   * link, null when it did not (paired device, CLI, any other non-link
   * writer). Never the raw secret — the id alone names the link, the same
   * id `duo ask-link list` already shows the owner.
   */
  readonly askLinkId: string | null;
  /**
   * #160: tri-state. `true`/`false` = a `duo/directory.json` lookup ran at
   * answer time and matched/didn't (ask-link asks, including the
   * malformed-directory fallback — an attempted-and-failed lookup); `null`
   * = no lookup ran (device principal "owner", CLI asks) or none was
   * recorded (pre-#160 rows).
   */
  readonly askerResolved: boolean | null;
  /** #160: the classification ceiling this answer was actually filtered through — the personal path always passes `PUBLIC_ANSWER_CLEARANCE_CEILING`. Same type as `audit_log`'s identically-named column. */
  readonly clearanceApplied: ClassificationLevel;
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
  ask_link_id: string | null;
  asker_resolved: number | null;
  clearance_applied: string;
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
    askLinkId: row.ask_link_id,
    askerResolved: row.asker_resolved === null ? null : row.asker_resolved === 1,
    clearanceApplied: row.clearance_applied as ClassificationLevel,
  };
}

/**
 * Columns #160 added to `public_answer_log` after its first release, in the
 * same shape as `DRAFT_LOG_MIGRATIONS`: `CREATE TABLE IF NOT EXISTS` is a
 * no-op against a table an already-running `duo serve` or an earlier `duo
 * permissions ask-public` created, so each new column needs an additive
 * `ALTER TABLE … ADD COLUMN` gated on `PRAGMA table_info` — adding columns
 * rewrites no rows, so the append-only triggers and #45's history stay
 * untouched. Defaults are honest reads for pre-#160 rows: NULL for
 * `ask_link_id`/`asker_resolved` means *not recorded* (the columns did not
 * exist; rows written through #159's route in the interim window may in
 * fact have come through a link and had a lookup run), while
 * `clearance_applied`'s default is a true backfill, not a fabrication —
 * every public answer ever written was filtered through exactly
 * `PUBLIC_ANSWER_CLEARANCE_CEILING` = 'official_open'.
 */
const PUBLIC_ANSWER_LOG_MIGRATIONS: readonly { readonly column: string; readonly ddl: string }[] = [
  { column: "ask_link_id", ddl: "ALTER TABLE public_answer_log ADD COLUMN ask_link_id TEXT" },
  { column: "asker_resolved", ddl: "ALTER TABLE public_answer_log ADD COLUMN asker_resolved INTEGER" },
  // Keep the default in sync with PUBLIC_ANSWER_CLEARANCE_CEILING (public-answer.ts)
  // — a SQL DDL literal can't reference a TS constant directly.
  { column: "clearance_applied", ddl: "ALTER TABLE public_answer_log ADD COLUMN clearance_applied TEXT NOT NULL DEFAULT 'official_open'" },
];

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
      corrects_entry_id TEXT,
      ask_link_id TEXT,
      asker_resolved INTEGER,
      -- Keep in sync with PUBLIC_ANSWER_CLEARANCE_CEILING (public-answer.ts)
      -- — a SQL DDL literal can't reference a TS constant directly.
      clearance_applied TEXT NOT NULL DEFAULT 'official_open'
    ) STRICT
  `);
  const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(public_answer_log)`).all() as unknown as { name: string }[]).map((row) => row.name),
  );
  for (const migration of PUBLIC_ANSWER_LOG_MIGRATIONS) {
    if (!existingColumns.has(migration.column)) {
      db.exec(migration.ddl);
    }
  }
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
        (id, created_at, question, asker_ref, topic_id, outcome, text, draft_id, corrects_entry_id, ask_link_id, asker_resolved, clearance_applied)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      createdAt,
      input.question,
      input.askerRef,
      input.topicId,
      input.outcome,
      input.text,
      input.draftId,
      input.correctsEntryId ?? null,
      input.askLinkId,
      input.askerResolved === null ? null : input.askerResolved ? 1 : 0,
      input.clearanceApplied,
    );
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
