import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD } from "../config.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/** One source a draft (or its escalation explanation) cites — a rule or a piece of retrieved evidence, rendered as a short, human-readable link. */
export interface DraftSource {
  readonly kind: "rule" | "evidence";
  readonly id: string;
  readonly label: string;
}

/**
 * "escalation_answered" (added alongside `refused`/`escalationThreshold`):
 * the owner answered an escalated draft on the spot (#34 AC3,
 * `standing-order-candidates.ts`), which queues a standing-order
 * candidate but was never recording an outcome — an escalation this
 * happened to had no way to ever leave `outcome IS NULL` ("pending"),
 * so a client's pending-review queue kept showing it forever, and
 * re-showing the answer box on every reload invited a duplicate answer.
 * Not set by hand via `duo draft-outcome` in the ordinary case (that
 * command is for a *sent* draft's disposition) — `standing-order-
 * candidates.ts` sets it automatically the moment an answer is queued.
 */
export const DRAFT_OUTCOMES = ["sent", "edited", "discarded", "escalation_answered"] as const;
export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];

/**
 * One `duo draft` call, in full — durable enough for the correction loop
 * and the offline eval (v1-tech-design.md §1.9/§1.10) to both read later,
 * matching #48-#51's precedent of building a permission/audit surface
 * ahead of its first real consumer.
 */
export interface DraftRecord {
  readonly id: string;
  readonly question: string;
  readonly threadContext: string | null;
  /** The draft's own text — null when escalated (#34), so there is never a confident-sounding draft attached to an escalation. */
  readonly draftText: string | null;
  readonly escalated: boolean;
  readonly escalationReason: string | null;
  readonly confidenceScore: number;
  readonly sources: readonly DraftSource[];
  readonly createdAt: string;
  readonly outcome: DraftOutcome | null;
  readonly outcomeRecordedAt: string | null;
  /**
   * The text actually sent, when the owner supplied it while recording the
   * outcome. Needed at all by the correction loop (v1-tech-design.md §1.9,
   * epic e7) to diff draft vs sent — without it there is nothing to
   * classify. Null for "discarded" (nothing was sent), for a "sent" outcome
   * recorded without it (draftText is assumed unchanged), and for any draft
   * recorded before this field existed.
   */
  readonly sentText: string | null;
  /**
   * True for a refused-subject escalation (#34 AC2), false for every
   * other escalation and for a non-escalated draft. Persisted rather than
   * reconstructed from `escalationReason`'s text, because that text is
   * meant for a human to read, not for a caller to pattern-match — a
   * future rewording of the refusal message must never silently change
   * whether a client thinks a question was refused or just uncertain.
   * Defaults to `false` for any draft recorded before this field existed.
   */
  readonly refused: boolean;
  /**
   * The composite-confidence escalation threshold in effect when this
   * draft was generated (`DuoConfig["confidence"].escalationThreshold`)
   * — persisted so a client can render a confidence indicator (e.g. a
   * hairline) against the threshold that was actually applied, rather
   * than a hardcoded guess that drifts the moment the threshold is
   * reconfigured. Defaults to the shipped default (0.55) for any draft
   * recorded before this field existed.
   */
  readonly escalationThreshold: number;
}

/**
 * Columns added to `drafts` after its first release, each with the
 * default a pre-existing row should read as. `CREATE TABLE IF NOT
 * EXISTS` is a no-op against a table that already exists — it does
 * nothing to add a column to a `drafts` table created by an
 * already-running `duo serve` or an earlier `duo draft` call, so a
 * bare schema-string change here would throw "table drafts has no
 * column named …" on the very next `appendDraft` against that
 * pre-existing store. `ensureDraftLogSchema` below applies these via
 * `ALTER TABLE … ADD COLUMN` against any table that predates them,
 * checked with `PRAGMA table_info` so this stays a no-op once a store
 * is already current.
 */
const DRAFT_LOG_MIGRATIONS: readonly { readonly column: string; readonly ddl: string }[] = [
  { column: "refused", ddl: "ALTER TABLE drafts ADD COLUMN refused INTEGER NOT NULL DEFAULT 0" },
  { column: "escalation_threshold", ddl: "ALTER TABLE drafts ADD COLUMN escalation_threshold REAL NOT NULL DEFAULT 0.55" },
];

export function ensureDraftLogSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      thread_context TEXT,
      draft_text TEXT,
      escalated INTEGER NOT NULL,
      escalation_reason TEXT,
      confidence_score REAL NOT NULL,
      sources TEXT NOT NULL,
      created_at TEXT NOT NULL,
      outcome TEXT,
      outcome_recorded_at TEXT,
      sent_text TEXT,
      refused INTEGER NOT NULL DEFAULT 0,
      -- Keep in sync with DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD (config.ts)
      -- — a SQL DDL literal can't reference a TS constant directly.
      escalation_threshold REAL NOT NULL DEFAULT 0.55
    ) STRICT
  `);

  const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(drafts)`).all() as unknown as { name: string }[]).map((row) => row.name),
  );
  for (const migration of DRAFT_LOG_MIGRATIONS) {
    if (!existingColumns.has(migration.column)) {
      db.exec(migration.ddl);
    }
  }
}

