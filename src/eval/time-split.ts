import type { IngestRecord } from "../ingest/record.js";

/**
 * AR-7 / v1-tech-design.md §1.10: deriving rules over the whole corpus and
 * then scoring on held-out pairs is contaminated, because the rules were
 * induced from the very answers being predicted. The split must happen
 * *before* derivation runs, over the raw record set, not after — this
 * module is pure and knows nothing about qa_pairs, topics, or rules so it
 * can't accidentally be called after the fact.
 */
export interface TimeSplitResult {
  /** Records strictly before the cutoff — the only records derivation may ever see. */
  readonly trainRecords: readonly IngestRecord[];
  /** Records at or after the cutoff — never handed to derivation, only to the eval harness's own scoring. */
  readonly heldOutRecords: readonly IngestRecord[];
  /** The boundary itself, ISO-8601. `trainRecords` are strictly before it; `heldOutRecords` are at or after it. */
  readonly cutoff: string;
  /** The full corpus's span, earliest to latest parseable timestamp, in days. */
  readonly corpusSpanDays: number;
  /** The holdout window actually applied, echoed back so a caller never has to re-derive what it asked for. */
  readonly holdoutDays: number;
}

/**
 * Thrown instead of producing a split that would leave derivation with
 * nothing to learn from. Names both the span found and the span needed
 * (#35 AC2) rather than a generic "corpus too small".
 */
export class CorpusTooShortError extends Error {
  readonly corpusSpanDays: number;
  readonly holdoutDaysNeeded: number;

  constructor(corpusSpanDays: number, holdoutDaysNeeded: number) {
    super(
      `Corpus spans ${corpusSpanDays.toFixed(1)} day(s), which is shorter than the ${holdoutDaysNeeded} day(s) ` +
        "needed for a held-out window. Splitting it would leave derivation with nothing to learn from — import " +
        "a wider time range, or lower the configured holdout window (DUO_EVAL_HOLDOUT_DAYS).",
    );
    this.name = "CorpusTooShortError";
    this.corpusSpanDays = corpusSpanDays;
    this.holdoutDaysNeeded = holdoutDaysNeeded;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseableTimestamp(record: IngestRecord): number | null {
  const parsed = new Date(record.timestamp).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Splits `records` by timestamp: everything strictly before `cutoff` is
 * `trainRecords`, everything else is `heldOutRecords`. `cutoff` is set
 * `holdoutDays` before the corpus's own latest parseable timestamp — not
 * "now" — so a fixed, already-imported corpus always splits the same way
 * regardless of when the harness happens to run (#35 AC3's reproducibility
 * starts here).
 *
 * A record whose timestamp can't be parsed as a date can't be proven to
 * fall inside the held-out window, so — the same "unknown defaults to the
 * safer, stricter treatment" convention #48's classification uses — it's
 * kept in `trainRecords` rather than risking a silent leak into the
 * held-out set.
 *
 * Refuses (CorpusTooShortError) rather than producing a split that leaves
 * `trainRecords` empty or near-empty: a corpus spanning less than
 * `holdoutDays` has nowhere left for derivation to learn from once the
 * window is carved out.
 */
export function splitCorpusByTime(records: readonly IngestRecord[], holdoutDays: number): TimeSplitResult {
  const timestamps = records.map(parseableTimestamp).filter((ts): ts is number => ts !== null);

  if (timestamps.length === 0) {
    throw new CorpusTooShortError(0, holdoutDays);
  }

  const earliest = Math.min(...timestamps);
  const latest = Math.max(...timestamps);
  const corpusSpanDays = (latest - earliest) / DAY_MS;

  if (corpusSpanDays < holdoutDays) {
    throw new CorpusTooShortError(corpusSpanDays, holdoutDays);
  }

  const cutoffMs = latest - holdoutDays * DAY_MS;
  const cutoff = new Date(cutoffMs).toISOString();

  const trainRecords: IngestRecord[] = [];
  const heldOutRecords: IngestRecord[] = [];
  for (const record of records) {
    const ts = parseableTimestamp(record);
    if (ts !== null && ts >= cutoffMs) {
      heldOutRecords.push(record);
    } else {
      trainRecords.push(record);
    }
  }

  return { trainRecords, heldOutRecords, cutoff, corpusSpanDays, holdoutDays };
}
