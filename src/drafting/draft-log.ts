import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD } from "../config.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * One source a draft (or its escalation explanation) cites — a standing
 * order, a piece of retrieved evidence, or (#190) a file the asker
 * attached to the question — rendered as a short, human-readable link.
 * The attachment kind carries `id` + `label` only (the workspace's file
 * reference and a stripped preview): the bytes grounded the one draft and
 * were then dropped, so the row is a dead-link-plus-honest-label once the
 * workspace deletes the file — the same treatment the audit trail gives
 * every other reference to something outside the store
 * (docs/workspace/attachments.md §3).
 */
export interface DraftSource {
  readonly kind: "rule" | "evidence" | "attachment";
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
 * Why the owner dismissed a draft (#259 in guangshinhaha/duo) — an optional,
 * one-tap follow-up to a `"discarded"` outcome, never required (a silent
 * dismissal must keep working exactly as before). Only meaningful alongside
 * `"discarded"`: recording one against any other outcome is refused by
 * `recordDraftOutcomeAndClassify` (`corrections/classify.ts`), the same layer
 * that already refuses a blank "edited" `sentText`.
 *
 * `"shouldnt_answer"` is the one value with a second life: the client offers
 * to turn it into a never-answer rule (the trust epic, #269 in
 * guangshinhaha/duo). That rule store does not exist in this daemon yet, so
 * for now this is only ever stored as a signal on the draft row — see this
 * field's own doc comment on `DraftRecord`.
 */
export const DISMISS_REASONS = ["wrong_facts", "wrong_tone", "shouldnt_answer", "will_handle_myself"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

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
  /** `eventId` is the channel's own reference for the posted message (a Matrix event id, opaque to the client) — present only when the adapter that delivered it had one to give (digital-duo#247). */
  | { readonly state: "delivered"; readonly eventId?: string }
  | { readonly state: "failed"; readonly reason: string };

/**
 * Who a draft is addressed to (guangshinhaha/duo#262) — the person (or, for a
 * group conversation, the room) the owner would be writing to. Optional
 * everywhere: an owner-asked draft with no stated recipient is still a draft.
 * `id` is the stable key per-recipient voice adaptation groups sends by
 * (`drafting/recipient-voice.ts`); `name` is display-only ("Tuned for how you
 * write to Wei") and also lets the adaptation measure first-name use.
 */
export interface DraftRecipient {
  readonly id: string;
  readonly name: string | null;
}

/**
 * One candidate reply among several the pipeline offered for the same
 * question (guangshinhaha/duo#257) — written only when the draft was
 * hedged (above the escalation threshold, but not by much) and more than
 * one genuinely different candidate survived generation. Every candidate
 * shares one evidence pool: `sources` is the same list the draft row
 * carries, kept per candidate so a reader never has to assume it.
 *
 * Index 0 is the pipeline's own default draft (`instruction` null); the
 * rest each answered one distinct instruction (`"shorter"`, `"cautious"` —
 * see generate.ts's ALTERNATIVE_INSTRUCTIONS). `text` is the candidate's
 * current text, so a shape (#258) applied to one candidate rewrites it here.
 */
export interface DraftAlternative {
  readonly text: string;
  readonly instruction: string | null;
  readonly confidenceScore: number;
  readonly sources: readonly DraftSource[];
  /**
   * Derived on read, never stored: `"chosen"` for the one the owner sent or
   * kept, `"not_chosen"` for the others (and for every candidate of a
   * dismissed draft), null while the draft is still pending. The passed-over
   * candidates are the training signal #257 asks for.
   */
  readonly outcome: "chosen" | "not_chosen" | null;
}

/** The instructions a shape (guangshinhaha/duo#258) may carry — a closed set, so each tap is a clean categorical preference signal. */
export const SHAPE_INSTRUCTIONS = ["shorter", "warmer", "more_formal", "more_direct"] as const;
export type ShapeInstruction = (typeof SHAPE_INSTRUCTIONS)[number];

/**
 * One shape applied to a pending draft (guangshinhaha/duo#258): which
 * candidate it rewrote, with which instruction, and whether the owner took
 * it back. Each one is a training signal in its own right — the texts it
 * swapped between stay in the `draft_shapes` table for the correction loop
 * to read; the record carries only what a surface needs to offer Undo.
 */
export interface DraftShape {
  readonly id: string;
  readonly alternative: number;
  readonly instruction: ShapeInstruction;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

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
  /**
   * Why the owner dismissed this draft (#259 in guangshinhaha/duo) — set
   * only when `outcome` is `"discarded"` and the owner picked a reason; null
   * for a silent dismissal (the common case, always allowed), for every
   * other outcome, and for any draft recorded before this field existed.
   * Queryable here, not rendered anywhere yet, so the Activity tab (#267 in
   * guangshinhaha/duo) has a column to read once it exists.
   */
  readonly dismissReason: DismissReason | null;
  /** Who this draft was addressed to (duo#262) — see `DraftRecipient`. Null when none was stated, and for any draft recorded before this field existed. Its sent/edited text is what per-recipient adaptation learns from. */
  readonly recipient: DraftRecipient | null;
  /** True when this draft's prompt was conditioned on how the owner writes to `recipient` (duo#262) — what a Why panel reads to say "Tuned for how you write to Wei". False for every draft recorded before this field existed. */
  readonly adaptedForRecipient: boolean;
  /**
   * The candidates offered for this question (guangshinhaha/duo#257) —
   * empty when there was only ever one draft, which is every confident
   * draft, every escalation, and every row recorded before this field
   * existed. While pending, `draftText` is candidate 0's text; once the
   * owner sends or keeps candidate N, `draftText`, `sources` and
   * `confidenceScore` become candidate N's, so the correction loop and
   * delivery read what was actually chosen.
   */
  readonly alternatives: readonly DraftAlternative[];
  /** Which candidate the owner sent or kept — null while pending, for a dismissed draft, and for a draft with no alternatives. */
  readonly chosenAlternative: number | null;
  /** Every shape applied to this draft, oldest first (guangshinhaha/duo#258) — empty when none. */
  readonly shapes: readonly DraftShape[];
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
  // NULL on a pre-existing row and on any delivery whose adapter had no
  // reference to give — rowToDraft reads a NULL event id as simply absent,
  // never a fabricated one (digital-duo#247).
  { column: "delivery_event_id", ddl: "ALTER TABLE drafts ADD COLUMN delivery_event_id TEXT" },
  // NULL on a pre-existing row and on any draft that was never dismissed
  // with a reason — rowToDraft reads a NULL dismiss_reason as simply absent
  // (guangshinhaha/duo#259).
  { column: "dismiss_reason", ddl: "ALTER TABLE drafts ADD COLUMN dismiss_reason TEXT" },
  // duo#262: NULL recipient on a pre-existing row (no recipient was ever
  // stated), and 0 for "adapted" — a draft written before adaptation existed
  // was, honestly, never adapted.
  { column: "recipient_ref", ddl: "ALTER TABLE drafts ADD COLUMN recipient_ref TEXT" },
  { column: "recipient_name", ddl: "ALTER TABLE drafts ADD COLUMN recipient_name TEXT" },
  { column: "adapted_for_recipient", ddl: "ALTER TABLE drafts ADD COLUMN adapted_for_recipient INTEGER NOT NULL DEFAULT 0" },
  // Both NULL on a pre-existing row (guangshinhaha/duo#257): it had one
  // draft and nothing to choose between — rowToDraft reads that as no
  // alternatives and no chosen index.
  { column: "alternatives", ddl: "ALTER TABLE drafts ADD COLUMN alternatives TEXT" },
  { column: "chosen_alternative", ddl: "ALTER TABLE drafts ADD COLUMN chosen_alternative INTEGER" },
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
      delivery_reason TEXT,
      delivery_event_id TEXT,
      dismiss_reason TEXT,
      recipient_ref TEXT,
      recipient_name TEXT,
      adapted_for_recipient INTEGER NOT NULL DEFAULT 0,
      alternatives TEXT,
      chosen_alternative INTEGER
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

  // guangshinhaha/duo#258: one row per shape applied to a pending draft.
  // A table of its own rather than a JSON column on `drafts`, because each
  // row is a training signal the correction loop reads on its own (and
  // `recipient_key` is what later drafts to the same person look up).
  db.exec(`
    CREATE TABLE IF NOT EXISTS draft_shapes (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      alternative INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      from_text TEXT NOT NULL,
      to_text TEXT NOT NULL,
      recipient_key TEXT,
      created_at TEXT NOT NULL,
      undone_at TEXT
    ) STRICT
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS draft_shapes_draft ON draft_shapes (draft_id)`);
}

/**
 * Who a draft is ultimately to, as a stable key (guangshinhaha/duo#258's
 * "toward one person"): the named recipient when the draft has one (duo#262's
 * `DraftRecipient` — the same id per-recipient voice groups by), else the
 * asker on a channel for a channel-asked draft, else the owner themself for
 * an owner-asked one. `undefined` for a row whose origin is unknown and that
 * names no recipient — a shape there is still logged, it just can't teach
 * anything about a person.
 */
export function recipientKeyOf(provenance: DraftProvenance, recipient: DraftRecipient | null = null): string | undefined {
  if (recipient !== null) {
    return `recipient:${recipient.id}`;
  }
  if (provenance.origin === "owner") {
    return "owner";
  }
  if (provenance.origin === "channel") {
    return `channel:${provenance.channelKind}:${provenance.askerRef}`;
  }
  return undefined;
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
  /** Who the draft is addressed to (duo#262) — see `DraftRecipient`. Optional; omitted stores NULL. */
  readonly recipient?: DraftRecipient | null;
  /** Whether generation was conditioned on the recipient's learned style (duo#262). Optional; defaults to `false`. */
  readonly adaptedForRecipient?: boolean;
  /**
   * guangshinhaha/duo#257: every candidate offered, index 0 being the
   * default draft (whose text must equal `draftText`). Optional — omitted,
   * or fewer than two, stores NULL: a single draft has no alternatives.
   */
  readonly alternatives?: readonly Omit<DraftAlternative, "outcome">[];
}

/** Appends one draft (answered or escalated) and returns its id. */
export function appendDraft(storePath: string, passphrase: string, input: AppendDraftInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    db.prepare(
      `
      INSERT INTO drafts (id, question, thread_context, draft_text, escalated, escalation_reason, confidence_score, sources, created_at, outcome, outcome_recorded_at, refused, escalation_threshold, provenance, recipient_ref, recipient_name, adapted_for_recipient, alternatives)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
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
      input.recipient?.id ?? null,
      input.recipient?.name ?? null,
      input.adaptedForRecipient ? 1 : 0,
      input.alternatives && input.alternatives.length > 1 ? JSON.stringify(input.alternatives.map(storedAlternative)) : null,
    );
  });
  return id;
}

/** The stored shape of one candidate — exactly these fields, so a derived `outcome` passed in by mistake never lands in the column. */
function storedAlternative(alternative: Omit<DraftAlternative, "outcome">): Omit<DraftAlternative, "outcome"> {
  return {
    text: alternative.text,
    instruction: alternative.instruction,
    confidenceScore: alternative.confidenceScore,
    sources: alternative.sources,
  };
}

/** Thrown by recordDraftOutcome when no draft with the given id exists — a typo'd id should fail loudly, not silently no-op. */
export class DraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(`No draft found with id "${draftId}"`);
    this.name = "DraftNotFoundError";
  }
}

/**
 * Thrown by `recordOutcomeAndDeliver` (`drafting/delivery.ts`) for a draft
 * that already has an outcome (#262). Recording a second outcome on a
 * settled draft would also hand `sent`/`edited` text to the draft's origin
 * channel a second time — `POST /drafts/:id/outcome` and `duo draft-outcome`
 * both route through `recordOutcomeAndDeliver`, so refusing there, before
 * anything is written or delivered, protects both surfaces at once. Named
 * the same way the MCP tools' own settled-draft guard (#260,
 * `serve/mcp-tools.ts`'s `settleDraft`) already reads it, for a consistent
 * message across every surface that can record an outcome.
 *
 * Deliberately not thrown from `recordDraftOutcome` itself: that function is
 * also how the calibration eval (`derivation/calibration.ts`) re-judges an
 * item, which is expected to overwrite a prior judgement's outcome freely
 * and never goes near a channel — guarding it there would break that
 * legitimate re-judging flow for a case delivery can never reach.
 */
export class DraftAlreadySettledError extends Error {
  constructor(draftId: string, outcome: DraftOutcome) {
    super(`Draft "${draftId}" was already recorded as "${outcome}" — refusing to record a second outcome, so nothing was delivered again.`);
    this.name = "DraftAlreadySettledError";
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
 *
 * `dismissReason` (#259 in guangshinhaha/duo) is optional and stored
 * verbatim — this function trusts its caller the same way it already trusts
 * `outcome`: the "only alongside `discarded`" rule is enforced one layer up,
 * in `recordDraftOutcomeAndClassify` (`corrections/classify.ts`), the same
 * place the blank-"edited" rule already lives, not here.
 */
export function recordDraftOutcome(
  storePath: string,
  passphrase: string,
  draftId: string,
  outcome: SettableDraftOutcome,
  sentText?: string,
  dismissReason?: DismissReason,
): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    const result = db
      .prepare(`UPDATE drafts SET outcome = ?, outcome_recorded_at = ?, sent_text = ?, dismiss_reason = ? WHERE id = ?`)
      .run(outcome, new Date().toISOString(), sentText ?? null, dismissReason ?? null, draftId);
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
      .prepare(`UPDATE drafts SET delivery_state = ?, delivery_reason = ?, delivery_event_id = ? WHERE id = ?`)
      .run(
        delivery.state,
        delivery.state === "failed" ? delivery.reason : null,
        delivery.state === "delivered" ? (delivery.eventId ?? null) : null,
        draftId,
      );
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
  delivery_event_id: string | null;
  dismiss_reason: string | null;
  recipient_ref: string | null;
  recipient_name: string | null;
  adapted_for_recipient: number;
  alternatives: string | null;
  chosen_alternative: number | null;
}

/**
 * Parses a stored dismiss-reason string into a `DismissReason`, falling
 * back to null for NULL or any value outside `DISMISS_REASONS` — the same
 * defensive reading `parseProvenance` gives its own column, so a corrupted
 * or pre-#259 cell never takes `getDraft`/`listDrafts` down with it.
 */
function parseDismissReason(raw: string | null): DismissReason | null {
  return raw !== null && (DISMISS_REASONS as readonly string[]).includes(raw) ? (raw as DismissReason) : null;
}

interface ShapeRow {
  id: string;
  draft_id: string;
  alternative: number;
  instruction: string;
  from_text: string;
  to_text: string;
  recipient_key: string | null;
  created_at: string;
  undone_at: string | null;
}

/**
 * Parses the stored candidates (guangshinhaha/duo#257), deriving each one's
 * chosen/not-chosen outcome from the row. Defensive like parseProvenance:
 * an unreadable cell reads as no alternatives — the row still has its one
 * draft — rather than taking the whole draft log down.
 */
function parseAlternatives(raw: string | null, outcome: string | null, chosen: number | null): DraftAlternative[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const alternatives: DraftAlternative[] = [];
  for (const [index, entry] of parsed.entries()) {
    const candidate = entry as Partial<Omit<DraftAlternative, "outcome">> | null;
    if (!candidate || typeof candidate.text !== "string" || typeof candidate.confidenceScore !== "number" || !Array.isArray(candidate.sources)) {
      return [];
    }
    alternatives.push({
      text: candidate.text,
      instruction: typeof candidate.instruction === "string" ? candidate.instruction : null,
      confidenceScore: candidate.confidenceScore,
      sources: candidate.sources,
      outcome: outcome === null ? null : chosen === index ? "chosen" : "not_chosen",
    });
  }
  return alternatives;
}

function rowToShape(row: ShapeRow): DraftShape {
  return {
    id: row.id,
    alternative: row.alternative,
    instruction: row.instruction as ShapeInstruction,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  };
}

/** Every shape for the given drafts, grouped by draft id, oldest first. */
function readShapesFor(db: Database, draftIds: readonly string[]): Map<string, DraftShape[]> {
  const grouped = new Map<string, DraftShape[]>();
  // Chunked: an un-paged listDrafts can hand over the whole log, and one
  // IN (…) per chunk keeps every statement well under SQLite's bound-
  // parameter ceiling however long the log grows.
  for (let start = 0; start < draftIds.length; start += 500) {
    const chunk = draftIds.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM draft_shapes WHERE draft_id IN (${placeholders}) ORDER BY created_at, id`)
      .all(...chunk) as unknown as ShapeRow[];
    for (const row of rows) {
      const list = grouped.get(row.draft_id) ?? [];
      list.push(rowToShape(row));
      grouped.set(row.draft_id, list);
    }
  }
  return grouped;
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

function rowToDraft(row: DraftRow, shapes: readonly DraftShape[] = []): DraftRecord {
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
          ? { state: "delivered", ...(row.delivery_event_id !== null ? { eventId: row.delivery_event_id } : {}) }
          : row.delivery_state === "failed"
            ? { state: "failed", reason: row.delivery_reason ?? "delivery failed" }
            : null,
    dismissReason: parseDismissReason(row.dismiss_reason),
    recipient: row.recipient_ref !== null ? { id: row.recipient_ref, name: row.recipient_name } : null,
    adaptedForRecipient: row.adapted_for_recipient === 1,
    alternatives: parseAlternatives(row.alternatives, row.outcome, row.chosen_alternative),
    chosenAlternative: row.chosen_alternative,
    shapes,
  };
}

function readDraft(db: Database, draftId: string): DraftRecord | undefined {
  const row = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(draftId) as DraftRow | undefined;
  return row ? rowToDraft(row, readShapesFor(db, [row.id]).get(row.id)) : undefined;
}

export function getDraft(storePath: string, passphrase: string, draftId: string): DraftRecord | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDraftLogSchema(db);
    return readDraft(db, draftId);
  });
}