export interface AppendDraftInput {
  readonly question: string;
  readonly threadContext: string | null;
  readonly draftText: string | null;
  readonly escalated: boolean;
  readonly escalationReason: string | null;
  readonly confidenceScore: number;
  readonly sources: readonly DraftSource[];
  /** See `DraftRecord.refused`'s doc comment. `false` for a non-escalated draft. Optional — defaults to `false`, the correct value for every caller that isn't drafting/pipeline.ts's refused-subject path. */
  readonly refused?: boolean;
  /** See `DraftRecord.escalationThreshold`'s doc comment — the threshold in effect for this call. Optional — defaults to `DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD` (config.ts) for a caller that isn't threading a real `DuoConfig["confidence"]` through. */
  readonly escalationThreshold?: number;
}

/** Appends one draft (answered or escalated) and returns its id. */
export function appendDraft(storePath: string, passphrase: string, input: AppendDraftInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    db.prepare(
      `
      INSERT INTO drafts (id, question, thread_context, draft_text, escalated, escalation_reason, confidence_score, sources, created_at, outcome, outcome_recorded_at, refused, escalation_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `,
    ).run(
      id,
      input.question,
      input.threadContext,
      input.draftText,
      input.escalated ? 1 : 0,
      input.escalationReason,
      input.confidenceScore,
      JSON.stringify(input.sources),
      createdAt,
      input.refused ? 1 : 0,
      input.escalationThreshold ?? DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD,
    );
  });
  return id;
}

/** Thrown by recordDraftOutcome when no draft with the given id exists — a typo'd id should fail loudly, not silently no-op. */
export class DraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(`No draft found with id "${draftId}"`);
    this.name = "DraftNotFoundError";
  }
}

/**
 * Records the owner's disposition of a draft — sent, edited, or discarded
 * (#32 AC3) — against its own row, for the correction loop and the eval to
 * both read later. `sentText` is optional (existing callers that only
 * record the outcome keep working unchanged) but is what #37's
 * classification needs to run at all: an "edited" outcome recorded without
 * it simply produces no correction candidate, rather than failing the call.
 */
export function recordDraftOutcome(
  storePath: string,
  passphrase: string,
  draftId: string,
  outcome: DraftOutcome,
  sentText?: string,
): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    const result = db
      .prepare(`UPDATE drafts SET outcome = ?, outcome_recorded_at = ?, sent_text = ? WHERE id = ?`)
      .run(outcome, new Date().toISOString(), sentText ?? null, draftId);
    if (result.changes === 0) {
      throw new DraftNotFoundError(draftId);
    }
  });
}

interface DraftRow {
  id: string;
  question: string;
  thread_context: string | null;
  draft_text: string | null;
  escalated: number;
  escalation_reason: string | null;
  confidence_score: number;
  sources: string;
  created_at: string;
  outcome: string | null;
  outcome_recorded_at: string | null;
  sent_text: string | null;
  refused: number;
  escalation_threshold: number;
}

function rowToDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    question: row.question,
    threadContext: row.thread_context,
    draftText: row.draft_text,
    escalated: row.escalated === 1,
    escalationReason: row.escalation_reason,
    confidenceScore: row.confidence_score,
    sources: JSON.parse(row.sources) as DraftSource[],
    createdAt: row.created_at,
    outcome: row.outcome as DraftOutcome | null,
    outcomeRecordedAt: row.outcome_recorded_at,
    sentText: row.sent_text,
    refused: row.refused === 1,
    escalationThreshold: row.escalation_threshold,
  };
}

export function getDraft(storePath: string, passphrase: string, draftId: string): DraftRecord | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDraftLogSchema(db);
    const row = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(draftId) as DraftRow | undefined;
    return row ? rowToDraft(row) : undefined;
  });
}

export interface ListDraftsOptions {
  /** `"pending"` = never dispositioned (`outcome IS NULL`) — what a Review surface wants, so an untouched draft is never lost in the full log. A concrete `DraftOutcome` narrows to that outcome only. Omit for every draft, matching the original unfiltered behaviour. */
  readonly outcome?: DraftOutcome | "pending";
  /** Only drafts created strictly before this ISO timestamp — paging backward through history once the current page has been read. */
  readonly before?: string;
  /** Caps the number of rows returned. Omit for no cap. */
  readonly limit?: number;
}

/**
 * Every draft, oldest first, optionally filtered and paged. Filtering
 * happens in SQL, not after the fact in JS — a `duo serve` Review surface
 * polling for `{ outcome: "pending" }` must not pull the entire draft log
 * over the wire on every poll (`client-tech-design.md` G-b).
 */
export function listDrafts(storePath: string, passphrase: string, options: ListDraftsOptions = {}): DraftRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDraftLogSchema(db);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.outcome === "pending") {
      clauses.push("outcome IS NULL");
    } else if (options.outcome !== undefined) {
      clauses.push("outcome = ?");
      params.push(options.outcome);
    }
    if (options.before !== undefined) {
      clauses.push("created_at < ?");
      params.push(options.before);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = options.limit !== undefined ? "LIMIT ?" : "";
    if (options.limit !== undefined) {
      params.push(options.limit);
    }
    const rows = db.prepare(`SELECT * FROM drafts ${where} ORDER BY created_at, id ${limitClause}`).all(...params) as unknown as DraftRow[];
    return rows.map(rowToDraft);
  });
}
