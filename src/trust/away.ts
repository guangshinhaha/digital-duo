import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { getDraft } from "../drafting/draft-log.js";
import { listPublicAnswerLogEntriesBetween } from "../permissions/public-answer-log.js";
import { readTopicsFile, type Topic } from "../derivation/topics.js";
import { findConflictingRefusal } from "./refusals.js";

/**
 * Away mode (guangshinhaha/duo#270, digital-duo#287): "I'm out until a
 * time; meanwhile my duo answers what May do already allows, or that plus
 * topics I pick for this period" — over HTTP, for the app's
 * `src/profile/Away.tsx` (duo PR #339). One row per period, in the duo's
 * own store, the same reasoning `scheduled_sends` gives for living there
 * rather than on the owner's device (`drafting/scheduled-sends.ts`'s
 * module doc): a period the owner set from their phone must still be
 * honoured, and must still *end*, with the Mac asleep or the phone in a
 * drawer.
 *
 * At most one period is ever "active" (`ended_at IS NULL`) — `PUT /away`
 * starts one when none is active, or replaces the active one's own
 * settings in place (same row, same `startedAt`) when one already is;
 * there is no 409 for "already away" because changing your mind about the
 * end time or the scope while away is the ordinary case, not a conflict.
 *
 * Expiry is deliberately NOT timer-driven, unlike `ScheduledSendRunner`
 * (`serve/scheduled-send-runner.ts`): a scheduled send has a real-world
 * side effect that must fire AT its instant — a message actually going out
 * — so something has to be awake to do that at the right time even with
 * nobody asking. An away period's only consequence is "stop treating these
 * extra topics as auto-answerable," which is a pure function of
 * `now >= until` with no action to perform at the boundary itself — reading
 * it lazily, at `GET /away` and at every public answer
 * (`awayAnswerContext` below), is exactly as correct as a timer
 * would be, for every observer, with no background work to run or leak.
 * `closeExpiredActivePeriod` below is the one place that *writes* the
 * closure, so the stored state converges to "ended" the next time anyone
 * reads it, rather than sitting active forever in `away_periods` with
 * nobody to notice.
 */

export const AWAY_SCOPES = ["may_do", "may_do_and_topics"] as const;
export type AwayScope = (typeof AWAY_SCOPES)[number];

/** The longest an away period may run — long enough for real leave, short enough that a forgotten period can't quietly stand in for weeks. */
export const MAX_AWAY_DAYS = 14;

export interface TopicOption {
  readonly id: string;
  readonly label: string;
}

export interface AwayPeriod {
  readonly id: number;
  readonly startedAt: string;
  readonly until: string;
  readonly scope: AwayScope;
  readonly extraTopics: readonly TopicOption[];
  readonly endedAt: string | null;
  readonly endedEarly: boolean;
  readonly summaryDismissedAt: string | null;
}

export interface AwaySummaryItem {
  readonly question: string;
  readonly askerRef: string;
  readonly at: string;
  readonly draftId: string;
  readonly topicId: string | null;
}

export interface AwaySummary {
  readonly periodId: number;
  /** False while the period is still running (a summary so far); true once it has ended (the return summary). */
  readonly ended: boolean;
  readonly from: string;
  readonly to: string;
  readonly answered: readonly (AwaySummaryItem & { readonly viaAwayTopic: boolean })[];
  readonly passedOn: readonly (AwaySummaryItem & { readonly waiting: boolean })[];
  readonly declined: readonly AwaySummaryItem[];
}

export interface AwayState {
  readonly active: AwayPeriod | null;
  readonly last: AwayPeriod | null;
  /** Exactly what colleagues see while the owner is away; null when they are in. */
  readonly statusLine: string | null;
  readonly summary: AwaySummary | null;
  readonly scopes: readonly AwayScope[];
  readonly maxDays: number;
}

export class InvalidAwayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAwayError";
  }
}

export class NotAwayError extends Error {
  constructor() {
    super("Not away right now — there is no active period to end.");
    this.name = "NotAwayError";
  }
}

function ensureAwaySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS away_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      until TEXT NOT NULL,
      scope TEXT NOT NULL,
      extra_topic_ids TEXT NOT NULL DEFAULT '[]',
      ended_at TEXT,
      ended_early INTEGER NOT NULL DEFAULT 0,
      summary_dismissed_at TEXT
    ) STRICT
  `);
}

interface AwayPeriodRow {
  id: number;
  started_at: string;
  until: string;
  scope: string;
  extra_topic_ids: string;
  ended_at: string | null;
  ended_early: number;
  summary_dismissed_at: string | null;
}

function resolveTopics(duoDir: string, topicIds: readonly string[]): TopicOption[] {
  const known = new Map(readTopicsFile(duoDir).map((topic) => [topic.id, topic] as const));
  return topicIds.flatMap((id): TopicOption[] => {
    const topic = known.get(id);
    // A topic the period named that has since vanished (never happens today
    // — topics are never deleted, AR-8) is dropped rather than shown with a
    // fabricated label; it simply stops contributing to the scope.
    return topic ? [{ id: topic.id, label: topic.label }] : [];
  });
}

function rowToPeriod(row: AwayPeriodRow, duoDir: string): AwayPeriod {
  const extraTopicIds = JSON.parse(row.extra_topic_ids) as string[];
  return {
    id: row.id,
    startedAt: row.started_at,
    until: row.until,
    scope: row.scope as AwayScope,
    extraTopics: resolveTopics(duoDir, extraTopicIds),
    endedAt: row.ended_at,
    endedEarly: row.ended_early === 1,
    summaryDismissedAt: row.summary_dismissed_at,
  };
}

function getActiveRow(db: Database): AwayPeriodRow | undefined {
  return db.prepare(`SELECT * FROM away_periods WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`).get() as AwayPeriodRow | undefined;
}

function getLastEndedRow(db: Database): AwayPeriodRow | undefined {
  return db.prepare(`SELECT * FROM away_periods WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT 1`).get() as
    | AwayPeriodRow
    | undefined;
}

/**
 * The one place an away period's expiry is written: if the active row's
 * `until` has passed, closes it (ended_at = until, not "now" — the summary
 * cuts off exactly at the boundary the owner set, not at whatever moment
 * someone happened to read it) and returns it; otherwise a no-op. Callers
 * that only need to know "is away active right now" never call this (see
 * `awayAnswerContext` — a pure read of `until` against `now` is sufficient
 * and avoids taking a write lock on every public answer); it exists for
 * the handful of writers (`GET /away` and every away mutation) that should
 * make the stored state converge.
 */
function closeExpiredActivePeriod(db: Database, now: Date): void {
  const active = getActiveRow(db);
  if (active === undefined) {
    return;
  }
  if (new Date(active.until).getTime() > now.getTime()) {
    return;
  }
  db.prepare(`UPDATE away_periods SET ended_at = ?, ended_early = 0 WHERE id = ?`).run(active.until, active.id);
}

function validateUntil(until: Date, now: Date): void {
  if (Number.isNaN(until.getTime())) {
    throw new InvalidAwayError("until must be a valid date-time.");
  }
  if (until.getTime() <= now.getTime()) {
    throw new InvalidAwayError("until must be in the future.");
  }
  const maxMs = MAX_AWAY_DAYS * 24 * 60 * 60 * 1000;
  if (until.getTime() - now.getTime() > maxMs) {
    throw new InvalidAwayError(`until cannot be more than ${MAX_AWAY_DAYS} days out.`);
  }
}

function validateExtraTopicIds(duoDir: string, scope: AwayScope, extraTopicIds: readonly string[]): string[] {
  if (scope === "may_do") {
    return [];
  }
  const topics = readTopicsFile(duoDir);
  const byId = new Map(topics.map((topic) => [topic.id, topic] as const));
  const deduped = [...new Set(extraTopicIds)];
  for (const topicId of deduped) {
    const topic = byId.get(topicId);
    if (topic === undefined) {
      throw new InvalidAwayError(`Unknown topic "${topicId}".`);
    }
    const conflict = findConflictingRefusal(duoDir, topic.id, topic.label);
    if (conflict !== undefined) {
      throw new InvalidAwayError(`"${topic.label}" is on your never-answer list ("${conflict.heading}") and can't be added to an away period.`);
    }
  }
  return deduped;
}

export interface SetAwayInput {
  readonly until: Date;
  readonly scope: AwayScope;
  readonly extraTopicIds?: readonly string[];
}

/**
 * `PUT /away`: starts a period, or — while one is already active — replaces
 * its settings in place (same row, same `startedAt`). Refused, before
 * anything is written, for a past or over-long `until`, a scope outside
 * `AWAY_SCOPES`, or an unknown/refused topic in `extraTopicIds`.
 */
