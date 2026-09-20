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
 * The outcomes the *owner* can explicitly set — via `duo draft-outcome`
 * or `POST /drafts/:id/outcome` — for a draft the pipeline was confident
 * enough to answer. Deliberately does not include `escalation_answered`
 * (below): that value must only ever be set by
 * `standing-order-candidates.ts`'s own internal call, atomically with the
 * candidate it records, never by a caller of the generic outcome route —
 * an earlier version of this fix added it here instead and a caller could
 * mark any draft (escalated or not, regardless of whether a candidate
 * was ever queued) "answered" with no candidate to back it up.
 */
export const SETTABLE_DRAFT_OUTCOMES = ["sent", "edited", "discarded"] as const;
export type SettableDraftOutcome = (typeof SETTABLE_DRAFT_OUTCOMES)[number];

/**
 * Every value `outcome` can hold once written, including
 * `escalation_answered` — set only by `standing-order-candidates.ts`,
 * atomically with the standing-order candidate it records, the moment
 * the owner answers an escalated draft (#34 AC3). Before this existed, an
 * answered escalation had no way to ever leave `outcome IS NULL`
 * ("pending"), so a client's Review queue kept showing it forever, and
 * reloading re-showed the answer box (client-side "already answered"
 * state doesn't survive a remount), inviting a duplicate answer.
 */
export const DRAFT_OUTCOMES = [...SETTABLE_DRAFT_OUTCOMES, "escalation_answered"] as const;
export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];

/**
 * Where a draft came from (#169), as structured data rather than free
 * text. `threadContext` stays exactly what it is — grounding text for the
 * model — because a free-text string can never answer "which thread, in
 * which channel, asked by whom" reliably, and a client must not infer any
 * of that from prose (a surface inventing behaviour is invariant #1's
 * exact failure mode). Three origins:
 *
 * - `owner` — the owner asked their own duo (`duo draft`, POST /drafts).
 *   No asker, no permalink: it is not a reply to anybody.
 * - `channel` — a channel adapter asked on a person's behalf. The fields
 *   identify the ask and where a delivered answer would land; `threadId`
 *   and `permalink` are nullable because an adapter may genuinely not
 *   have them (an email has no thread id; an IRC adapter may have no
 *   permalink API).
 * - `unknown` — the row predates provenance or its stored JSON is
 *   unreadable. Read defensively, never thrown: an unreadable row must
 *   not take the whole draft log down with it.
 */
export type DraftProvenance =
  | { readonly origin: "owner" }
  | {
      readonly origin: "channel";
      readonly channelKind: string;
      readonly askerRef: string;
      readonly threadId: string | null;
      readonly permalink: string | null;
    }
  | { readonly origin: "unknown" };

/**
 * What happened when a sent draft was handed back to its origin channel
 * (#170) — recorded against the draft, never raised as the outcome call's
 * result, so a transport failure can never cost the training signal. Only
 * channel-origin drafts sent/edited through the delivery seam ever hold a
 * non-null `delivery`; an owner-asked draft delivers nothing by design and
 * stays null (that is not an error), and so does any draft that was never
 * sent.
 *
 * `pending` is durable truth, not a UI nicety: it is written at handoff,
 * before the adapter is ever called, so a daemon that dies mid-delivery
 * leaves an honest row behind.
 */
export type DraftDelivery =
  | { readonly state: "pending" }
  | { readonly state: "delivered" }
  | { readonly state: "failed"; readonly reason: string };

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
  /**
   * Where this draft came from (#169) — see `DraftProvenance`. A row
   * written before the field existed reads `{ origin: "unknown" }`, and
   * so does one whose stored JSON has been corrupted; neither ever
   * throws on read.
   */
  readonly provenance: DraftProvenance;
  /**
   * What became of this draft's delivery back to its origin channel
   * (#170) — see `DraftDelivery`. Null when nothing was ever handed off:
   * an owner-asked draft, a discarded one, or any draft recorded before
   * this field existed.
   */
  readonly delivery: DraftDelivery | null;
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
  // NULL, not a JSON default: a pre-existing row has no provenance, and
  // rowToDraft reads NULL as { origin: "unknown" } — the honest answer for
  // a draft whose origin was never recorded.
  { column: "provenance", ddl: "ALTER TABLE drafts ADD COLUMN provenance TEXT" },
  // Both NULL on a pre-existing row: nothing was ever delivered for it, and
  // rowToDraft reads that as delivery null.
  { column: "delivery_state", ddl: "ALTER TABLE drafts ADD COLUMN delivery_state TEXT" },
  { column: "delivery_reason", ddl: "ALTER TABLE drafts ADD COLUMN delivery_reason TEXT" },
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
      escalation_threshold REAL NOT NULL DEFAULT 0.55,
      provenance TEXT,
      delivery_state TEXT,
      delivery_reason TEXT
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
  /**
   * Where this draft came from (#169) — see `DraftProvenance`. Optional
   * because every pre-#169 caller (tests, eval harness, corrections
   * fixtures) has no origin to declare; omitted stores NULL, which reads
   * back as `{ origin: "unknown" }`. The pipeline and the channel
   * adapters are the callers that set it.
   */
  readonly provenance?: DraftProvenance;
}

