import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * duo#275: "pin exact wording — always answer this way." An owner marks one
 * of their own messages as the canonical answer to a question/topic; from
 * then on, that exact text is what the duo gives back for anything matching
 * the pattern — never paraphrased, never re-generated. This is a different
 * object from a standing order (`derivation/rules.ts`): a rule is *derived*
 * from a consistent pattern across many past answers and is only ever a
 * policy statement the model is asked to phrase; a pinned answer is
 * *owner-asserted*, carries its own exact words, and is never run through an
 * LLM at all — the whole point is that the wording itself is pinned.
 *
 * Modeled on `drafting/evidence-exclusions.ts`'s shape (a small reversible
 * table, CRUD exposed directly over HTTP with no CLI twin) rather than
 * `trust/refusals.ts`'s hand-edited markdown file: unlike a refusal, a
 * pinned answer is created and edited from the client (the message action
 * in `docs/vocabulary.md`'s terms — "Duo: always answer this way"), so it
 * needs stable ids a client can address, not a heading a person types by
 * hand. This is also why it does not need #179's trust-surface treatment:
 * it grants no autonomy tier and creates no new capability a draft could
 * not already have (quoting a rule verbatim is exactly what `buildSources`
 * already does for a rule hit) — it only pins *which* words a match uses.
 */
export interface PinnedAnswer {
  readonly id: string;
  /**
   * The question/topic text the owner tied this answer to — matched
   * against a draft's question the same "documented v1 stand-in for real
   * classification" way `trust/refusals.ts`'s `matchesRefusedSubject` and
   * `drafting/relevance-gate.ts` already do: case-insensitive containment,
   * not semantic search. Simple, auditable, and exactly as precise as the
   * owner's own wording — nothing here guesses at intent.
   */
  readonly pattern: string;
  /** The exact wording quoted back verbatim — never rewritten, never run through an inference provider. */
  readonly answerText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * A short label for where this came from — e.g. the room/message the
   * owner pinned it from — purely descriptive, shown back to the owner in
   * the Rules tab. Null for one written with no particular source message
   * (e.g. authored directly against a topic).
   */
  readonly sourceLabel: string | null;
}

export function ensurePinnedAnswersSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_answers (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_label TEXT
    ) STRICT
  `);
}

export class InvalidPinnedAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPinnedAnswerError";
  }
}

export class PinnedAnswerNotFoundError extends Error {
  constructor(id: string) {
    super(`No pinned answer "${id}"`);
    this.name = "PinnedAnswerNotFoundError";
  }
}

interface PinnedAnswerRow {
  id: string;
  pattern: string;
  answer_text: string;
  created_at: string;
  updated_at: string;
  source_label: string | null;
}

function rowToPinnedAnswer(row: PinnedAnswerRow): PinnedAnswer {
  return {
    id: row.id,
    pattern: row.pattern,
    answerText: row.answer_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceLabel: row.source_label,
  };
}

function validate(pattern: string, answerText: string): { pattern: string; answerText: string } {
  const trimmedPattern = pattern.trim();
  const trimmedAnswer = answerText.trim();
  if (trimmedPattern.length === 0) {
    throw new InvalidPinnedAnswerError("A pinned answer needs a non-empty question/topic pattern.");
  }
  if (trimmedAnswer.length === 0) {
    throw new InvalidPinnedAnswerError("A pinned answer needs non-empty wording to pin.");
  }
  return { pattern: trimmedPattern, answerText: trimmedAnswer };
}

/** Newest first — same ordering convention as `listExcludedEvidence`. */
export function listPinnedAnswers(storePath: string, passphrase: string): PinnedAnswer[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePinnedAnswersSchema(db);
    const rows = db.prepare(`SELECT * FROM pinned_answers ORDER BY created_at DESC`).all() as unknown as PinnedAnswerRow[];
    return rows.map(rowToPinnedAnswer);
  });
}

export function getPinnedAnswer(storePath: string, passphrase: string, id: string): PinnedAnswer | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePinnedAnswersSchema(db);
    const row = db.prepare(`SELECT * FROM pinned_answers WHERE id = ?`).get(id) as PinnedAnswerRow | undefined;
    return row ? rowToPinnedAnswer(row) : undefined;
  });
}

export function createPinnedAnswer(
  storePath: string,
  passphrase: string,
  pattern: string,
  answerText: string,
  sourceLabel: string | null = null,
): PinnedAnswer {
  const clean = validate(pattern, answerText);
  const now = new Date().toISOString();
  const id = randomUUID();
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePinnedAnswersSchema(db);
    db.prepare(
      `INSERT INTO pinned_answers (id, pattern, answer_text, created_at, updated_at, source_label) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, clean.pattern, clean.answerText, now, now, sourceLabel);
    return { id, pattern: clean.pattern, answerText: clean.answerText, createdAt: now, updatedAt: now, sourceLabel };
  });
}

/**
 * Edits an existing pinned answer's pattern and/or wording in place — the
 * same id, a fresh `updatedAt`. Either field omitted keeps its current
 * value; both omitted is a no-op edit (still bumps `updatedAt`, same as a
 * no-op save anywhere else in this product would).
 */
export function updatePinnedAnswer(
  storePath: string,
  passphrase: string,
  id: string,
  edit: { pattern?: string; answerText?: string },
): PinnedAnswer {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePinnedAnswersSchema(db);
    const existing = db.prepare(`SELECT * FROM pinned_answers WHERE id = ?`).get(id) as PinnedAnswerRow | undefined;
    if (!existing) {
      throw new PinnedAnswerNotFoundError(id);
    }
    const clean = validate(edit.pattern ?? existing.pattern, edit.answerText ?? existing.answer_text);
    const now = new Date().toISOString();
    db.prepare(`UPDATE pinned_answers SET pattern = ?, answer_text = ?, updated_at = ? WHERE id = ?`).run(
      clean.pattern,
      clean.answerText,
      now,
      id,
    );
    return rowToPinnedAnswer({ ...existing, pattern: clean.pattern, answer_text: clean.answerText, updated_at: now });
  });
}

/** Idempotent: deleting an id that doesn't exist (already removed, never existed) is a no-op, not an error — same shape as `restoreEvidence`. */
export function deletePinnedAnswer(storePath: string, passphrase: string, id: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensurePinnedAnswersSchema(db);
    db.prepare(`DELETE FROM pinned_answers WHERE id = ?`).run(id);
  });
}

/**
 * Whether `question` matches any pinned answer's pattern — containment,
 * case-insensitive, whitespace trimmed, the same idiom
 * `matchesRefusedSubject` uses. When several match, the longest pattern
 * wins (the most specific pin an owner wrote), ties broken by most recent
 * `updatedAt` — deterministic, and "the owner's latest, most specific word
 * on this" is the one answer that should win outright.
 */
export function findPinnedAnswer(storePath: string, passphrase: string, question: string): PinnedAnswer | undefined {
  const lower = question.toLowerCase();
  const candidates = listPinnedAnswers(storePath, passphrase).filter(
    (pinned) => pinned.pattern.trim().length > 0 && lower.includes(pinned.pattern.trim().toLowerCase()),
  );
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.sort((a, b) => b.pattern.length - a.pattern.length || b.updatedAt.localeCompare(a.updatedAt))[0];
}
