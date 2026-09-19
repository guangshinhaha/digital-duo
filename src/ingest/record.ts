import { createHash } from "node:crypto";

/** `kind` is the load-bearing field (import-adapters.md §2 notes): it decides what a record trains and whether it's ever quotable as a stated position. */
export const RECORD_KINDS = ["question_to_me", "my_answer", "my_thinking", "decision", "artifact"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_AUTHORS = ["me", "other", "assistant"] as const;
export type RecordAuthor = (typeof RECORD_AUTHORS)[number];

/** Drives consent (DMs are opt-in only) and, later, the asker-scoped permission model. */
export const RECORD_AUDIENCES = ["private", "dm", "channel", "public"] as const;
export type RecordAudience = (typeof RECORD_AUDIENCES)[number];

/**
 * The Singapore GSCS tiers this repo's classification model is built on
 * (concept.md §5, v1-tech-design.md §2's "Official (Open)" reference),
 * ordered ascending by sensitivity. #48 reads these off source material; it
 * never assigns or invents them (out of scope: "the duo respects
 * classification, it does not decide it").
 */
export const CLASSIFICATION_LEVELS = ["official_open", "official_closed", "restricted", "confidential", "secret"] as const;
export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

/**
 * What a record's `classification` field may hold: one of the marked
 * levels above, or `"unknown"` when no marking was found. `"unknown"` is
 * deliberately not a sixth level in the ordered hierarchy — it's a
 * separate state with its own rule (see detectClassification and
 * src/permissions/classification.ts's isVisibleToClearance): #48's AC is
 * explicit that unmarked material must never default to the most
 * permissive value.
 */
export const RECORD_CLASSIFICATIONS = [...CLASSIFICATION_LEVELS, "unknown"] as const;
export type RecordClassification = (typeof RECORD_CLASSIFICATIONS)[number];

/**
 * The normalisation layer's one shape (import-adapters.md §2): every
 * adapter maps its source to this and stops, so derivation never has to
 * know which source a record came from. Named `IngestRecord`, not `Record`
 * — the latter would shadow TypeScript's built-in `Record<K, V>` in every
 * file that imports it.
 */
export interface IngestRecord {
  readonly id: string;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly kind: RecordKind;
  readonly author: RecordAuthor;
  readonly text: string;
  readonly timestamp: string;
  readonly threadId: string | null;
  readonly audience: RecordAudience;
  /** Captured at ingest (#48) by reading a marking off the record's own text — never assigned. "unknown" when no marking is found, not defaulted to the most permissive level. */
  readonly classification: RecordClassification;
  /** Always derived downstream; never read from a source. Empty at ingest time. */
  readonly topics: readonly string[];
}

/** What an adapter provides; the store fills in `id`, `classification`, and `topics` (see createRecord). */
export type RecordInput = Omit<IngestRecord, "id" | "classification" | "topics">;

/** Thrown when a value doesn't match the IngestRecord shape. The message always names the offending field. */
export class InvalidRecordError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Invalid record (field "${field}"): ${detail}`);
    this.name = "InvalidRecordError";
    this.field = field;
  }
}

function fail(field: string, detail: string): never {
  throw new InvalidRecordError(field, detail);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(field, `expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    fail(field, `expected a string or null, got ${JSON.stringify(value)}`);
  }
  return value;
}