/** Thrown for an alternative index a draft does not have (guangshinhaha/duo#257) — a client bug, never silently clamped to a candidate the owner did not pick. */
export class UnknownAlternativeError extends Error {
  constructor(draftId: string, index: number, count: number) {
    super(
      count > 1
        ? `Draft "${draftId}" has alternatives 0–${count - 1}; there is no alternative ${index}.`
        : `Draft "${draftId}" has no alternatives; only alternative 0 (the draft itself) can be chosen, not ${index}.`,
    );
    this.name = "UnknownAlternativeError";
  }
}

/**
 * Records which candidate the owner is sending or keeping
 * (guangshinhaha/duo#257) — called just ahead of the outcome itself, by
 * `recordOutcomeAndDeliver`. Makes the chosen candidate the row's draft:
 * `draftText`, `sources` and `confidenceScore` become its, so the edit diff
 * the correction loop classifies and the text delivery hands to a channel
 * are both the candidate that was actually picked. The full candidate set
 * stays in `alternatives`, so the passed-over ones remain readable as "not
 * chosen". A draft with no alternatives accepts only index 0 and changes
 * nothing.
 */
export function chooseAlternative(storePath: string, passphrase: string, draftId: string, index: number): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    const draft = readDraft(db, draftId);
    if (!draft) {
      throw new DraftNotFoundError(draftId);
    }
    const count = draft.alternatives.length;
    if (!Number.isInteger(index) || index < 0 || (count === 0 ? index !== 0 : index >= count)) {
      throw new UnknownAlternativeError(draftId, index, count);
    }
    if (count === 0) {
      return;
    }
    const chosen = draft.alternatives[index];
    db.prepare(`UPDATE drafts SET draft_text = ?, sources = ?, confidence_score = ?, chosen_alternative = ? WHERE id = ?`).run(
      chosen.text,
      JSON.stringify(chosen.sources),
      chosen.confidenceScore,
      index,
      draftId,
    );
  });
}

