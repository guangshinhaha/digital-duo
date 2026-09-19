import { type QuestionGap, type SharedDuoUsageEntry, unresolvedQuestionGaps } from "./usage-log.js";

/** How many questions were asked in one calendar week (Monday–Sunday, UTC). */
export interface WeeklyUsage {
  /** ISO date (YYYY-MM-DD) of that week's Monday. */
  readonly weekStart: string;
  readonly questionCount: number;
}

/**
 * How long the shared duo can go unasked before a review calls that out
 * as abandonment rather than ordinary quiet (#71 AC2). Named as a
 * constant for the same reason STALE_AFTER_DAYS (documents.ts) is: one
 * place to reconsider the threshold, not a bare number in a comparison.
 */
export const ABANDONED_AFTER_DAYS = 14;

export interface SharedDuoUsageReport {
  readonly totalQuestions: number;
  readonly distinctAskers: number;
  /** Askers who asked more than once. */
  readonly repeatAskers: number;
  readonly answeredCount: number;
  readonly declinedCount: number;
  /** answeredCount / totalQuestions. 0 when there have been no questions at all — never NaN or undefined. */
  readonly answerRate: number;
  /** declinedCount / totalQuestions — "escalation rate": every decline routes to the owner (#68/#70). 0 when there have been no questions at all. */
  readonly escalationRate: number;
  /** One count per week that had at least one question, oldest first — a trend, not one flattering aggregate (#71 AC1). */
  readonly weeklyTrend: readonly WeeklyUsage[];
  /** Repeated out-of-scope questions, most-repeated first — reused as-is from #69, since #71 AC3 asks for exactly what unresolvedQuestionGaps already produces. */
  readonly gaps: readonly QuestionGap[];
  readonly lastAskedAt: string | null;
  /** null when the duo has never been asked anything at all. */
  readonly daysSinceLastAsk: number | null;
  /** True when there has been at least one question, but none in the last ABANDONED_AFTER_DAYS (#71 AC2) — distinct from never having been used at all. */
  readonly abandoned: boolean;
  /**
   * One honest, human-readable line — the one place #71 AC4's "the report
   * can say the duo is not being used, in those words" is guaranteed:
   * exactly `"The shared duo is not being used."` when totalQuestions is
   * 0, and a plain statement of the abandonment date when `abandoned`.
   * Never a single flattering number standing in for the whole picture.
   */
  readonly summary: string;
}

function weekStartISO(date: Date): string {
  const utcMidnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoWeekday = utcMidnight.getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (isoWeekday + 6) % 7; // Monday=0 ... Sunday=6
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - daysSinceMonday);
  return utcMidnight.toISOString().slice(0, 10);
}

function buildWeeklyTrend(entries: readonly SharedDuoUsageEntry[]): WeeklyUsage[] {
  const byWeek = new Map<string, number>();
  for (const entry of entries) {
    const week = weekStartISO(new Date(entry.createdAt));
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
  }
  return [...byWeek.entries()]
    .map(([weekStart, questionCount]) => ({ weekStart, questionCount }))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
}

function buildSummary(
  totalQuestions: number,
  abandoned: boolean,
  lastAskedAt: string | null,
  daysSinceLastAsk: number | null,
): string {
  if (totalQuestions === 0) {
    return "The shared duo is not being used.";
  }
  if (abandoned && lastAskedAt !== null && daysSinceLastAsk !== null) {
    return `Usage stopped on ${lastAskedAt.slice(0, 10)} — ${daysSinceLastAsk} day(s) since the last question. It may not be in active use anymore.`;
  }
  return `The shared duo has been asked ${totalQuestions} question(s), most recently on ${lastAskedAt?.slice(0, 10)}.`;
}

/**
 * Builds the honest usage picture #71 asks for from the raw log — never a
 * single number standing in for the whole thing (AC1), and never
 * smoothing a spike-then-stop into a period average (AC2). Pure: takes
 * the entries and a clock, computes everything, writes nothing.
 */
export function buildUsageReport(
  entries: readonly SharedDuoUsageEntry[],
  asOf: Date = new Date(),
): SharedDuoUsageReport {
  const totalQuestions = entries.length;
  const answeredCount = entries.filter((entry) => !entry.declined).length;
  const declinedCount = totalQuestions - answeredCount;

  // Normalized the same way unresolvedQuestionGaps normalizes questions —
  // askerId is free text, not resolved against a directory, so "Alice"
  // and "alice" from two different asks should count as the same asker.
  const askerCounts = new Map<string, number>();
  for (const entry of entries) {
    const askerKey = entry.askerId.trim().toLowerCase();
    askerCounts.set(askerKey, (askerCounts.get(askerKey) ?? 0) + 1);
  }
  const distinctAskers = askerCounts.size;
  const repeatAskers = [...askerCounts.values()].filter((count) => count > 1).length;

  const sortedByTime = [...entries].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const lastEntry = sortedByTime.at(-1);
  const lastAskedAt = lastEntry?.createdAt ?? null;
  const daysSinceLastAsk =
    lastAskedAt === null ? null : (asOf.getTime() - new Date(lastAskedAt).getTime()) / (1000 * 60 * 60 * 24);
  const abandoned = daysSinceLastAsk !== null && daysSinceLastAsk > ABANDONED_AFTER_DAYS;

  return {
    totalQuestions,
    distinctAskers,
    repeatAskers,
    answeredCount,
    declinedCount,
    answerRate: totalQuestions === 0 ? 0 : answeredCount / totalQuestions,
    escalationRate: totalQuestions === 0 ? 0 : declinedCount / totalQuestions,
    weeklyTrend: buildWeeklyTrend(entries),
    gaps: unresolvedQuestionGaps(entries),
    lastAskedAt,
    daysSinceLastAsk: daysSinceLastAsk === null ? null : Math.floor(daysSinceLastAsk),
    abandoned,
    summary: buildSummary(totalQuestions, abandoned, lastAskedAt, daysSinceLastAsk === null ? null : Math.floor(daysSinceLastAsk)),
  };
}