export function setAway(storePath: string, passphrase: string, duoDir: string, input: SetAwayInput, now: Date = new Date()): AwayPeriod {
  if (!AWAY_SCOPES.includes(input.scope)) {
    throw new InvalidAwayError(`scope must be one of: ${AWAY_SCOPES.join(", ")}.`);
  }
  validateUntil(input.until, now);
  const extraTopicIds = validateExtraTopicIds(duoDir, input.scope, input.extraTopicIds ?? []);

  return withDatabase(storePath, passphrase, true, (db) => {
    ensureAwaySchema(db);
    closeExpiredActivePeriod(db, now);
    const active = getActiveRow(db);
    const untilIso = input.until.toISOString();
    const topicsJson = JSON.stringify(extraTopicIds);
    if (active !== undefined) {
      db.prepare(`UPDATE away_periods SET until = ?, scope = ?, extra_topic_ids = ? WHERE id = ?`).run(untilIso, input.scope, topicsJson, active.id);
      const updated = db.prepare(`SELECT * FROM away_periods WHERE id = ?`).get(active.id) as unknown as AwayPeriodRow;
      return rowToPeriod(updated, duoDir);
    }
    const result = db
      .prepare(`INSERT INTO away_periods (started_at, until, scope, extra_topic_ids, ended_at, ended_early, summary_dismissed_at) VALUES (?, ?, ?, ?, NULL, 0, NULL)`)
      .run(now.toISOString(), untilIso, input.scope, topicsJson);
    const created = db.prepare(`SELECT * FROM away_periods WHERE id = ?`).get(result.lastInsertRowid) as unknown as AwayPeriodRow;
    return rowToPeriod(created, duoDir);
  });
}

/** `DELETE /away`: back early. Throws `NotAwayError` (409) when nothing is active (an already-expired period was lazily closed by the last read, which this counts as "not away" too). */
export function endAwayNow(storePath: string, passphrase: string, duoDir: string, now: Date = new Date()): AwayPeriod {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureAwaySchema(db);
    closeExpiredActivePeriod(db, now);
    const active = getActiveRow(db);
    if (active === undefined) {
      throw new NotAwayError();
    }
    db.prepare(`UPDATE away_periods SET ended_at = ?, ended_early = 1 WHERE id = ?`).run(now.toISOString(), active.id);
    const updated = db.prepare(`SELECT * FROM away_periods WHERE id = ?`).get(active.id) as unknown as AwayPeriodRow;
    return rowToPeriod(updated, duoDir);
  });
}

/** `POST /away/summary/dismiss`: puts the most recently ended period's return summary away. A no-op (not an error) when there is nothing to dismiss, or it already was — dismissing is idempotent. */
export function dismissAwaySummary(storePath: string, passphrase: string, now: Date = new Date()): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureAwaySchema(db);
    closeExpiredActivePeriod(db, now);
    const last = getLastEndedRow(db);
    if (last === undefined || last.summary_dismissed_at !== null) {
      return;
    }
    db.prepare(`UPDATE away_periods SET summary_dismissed_at = ? WHERE id = ?`).run(now.toISOString(), last.id);
  });
}

function toSummaryItem(entry: { question: string; askerRef: string; createdAt: string; draftId: string; topicId: string | null }): AwaySummaryItem {
  return { question: entry.question, askerRef: entry.askerRef, at: entry.createdAt, draftId: entry.draftId, topicId: entry.topicId };
}

/** What happened in `[fromIso, toIso)` — the away summary's own composition, over the public-answering pipeline's own log (`permissions/public-answer-log.ts`), classified by outcome and, for a passed-on question, whether it is still waiting on the owner. */
function composeSummary(
  storePath: string,
  passphrase: string,
  period: Pick<AwayPeriod, "id" | "extraTopics">,
  fromIso: string,
  toIso: string,
  ended: boolean,
): AwaySummary {
  const entries = listPublicAnswerLogEntriesBetween(storePath, passphrase, fromIso, toIso);
  const awayTopicIds = new Set(period.extraTopics.map((topic) => topic.id));
  const answered: (AwaySummaryItem & { viaAwayTopic: boolean })[] = [];
  const passedOn: (AwaySummaryItem & { waiting: boolean })[] = [];
  const declined: AwaySummaryItem[] = [];
  for (const entry of entries) {
    const item = toSummaryItem(entry);
    if (entry.outcome === "answered") {
      answered.push({ ...item, viaAwayTopic: entry.topicId !== null && awayTopicIds.has(entry.topicId) });
    } else if (entry.outcome === "passed_on") {
      const draft = getDraft(storePath, passphrase, entry.draftId);
      passedOn.push({ ...item, waiting: draft === undefined ? true : draft.outcome === null });
    } else if (entry.outcome === "declined_refused") {
      declined.push(item);
    }
    // "corrected" entries (#45) are a correction of an earlier entry, not a
    // new exchange that happened during the period — left out on purpose.
  }
  return { periodId: period.id, ended, from: fromIso, to: toIso, answered, passedOn, declined };
}