/** Thrown when a shape or its undo is asked of a draft that cannot take one (#258): escalated, already settled, or with nothing to undo. */
export class DraftNotShapeableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftNotShapeableError";
  }
}

/** A draft's current text for one candidate: `alternatives[i].text` when it has alternatives, else `draftText` (index 0 only). */
export function currentCandidateText(draft: DraftRecord, alternative: number): string {
  if (draft.alternatives.length === 0) {
    if (alternative !== 0) {
      throw new UnknownAlternativeError(draft.id, alternative, 0);
    }
    return draft.draftText ?? "";
  }
  const candidate = draft.alternatives[alternative];
  if (!Number.isInteger(alternative) || candidate === undefined) {
    throw new UnknownAlternativeError(draft.id, alternative, draft.alternatives.length);
  }
  return candidate.text;
}

/** Writes one candidate's text, keeping `draft_text` in step with candidate 0 (the invariant a pending row holds). */
function writeCandidateText(db: Database, draft: DraftRecord, alternative: number, text: string): void {
  if (draft.alternatives.length === 0) {
    db.prepare(`UPDATE drafts SET draft_text = ? WHERE id = ?`).run(text, draft.id);
    return;
  }
  const stored = draft.alternatives.map((candidate, index) => storedAlternative(index === alternative ? { ...candidate, text } : candidate));
  db.prepare(`UPDATE drafts SET alternatives = ? WHERE id = ?`).run(JSON.stringify(stored), draft.id);
  if (alternative === 0) {
    db.prepare(`UPDATE drafts SET draft_text = ? WHERE id = ?`).run(text, draft.id);
  }
}

