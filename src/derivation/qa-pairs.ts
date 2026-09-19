import { createHash } from "node:crypto";
import type { InferenceProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { IngestRecord } from "../ingest/record.js";
import { listRecords } from "../ingest/record-store.js";

/**
 * The training spine (v1-tech-design.md §1.5 step 1): within a thread, a
 * question from `other` followed by the owner's substantive reply. `topicId`
 * starts unset — topic assignment (#24) fills it in on a later pass, keyed
 * by this same `id` so re-deriving topics never needs to re-extract pairs.
 */
export interface QaPair {
  readonly id: string;
  readonly questionId: string;
  readonly answerId: string;
  readonly threadId: string;
  readonly ts: string;
  readonly topicId: string | null;
}

/** Stable across re-extraction: the same (question, answer) always yields the same id, so re-running extraction is idempotent (same convention as computeRecordId). */
export function computeQaPairId(questionId: string, answerId: string): string {
  return createHash("sha256").update([questionId, answerId].join("\u0000")).digest("hex");
}

/**
 * Whether a second question arriving while the first is still unanswered is
 * a rephrase of the same question (fold into the open span) or a genuinely
 * new one (close the first as unanswered, open a new span). IngestRecord
 * carries no per-person asker identity — only `author: "other"` — so this
 * is a real ambiguity, not a deterministic call, whenever it arises; text
 * content is the only signal available, which is exactly what benefits from
 * an LLM pass (v1-tech-design.md §1.5: "an LLM pass only adjudicates
 * ambiguous cases").
 */
export type AdjudicationOutcome = "continuation" | "new_question";

export type Adjudicate = (firstQuestion: IngestRecord, secondQuestion: IngestRecord) => Promise<AdjudicationOutcome>;

/**
 * Builds an LLM-backed adjudicator from any InferenceProvider. Never throws:
 * a network failure or an unparseable response falls back to
 * `"new_question"`, the same safe default `extractQaPairs` uses when no
 * adjudicator is configured at all — one failed adjudication should not
 * abort the whole extraction run, and mislabeling two truly-unrelated
 * questions as "new" is the cheaper mistake (it just means two pairs
 * instead of one, not a fabricated link between unrelated content).
 */
export function createLlmAdjudicator(provider: InferenceProvider): Adjudicate {
  return async (firstQuestion, secondQuestion) => {
    try {
      const response = await provider.complete(
        [
          "Two questions were asked in the same conversation thread, and the first was never answered.",
          "Is the second question a rephrasing or continuation of the first, or a distinct new question?",
          `First question: "${firstQuestion.text}"`,
          `Second question: "${secondQuestion.text}"`,
          'Respond with exactly one word: "continuation" or "new_question".',
        ].join("\n"),
      );
      return response.toLowerCase().includes("continuation") ? "continuation" : "new_question";
    } catch {
      return "new_question";
    }
  };
}

export interface QaPairExtractionResult {
  readonly pairs: readonly QaPair[];
  /** Questions with no substantive owner answer by the end of their thread. Not an error — still present in `records`, so an interruption portrait built later can count them. */
  readonly unansweredCount: number;
  /** Times a second unanswered question arrived while the first was still open — the case an LLM pass adjudicates. */
  readonly ambiguousCount: number;
  /** Of `ambiguousCount`, how many were actually resolved by calling `adjudicate` rather than the no-adjudicator default. */
  readonly adjudicatedCount: number;
}

interface OpenQuestion {
  question: IngestRecord;
  answers: IngestRecord[];
}

/**
 * Extracts qa_pairs from a batch of records spanning any number of threads.
 * Pure and side-effect-free: no database access, so it can be tested (and
 * reasoned about) independently of storage. `records` need not already be
 * sorted or grouped by thread — this does both.
 *
 * Per thread, walks records in timestamp order tracking one "open question"
 * at a time:
 * - `question_to_me` from `other` opens a span (or, if one is already open
 *   with no answer yet, triggers adjudication — see AdjudicationOutcome).
 * - `my_answer` from `me` while a span is open is appended as a candidate
 *   answer; several such turns collapse into one pair using the *last* one,
 *   so a multi-turn exchange never fragments into one pair per turn.
 * - Any other record is irrelevant to pairing and does not affect the span.
 * - A question_to_me while a span with at least one answer is open is
 *   unambiguous: the open span already concluded, so it closes normally
 *   (producing a pair) and the new question opens the next span.
 */
export async function extractQaPairs(
  records: readonly IngestRecord[],
  options: { adjudicate?: Adjudicate } = {},
): Promise<QaPairExtractionResult> {
  const byThread = new Map<string, IngestRecord[]>();
  for (const record of records) {
    if (record.threadId === null) {
      continue; // no thread to pair within
    }
    const bucket = byThread.get(record.threadId);
    if (bucket) {
      bucket.push(record);
    } else {
      byThread.set(record.threadId, [record]);
    }
  }

  const pairs: QaPair[] = [];
  let unansweredCount = 0;
  let ambiguousCount = 0;
  let adjudicatedCount = 0;

  for (const [threadId, threadRecords] of byThread) {
    const sorted = [...threadRecords].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
    );

    let open: OpenQuestion | null = null;

    const closeAnswered = (span: OpenQuestion): void => {
      const answer = span.answers[span.answers.length - 1];
      pairs.push({
        id: computeQaPairId(span.question.id, answer.id),
        questionId: span.question.id,
        answerId: answer.id,
        threadId,
        ts: answer.timestamp,
        topicId: null,
      });
    };

    for (const record of sorted) {
      if (record.author === "other" && record.kind === "question_to_me") {
        if (open === null) {
          open = { question: record, answers: [] };
        } else if (open.answers.length === 0) {
          ambiguousCount += 1;
          let outcome: AdjudicationOutcome = "new_question";
          if (options.adjudicate) {
            outcome = await options.adjudicate(open.question, record);
            adjudicatedCount += 1;
          }
          if (outcome === "new_question") {
            unansweredCount += 1;
            open = { question: record, answers: [] };
          }
          // "continuation": keep the same open span, discard the rephrased question record.
        } else {
          closeAnswered(open);
          open = { question: record, answers: [] };
        }
      } else if (record.author === "me" && record.kind === "my_answer" && open !== null) {
        open.answers.push(record);
      }
    }

    if (open !== null) {
      if (open.answers.length > 0) {
        closeAnswered(open);
      } else {
        unansweredCount += 1;
      }
    }
  }

  return { pairs, unansweredCount, ambiguousCount, adjudicatedCount };
}

