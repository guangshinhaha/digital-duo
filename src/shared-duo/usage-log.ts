import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One question asked of the shared duo, and what happened — the record
 * #71's usage report (questions, answer rate, escalation rate, repeated
 * unanswerable questions) is built from, and the minimal version of that
 * #69 AC4 itself needs ("repeatedly asked unanswerable questions are
 * surfaced"). Kept as a plain JSON array file, not the encrypted personal
 * store — this data has nothing to do with anyone's personal corpus, and
 * mixing it into a personal duo's `data/duo.db` would blur exactly the
 * boundary #68 built. `citedTitles`/`staleCitation` are written now,
 * ahead of their own consumer (#71), same "field present, logic deferred"
 * idiom #18/#23 use elsewhere in this codebase.
 */
export interface SharedDuoUsageEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly question: string;
  readonly declined: boolean;
  readonly citedTitles: readonly string[];
  readonly staleCitation: boolean;
}

/** Thrown when the usage log file exists but isn't a well-formed JSON array. */
export class InvalidUsageLogError extends Error {}

/** Every entry ever recorded, oldest first. Returns `[]` when the log doesn't exist yet — the shared duo hasn't been asked anything, not an error. */
export function loadUsageLog(logPath: string): SharedDuoUsageEntry[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(logPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidUsageLogError(`Malformed shared duo usage log at "${logPath}": expected a JSON array`);
  }
  return parsed as SharedDuoUsageEntry[];
}

/**
 * Appends one entry and rewrites the log. A plain read-append-write over a
 * JSON array is the simplest correct choice at this scale (one shared duo,
 * one process asking it questions at a time via the CLI) — the same
 * "no more machinery than the pilot needs" call #20 made skipping
 * sqlite-vec.
 */
export function appendUsageEntry(
  logPath: string,
  input: Omit<SharedDuoUsageEntry, "id" | "createdAt">,
): SharedDuoUsageEntry {
  const entries = loadUsageLog(logPath);
  const entry: SharedDuoUsageEntry = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
  entries.push(entry);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify(entries, null, 2));
  return entry;
}

/** One out-of-scope question and how many times it's been asked. */
export interface QuestionGap {
  readonly question: string;
  readonly count: number;
}

/**
 * Groups declined questions by normalized text, most-repeated first — the
 * same out-of-scope question asked several times names a real gap in the
 * shared duo's material (#69 AC4: "it appears as a gap in the material,
 * because what the duo cannot answer is the most useful thing it
 * produces"). Every declined question is included, even one asked only
 * once — the CLI, not this function, decides what's worth showing.
 */
export function unresolvedQuestionGaps(entries: readonly SharedDuoUsageEntry[]): QuestionGap[] {
  const byNormalizedQuestion = new Map<string, { display: string; count: number }>();
  for (const entry of entries) {
    if (!entry.declined) {
      continue;
    }
    const key = entry.question.trim().toLowerCase();
    const existing = byNormalizedQuestion.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byNormalizedQuestion.set(key, { display: entry.question.trim(), count: 1 });
    }
  }
  return [...byNormalizedQuestion.values()]
    .map(({ display, count }) => ({ question: display, count }))
    .sort((a, b) => b.count - a.count);
}