function assertShapeable(draft: DraftRecord): void {
  if (draft.escalated || draft.draftText === null) {
    throw new DraftNotShapeableError(`Draft "${draft.id}" was passed to you, not drafted — there is no draft text to shape.`);
  }
  if (draft.outcome !== null) {
    throw new DraftNotShapeableError(`Draft "${draft.id}" was already recorded as "${draft.outcome}" — only a pending draft can be shaped.`);
  }
}

/**
 * Records one shape (guangshinhaha/duo#258) and swaps the candidate's text
 * to the shaped version, atomically. `fromText` is the text the shape was
 * generated from: if the candidate no longer reads that way (a second shape
 * landed first), nothing is written and the call is refused, rather than a
 * stale rewrite silently overwriting a newer one. Returns the updated draft.
 */
export function recordShape(
  storePath: string,
  passphrase: string,
  draftId: string,
  input: { readonly alternative: number; readonly instruction: ShapeInstruction; readonly fromText: string; readonly toText: string },
): DraftRecord {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    const draft = readDraft(db, draftId);
    if (!draft) {
      throw new DraftNotFoundError(draftId);
    }
    assertShapeable(draft);
    if (currentCandidateText(draft, input.alternative) !== input.fromText) {
      throw new DraftNotShapeableError(`Draft "${draftId}" changed while it was being shaped — try again.`);
    }
    db.prepare(
      `INSERT INTO draft_shapes (id, draft_id, alternative, instruction, from_text, to_text, recipient_key, created_at, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(randomUUID(), draftId, input.alternative, input.instruction, input.fromText, input.toText, recipientKeyOf(draft.provenance, draft.recipient) ?? null, new Date().toISOString());
    writeCandidateText(db, draft, input.alternative, input.toText);
    return readDraft(db, draftId) as DraftRecord;
  });
}

/**
 * Takes back the latest shape still standing on one candidate
 * (guangshinhaha/duo#258's one-tap undo): restores the text it replaced and
 * marks it undone — kept, not deleted, because a shape the owner took back
 * is a signal too. Refused when there is nothing to undo, or the candidate
 * has moved on from what that shape wrote.
 */
export function undoLatestShape(storePath: string, passphrase: string, draftId: string, alternative: number): DraftRecord {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureDraftLogSchema(db);
    const draft = readDraft(db, draftId);
    if (!draft) {
      throw new DraftNotFoundError(draftId);
    }
    assertShapeable(draft);
    const current = currentCandidateText(draft, alternative);
    const latest = db
      .prepare(`SELECT * FROM draft_shapes WHERE draft_id = ? AND alternative = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(draftId, alternative) as ShapeRow | undefined;
    if (!latest) {
      throw new DraftNotShapeableError(`Draft "${draftId}" has no shape to undo on alternative ${alternative}.`);
    }
    if (latest.to_text !== current) {
      throw new DraftNotShapeableError(`Draft "${draftId}" changed since its last shape — there is nothing to undo back to.`);
    }
    db.prepare(`UPDATE draft_shapes SET undone_at = ? WHERE id = ?`).run(new Date().toISOString(), latest.id);
    writeCandidateText(db, draft, alternative, latest.from_text);
    return readDraft(db, draftId) as DraftRecord;
  });
}

