import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/** One source a draft (or its escalation explanation) cites — a rule or a piece of retrieved evidence, rendered as a short, human-readable link. */
export interface DraftSource {
  readonly kind: "rule" | "evidence";
  readonly id: string;
  readonly label: string;
}

export const DRAFT_OUTCOMES = ["sent", "edited", "discarded"] as const;
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
}

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
      sent_text TEXT
    ) STRICT
  `);
}

export interface AppendDraftInput {
  readonly question: string;
  readonly threadContext: string | null;
  readonly draftText: string | null;
  readonly escalated: boolean;
  readonly escalationReason: string | null;
  readonly confidenceScore: number;
  readonly sources: readonly DraftSource[];
}

/** Appends one draft (answered or escalated) and returns its id. */
export function appendDraft(storePath: string, passphrase: string, input: AppendDraftInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    db.prepare(
      `
      INSERT INTO drafts (id, question, thread_context, draft_text, escalated, escalation_reason, confidence_score, sources, created_at, outcome, outcome_recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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
  };
}

export function getDraft(storePath: string, passphrase: string, draftId: string): DraftRecord | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDraftLogSchema(db);
    const row = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(draftId) as DraftRow | undefined;
    return row ? rowToDraft(row) : undefined;
  });
}

/** Every draft, oldest first. */
export function listDrafts(storePath: string, passphrase: string): DraftRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDraftLogSchema(db);
    const rows = db.prepare(`SELECT * FROM drafts ORDER BY created_at, id`).all() as unknown as DraftRow[];
    return rows.map(rowToDraft);
  });
}