/** Mirrors record-store.ts's ensureRecordsSchema convention: created on demand, not only at `duo init`. */
export function ensureQaPairsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_pairs (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      topic_id TEXT
    ) STRICT
  `);
}

export interface WriteQaPairsResult {
  written: number;
  skipped: number;
}

/** Writes pairs idempotently — INSERT OR IGNORE keyed by the content-derived id, so re-extraction after new records arrive never duplicates a pair already stored. */
export function writeQaPairs(storePath: string, passphrase: string, pairs: readonly QaPair[]): WriteQaPairsResult {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureQaPairsSchema(db);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO qa_pairs (id, question_id, answer_id, thread_id, ts, topic_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let written = 0;
    let skipped = 0;
    for (const pair of pairs) {
      const result = insert.run(pair.id, pair.questionId, pair.answerId, pair.threadId, pair.ts, pair.topicId);
      if (result.changes > 0) {
        written += 1;
      } else {
        skipped += 1;
      }
    }
    return { written, skipped };
  });
}

interface QaPairRow {
  id: string;
  question_id: string;
  answer_id: string;
  thread_id: string;
  ts: string;
  topic_id: string | null;
}

function rowToQaPair(row: QaPairRow): QaPair {
  return { id: row.id, questionId: row.question_id, answerId: row.answer_id, threadId: row.thread_id, ts: row.ts, topicId: row.topic_id };
}

/** Every qa_pair currently in the store, unfiltered — the read side #24's topic assignment runs over. */
export function listQaPairs(storePath: string, passphrase: string): QaPair[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureQaPairsSchema(db);
    const rows = db.prepare(`SELECT * FROM qa_pairs`).all() as unknown as QaPairRow[];
    return rows.map(rowToQaPair);
  });
}

export interface PairExtractionSummary extends QaPairExtractionResult {
  readonly written: number;
  readonly alreadyPresent: number;
}

/**
 * The entry point `duo derive pairs` calls: reads every record currently in
 * the store, extracts qa_pairs across all threads, and persists the result.
 * Read-extract-write rather than one query, matching #20's embedRecords
 * shape (a synchronous DB read, an async computation, a synchronous DB
 * write) — extraction here is async only because adjudication may call out
 * to a provider.
 */
export async function runPairExtraction(
  storePath: string,
  passphrase: string,
  options: { adjudicate?: Adjudicate } = {},
): Promise<PairExtractionSummary> {
  const records = listRecords(storePath, passphrase);
  const result = await extractQaPairs(records, options);
  const writeResult = writeQaPairs(storePath, passphrase, result.pairs);
  return { ...result, written: writeResult.written, alreadyPresent: writeResult.skipped };
}