/** Appends one draft (answered or escalated) and returns its id. */
export function appendDraft(storePath: string, passphrase: string, input: AppendDraftInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    db.prepare(
      `
      INSERT INTO drafts (id, question, thread_context, draft_text, escalated, escalation_reason, confidence_score, sources, created_at, outcome, outcome_recorded_at, refused, escalation_threshold, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
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
      input.provenance ? JSON.stringify(input.provenance) : null,
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
 *
 * Typed to `SettableDraftOutcome`, not the full `DraftOutcome`, so
 * `escalation_answered` can never reach this function — `queueStandingOrderCandidate`
 * (`standing-order-candidates.ts`) writes that value itself, directly and
 * atomically alongside the candidate row it records, on its own already-open
 * database handle rather than through a second call here.
 */
export function recordDraftOutcome(
  storePath: string,
  passphrase: string,
  draftId: string,
  outcome: SettableDraftOutcome,
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

/**
 * Records what became of a sent draft's delivery back to its origin
 * channel (#170) — the write half of the delivery seam in
 * `drafting/delivery.ts`. Overwrites any prior state, so a re-sent draft
 * tells the truth about its latest attempt. Throws `DraftNotFoundError`
 * for an unknown id, same as `recordDraftOutcome`.
 */
export function recordDeliveryOutcome(
  storePath: string,
  passphrase: string,
  draftId: string,
  delivery: DraftDelivery,
): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    const result = db
      .prepare(`UPDATE drafts SET delivery_state = ?, delivery_reason = ? WHERE id = ?`)
      .run(delivery.state, delivery.state === "failed" ? delivery.reason : null, draftId);
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
  provenance: string | null;
  delivery_state: string | null;
  delivery_reason: string | null;
}

/**
 * Parses a stored provenance JSON string into a `DraftProvenance`, falling
 * back to `{ origin: "unknown" }` for NULL, unparseable JSON, or a value
 * with the wrong shape. Defensive on purpose: the draft log is the
 * product's memory, and one corrupted cell (a truncated write, a manual
 * sqlite edit) must never make every future `getDraft`/`listDrafts` throw —
 * "unknown" is the honest reading of a row whose origin can't be read.
 */
function parseProvenance(raw: string | null): DraftProvenance {
  if (raw === null) {
    return { origin: "unknown" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { origin: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { origin: "unknown" };
  }
  const candidate = parsed as { origin?: unknown; channelKind?: unknown; askerRef?: unknown; threadId?: unknown; permalink?: unknown };
  if (candidate.origin === "owner") {
    return { origin: "owner" };
  }
  if (candidate.origin === "channel" && typeof candidate.channelKind === "string" && typeof candidate.askerRef === "string") {
    return {
      origin: "channel",
      channelKind: candidate.channelKind,
      askerRef: candidate.askerRef,
      threadId: typeof candidate.threadId === "string" ? candidate.threadId : null,
      permalink: typeof candidate.permalink === "string" ? candidate.permalink : null,
    };
  }
  return { origin: "unknown" };
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
    provenance: parseProvenance(row.provenance),
    delivery:
      row.delivery_state === "pending"
        ? { state: "pending" }
        : row.delivery_state === "delivered"
          ? { state: "delivered" }
          : row.delivery_state === "failed"
            ? { state: "failed", reason: row.delivery_reason ?? "delivery failed" }
            : null,
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