function formatUntil(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;
}

export function composeAwayStatusLine(period: AwayPeriod): string {
  const until = formatUntil(period.until);
  if (period.scope === "may_do" || period.extraTopics.length === 0) {
    return `The owner is away until ${until}. I'm only answering what I'm already allowed to; everything else is waiting for them.`;
  }
  const topics = period.extraTopics.map((topic) => topic.label).join(", ");
  return `The owner is away until ${until}. I'm answering what I'm already allowed to, plus ${topics}; everything else is waiting for them.`;
}

/** What `permissions/public-answer.ts` needs from away mode at answer time, in one read. */
export interface AwayAnswerContext {
  /** Null when nobody is away. */
  readonly statusLine: string | null;
  /** Whether `topicId` is one an active "May do, plus topics" period added for this window — false once `now >= until`, regardless of whether anything has lazily closed the row yet. */
  readonly allowsTopic: (topicId: string) => boolean;
}

const NOBODY_AWAY: AwayAnswerContext = { statusLine: null, allowsTopic: () => false };

/**
 * `answerPublicly`'s one away-mode read, replacing what would otherwise be
 * two separate `activeAwayStatusLine`/`isTopicAllowedWhileAway` reads —
 * `withDatabase` fully decrypts the store per call (`store/store.ts`), so
 * this hot path (every public answer) earns combining them into the single
 * read below rather than paying that cost twice. Read-only, no write — see
 * this module's own doc comment on why expiry is checked here, at read
 * time, rather than armed on a timer.
 */
export function awayAnswerContext(storePath: string, passphrase: string, duoDir: string, now: Date = new Date()): AwayAnswerContext {
  const active = withDatabase(storePath, passphrase, false, (db) => {
    ensureAwaySchema(db);
    return getActiveRow(db);
  });
  if (active === undefined || new Date(active.until).getTime() <= now.getTime()) {
    return NOBODY_AWAY;
  }
  const period = rowToPeriod(active, duoDir);
  const extraTopicIds = new Set(JSON.parse(active.extra_topic_ids) as string[]);
  return {
    statusLine: composeAwayStatusLine(period),
    allowsTopic: (topicId) => active.scope === "may_do_and_topics" && extraTopicIds.has(topicId),
  };
}

/**
 * `GET /away` and every away write's reply: the running period (lazily
 * ended by its own `until` first — see `closeExpiredActivePeriod`), the
 * last one that ended, the status line colleagues are seeing right now,
 * and a summary — so-far while a period runs, the return summary once it
 * has ended and not yet been dismissed.
 */
export function getAwayState(storePath: string, passphrase: string, duoDir: string, now: Date = new Date()): AwayState {
  const { active, last } = withDatabase(storePath, passphrase, true, (db) => {
    ensureAwaySchema(db);
    closeExpiredActivePeriod(db, now);
    const activeRow = getActiveRow(db);
    const lastRow = getLastEndedRow(db);
    return {
      active: activeRow ? rowToPeriod(activeRow, duoDir) : null,
      last: lastRow ? rowToPeriod(lastRow, duoDir) : null,
    };
  });

  if (active !== null) {
    const summary = composeSummary(storePath, passphrase, active, active.startedAt, now.toISOString(), false);
    return { active, last, statusLine: composeAwayStatusLine(active), summary, scopes: AWAY_SCOPES, maxDays: MAX_AWAY_DAYS };
  }

  if (last !== null && last.summaryDismissedAt === null && last.endedAt !== null) {
    const summary = composeSummary(storePath, passphrase, last, last.startedAt, last.endedAt, true);
    return { active: null, last, statusLine: null, summary, scopes: AWAY_SCOPES, maxDays: MAX_AWAY_DAYS };
  }

  return { active: null, last, statusLine: null, summary: null, scopes: AWAY_SCOPES, maxDays: MAX_AWAY_DAYS };
}

/** `GET /topics`: the duo's topics, exactly as an away period can add them — id and label only, the one slice `TopicOption` needs. */
export function listTopicOptions(duoDir: string): TopicOption[] {
  return readTopicsFile(duoDir).map((topic: Topic) => ({ id: topic.id, label: topic.label }));
}