/** How many standing shapes of one kind, toward one person, before later drafts to them lean that way (guangshinhaha/duo#258 AC3). */
export const SHAPE_PREFERENCE_MIN_COUNT = 3;
/** How far back a preference is read — recent taps only, so a preference the owner has stopped expressing fades. */
const SHAPE_PREFERENCE_WINDOW = 20;

/**
 * The shapes the owner keeps asking for toward one person — every
 * instruction used at least SHAPE_PREFERENCE_MIN_COUNT times among the last
 * SHAPE_PREFERENCE_WINDOW shapes to that recipient, not counting ones taken
 * back. Most-used first. Empty when there is no pattern yet.
 */
export function readShapePreferences(storePath: string, passphrase: string, recipientKey: string): ShapeInstruction[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDraftLogSchema(db);
    const rows = db
      .prepare(`SELECT instruction, undone_at FROM draft_shapes WHERE recipient_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(recipientKey, SHAPE_PREFERENCE_WINDOW) as unknown as { instruction: string; undone_at: string | null }[];
    const counts = new Map<ShapeInstruction, number>();
    for (const row of rows) {
      if (row.undone_at === null && (SHAPE_INSTRUCTIONS as readonly string[]).includes(row.instruction)) {
        const instruction = row.instruction as ShapeInstruction;
        counts.set(instruction, (counts.get(instruction) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= SHAPE_PREFERENCE_MIN_COUNT)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([instruction]) => instruction);
  });
}

export interface ListDraftsOptions {
  /** `"pending"` = never dispositioned (`outcome IS NULL`) — what a Review surface wants, so an untouched draft is never lost in the full log. A concrete `DraftOutcome` narrows to that outcome only. Omit for every draft, matching the original unfiltered behaviour. */
  readonly outcome?: DraftOutcome | "pending";
  /** Only drafts created strictly before this ISO timestamp — paging backward through history once the current page has been read. */
  readonly before?: string;
  /** Caps the number of rows returned and makes the page newest-first (see listDrafts). Omit for no cap. */
  readonly limit?: number;
}

/**
 * Every draft, oldest first, optionally filtered and paged. Filtering
 * happens in SQL, not after the fact in JS — a `duo serve` Review surface
 * polling for `{ outcome: "pending" }` must not pull the entire draft log
 * over the wire on every poll (`client-tech-design.md` G-b).
 *
 * Direction depends on whether a page was asked for. With `limit`, pages
 * are newest-first: `ORDER BY created_at DESC, id DESC` under the same
 * exclusive `before` bound, so page one is the newest window and feeding
 * the oldest item of each page back as `before` walks backward through
 * adjacent windows. The original ascending-`LIMIT` shape — which, combined
 * with a `before` ceiling, could only ever read from the beginning of
 * history and never reached the newest drafts — was a defect (guangshinhaha/duo#29).
 * Without `limit`, the un-paged order stays oldest-first, byte-identical to
 * the behaviour every existing un-paged caller was written against.
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
    // Newest-first exactly when a page size was requested — see the doc
    // comment above for why the un-paged order must not change.
    const order = options.limit !== undefined ? "created_at DESC, id DESC" : "created_at, id";
    const rows = db.prepare(`SELECT * FROM drafts ${where} ORDER BY ${order} ${limitClause}`).all(...params) as unknown as DraftRow[];
    const shapes = readShapesFor(db, rows.map((row) => row.id));
    return rows.map((row) => rowToDraft(row, shapes.get(row.id)));
  });
}