function asOneOf<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    fail(field, `expected one of ${options.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

const MARKING_LABELS: Readonly<Record<string, ClassificationLevel>> = {
  "official (open)": "official_open",
  "official(open)": "official_open",
  "official open": "official_open",
  "official (closed)": "official_closed",
  "official(closed)": "official_closed",
  "official closed": "official_closed",
  restricted: "restricted",
  confidential: "confidential",
  secret: "secret",
};

/**
 * Reads a classification marking off a record's own first line — the
 * conventional place a GSCS marking appears on a document or message
 * (concept.md §5). Deliberately only the first line, and deliberately
 * anchored at its start: matching the word "confidential" anywhere in a
 * message body would flag ordinary colloquial use ("let's keep this
 * confidential") as a real marking, which is a worse failure than missing
 * one. A marking may still be followed by the message itself on the same
 * line after a colon ("Restricted: see below") — only the part before the
 * first colon is checked in that case; with no colon, the whole first line
 * must match exactly, since there's no delimiter separating a marking from
 * trailing prose. No recognisable marking means `"unknown"` — never a
 * default to `"official_open"`, the most permissive value (#48 AC2).
 */
export function detectClassification(text: string): RecordClassification {
  const firstLine = (text.split("\n", 1)[0] ?? "").trim();
  const colonIndex = firstLine.indexOf(":");
  const candidate = colonIndex === -1 ? firstLine : firstLine.slice(0, colonIndex);
  const normalized = candidate
    .trim()
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return MARKING_LABELS[normalized] ?? "unknown";
}

/**
 * Strips a record's own marking line off its text for display (#50: an
 * answer built from a visible record's text shouldn't echo the raw
 * classification stamp back at an asker who is, by construction, already
 * cleared to see the content beneath it). Only handles the unambiguous
 * case — the whole first line is a bare marking with nothing else on it —
 * the same shape detectClassification's own "no colon" branch recognises;
 * a marking sharing its line with real message text (the colon case) is
 * left untouched rather than risk truncating content it can't cleanly
 * separate.
 */
export function stripMarkingLine(record: Pick<IngestRecord, "text" | "classification">): string {
  if (record.classification === "unknown") {
    return record.text;
  }
  const newlineIndex = record.text.indexOf("\n");
  if (newlineIndex === -1) {
    return record.text; // the whole text is one line — nothing to strip without losing the message itself
  }
  const firstLine = record.text.slice(0, newlineIndex).trim();
  if (firstLine.includes(":")) {
    return record.text; // marking shares its line with real content; leave it alone
  }
  return record.text.slice(newlineIndex + 1).trimStart();
}

function asStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(field, `expected an array of strings, got ${JSON.stringify(value)}`);
  }
  return value as string[];
}

/**
 * Validates an already-parsed value against the IngestRecord shape and
 * returns it typed. Takes `unknown` deliberately — a record can arrive from
 * an adapter, a re-imported JSON blob, or a test literal — so the store's
 * write path can reject a bad record at the boundary, naming the field at
 * fault, rather than trusting its caller's TypeScript types at runtime.
 */
export function parseRecord(value: unknown): IngestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("record", `expected an object, got ${JSON.stringify(value)}`);
  }
  const raw = value as Record<string, unknown>;
  return {
    id: asNonEmptyString(raw.id, "id"),
    source: asNonEmptyString(raw.source, "source"),
    sourceRef: asNullableString(raw.sourceRef, "sourceRef"),
    kind: asOneOf(raw.kind, RECORD_KINDS, "kind"),
    author: asOneOf(raw.author, RECORD_AUTHORS, "author"),
    text: asNonEmptyString(raw.text, "text"),
    timestamp: asNonEmptyString(raw.timestamp, "timestamp"),
    threadId: asNullableString(raw.threadId, "threadId"),
    audience: asOneOf(raw.audience, RECORD_AUDIENCES, "audience"),
    classification: asOneOf(raw.classification, RECORD_CLASSIFICATIONS, "classification"),
    topics: raw.topics === undefined ? [] : asStringArray(raw.topics, "topics"),
  };
}

/**
 * Content-hashes the fields that identify a record's origin and content —
 * never `classification` or `topics`, both mutable/derived downstream — so
 * importing the same source twice always yields the same id
 * (import-adapters.md §5: "emits stable ids so re-import is idempotent").
 */
export function computeRecordId(input: RecordInput): string {
  return createHash("sha256")
    .update(
      [input.source, input.sourceRef ?? "", input.kind, input.author, input.text, input.timestamp, input.threadId ?? ""].join(
        "\u0000",
      ),
    )
    .digest("hex");
}

/** Builds a fully-formed IngestRecord from adapter input: fills id (content-hashed), classification (detected off `input.text`, "unknown" absent a marking — #48), and topics (empty at ingest). */
export function createRecord(input: RecordInput): IngestRecord {
  return { ...input, id: computeRecordId(input), classification: detectClassification(input.text), topics: [] };
}
