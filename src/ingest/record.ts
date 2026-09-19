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
  /** Unset by default — field present, logic deferred to the phase-2 permission model. */
  readonly classification: string | null;
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
    classification: asNullableString(raw.classification ?? null, "classification"),
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

/** Builds a fully-formed IngestRecord from adapter input: fills id (content-hashed), classification (unset), and topics (empty at ingest). */
export function createRecord(input: RecordInput): IngestRecord {
  return { ...input, id: computeRecordId(input), classification: null, topics: [] };
}
