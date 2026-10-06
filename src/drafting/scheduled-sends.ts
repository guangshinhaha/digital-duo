import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { DraftAlreadySettledError, DraftNotFoundError, getDraft, type SettableDraftOutcome } from "./draft-log.js";

/**
 * Scheduled send (guangshinhaha/duo#261): the owner approves a draft now and
 * the daemon sends it later — "clear Waiting on you at night without
 * messaging people at night." The hold lives here, in the duo's own store,
 * never on the owner's device: a closed laptop or a phone in a drawer must
 * not stop a send the owner already approved.
 *
 * Holding a send records nothing against the draft itself. The draft keeps
 * `outcome IS NULL` until the send fires, and firing goes through exactly
 * the seam a Send tap goes through (`recordOutcomeAndDeliver`), so the
 * colleague sees a normal message at send time, the correction signal is
 * recorded the same way, and a draft that was settled some other way in the
 * meantime is refused by that seam's own already-settled guard rather than
 * delivered twice.
 */

/** Only the outcomes that deliver can be held — a scheduled "discarded" is not a thing. */
export type ScheduledOutcome = Extract<SettableDraftOutcome, "sent" | "edited">;

/**
 * - `scheduled` — held, waiting for `sendAt`.
 * - `sent` — fired through the delivery seam (what the delivery itself did is the draft's own `delivery` field).
 * - `cancelled` — the owner took it back before it fired.
 * - `superseded` — by fire time the draft already had an outcome (sent or dismissed some other way), so nothing was sent.
 * - `failed` — firing threw before anything was recorded (e.g. the draft is gone); `failureReason` says why.
 */
export type ScheduledSendState = "scheduled" | "sent" | "cancelled" | "superseded" | "failed";

export interface ScheduledSend {
  readonly draftId: string;
  readonly outcome: ScheduledOutcome;
  /** The edited text, for an `edited` hold; null for a plain `sent`, which sends the draft's own text. */
  readonly sentText: string | null;
  /** When it goes out (ISO-8601, UTC). */
  readonly sendAt: string;
  /** When the owner scheduled it (ISO-8601). */
  readonly scheduledAt: string;
  readonly state: ScheduledSendState;
  readonly settledAt: string | null;
  readonly failureReason: string | null;
}

export class ScheduledSendNotFoundError extends Error {
  constructor(draftId: string) {
    super(`No send is scheduled for draft "${draftId}".`);
    this.name = "ScheduledSendNotFoundError";
  }
}

export class DraftAlreadyScheduledError extends Error {
  constructor(draftId: string, sendAt: string) {
    super(`Draft "${draftId}" is already scheduled to send at ${sendAt}. Cancel it first to pick another time.`);
    this.name = "DraftAlreadyScheduledError";
  }
}

/** A schedule request that can never be honoured — a past time, a draft with nothing to send, a blank edit. */
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

export function ensureScheduledSendSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_sends (
      draft_id TEXT PRIMARY KEY,
      outcome TEXT NOT NULL,
      sent_text TEXT,
      send_at TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      state TEXT NOT NULL,
      settled_at TEXT,
      failure_reason TEXT
    ) STRICT
  `);
}

interface ScheduledSendRow {
  draft_id: string;
  outcome: string;
  sent_text: string | null;
  send_at: string;
  scheduled_at: string;
  state: string;
  settled_at: string | null;
  failure_reason: string | null;
}

function rowToScheduledSend(row: ScheduledSendRow): ScheduledSend {
  return {
    draftId: row.draft_id,
    outcome: row.outcome === "edited" ? "edited" : "sent",
    sentText: row.sent_text,
    sendAt: row.send_at,
    scheduledAt: row.scheduled_at,
    state: row.state as ScheduledSendState,
    settledAt: row.settled_at,
    failureReason: row.failure_reason,
  };
}

export interface ScheduleSendInput {
  readonly outcome: ScheduledOutcome;
  readonly sentText?: string;
  readonly sendAt: Date;
}

/**
 * Holds one approved draft for `sendAt`. Refused — before anything is
 * written — for an unknown draft, a draft that already has an outcome, one
 * already held, a passed-on or refused draft (there is no confident text to
 * send), a blank edit, or a time that is not in the future.
 */
export function scheduleSend(storePath: string, passphrase: string, draftId: string, input: ScheduleSendInput, now: Date = new Date()): ScheduledSend {
  const draft = getDraft(storePath, passphrase, draftId);
  if (!draft) {
    throw new DraftNotFoundError(draftId);
  }
  if (draft.outcome !== null) {
    throw new DraftAlreadySettledError(draftId, draft.outcome);
  }
  if (draft.escalated || draft.refused || draft.draftText === null) {
    throw new InvalidScheduleError("Only a draft with text to send can be scheduled — a passed-on or refused question has none.");
  }
  if (Number.isNaN(input.sendAt.getTime())) {
    throw new InvalidScheduleError("sendAt is not a valid date.");
  }
  if (input.sendAt.getTime() <= now.getTime()) {
    throw new InvalidScheduleError("sendAt must be in the future.");
  }
  const sentText = input.outcome === "edited" ? input.sentText?.trim() : undefined;
  if (input.outcome === "edited" && !sentText) {
    throw new InvalidScheduleError("An edited send needs the edited text (sentText).");
  }

  const record: ScheduledSend = {
    draftId,
    outcome: input.outcome,
    sentText: sentText ?? null,
    sendAt: input.sendAt.toISOString(),
    scheduledAt: now.toISOString(),
    state: "scheduled",
    settledAt: null,
    failureReason: null,
  };
  withDatabase(storePath, passphrase, true, (db) => {
    ensureScheduledSendSchema(db);
    const existing = db.prepare(`SELECT * FROM scheduled_sends WHERE draft_id = ?`).get(draftId) as ScheduledSendRow | undefined;
    if (existing?.state === "scheduled") {
      throw new DraftAlreadyScheduledError(draftId, existing.send_at);
    }
    // A row that already settled (cancelled, superseded, failed) is replaced: a cancelled hold may be rescheduled.
    db.prepare(
      `INSERT INTO scheduled_sends (draft_id, outcome, sent_text, send_at, scheduled_at, state, settled_at, failure_reason)
       VALUES (?, ?, ?, ?, ?, 'scheduled', NULL, NULL)
       ON CONFLICT(draft_id) DO UPDATE SET
         outcome = excluded.outcome, sent_text = excluded.sent_text, send_at = excluded.send_at,
         scheduled_at = excluded.scheduled_at, state = 'scheduled', settled_at = NULL, failure_reason = NULL`,
    ).run(record.draftId, record.outcome, record.sentText, record.sendAt, record.scheduledAt);
  });
  return record;
}

/** Takes a held send back before it fires. Throws `ScheduledSendNotFoundError` when nothing is held for the draft (never scheduled, already fired, already cancelled). */
export function cancelScheduledSend(storePath: string, passphrase: string, draftId: string, now: Date = new Date()): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureScheduledSendSchema(db);
    const result = db
      .prepare(`UPDATE scheduled_sends SET state = 'cancelled', settled_at = ? WHERE draft_id = ? AND state = 'scheduled'`)
      .run(now.toISOString(), draftId);
    if (result.changes === 0) {
      throw new ScheduledSendNotFoundError(draftId);
    }
  });
}

/** Every send still held, soonest first. */
export function listScheduledSends(storePath: string, passphrase: string): ScheduledSend[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureScheduledSendSchema(db);
    const rows = db.prepare(`SELECT * FROM scheduled_sends WHERE state = 'scheduled' ORDER BY send_at, draft_id`).all() as unknown as ScheduledSendRow[];
    return rows.map(rowToScheduledSend);
  });
}

export function getScheduledSend(storePath: string, passphrase: string, draftId: string): ScheduledSend | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureScheduledSendSchema(db);
    const row = db.prepare(`SELECT * FROM scheduled_sends WHERE draft_id = ?`).get(draftId) as ScheduledSendRow | undefined;
    return row ? rowToScheduledSend(row) : undefined;
  });
}

/** Records how a held send settled once the runner has fired it. */
export function settleScheduledSend(
  storePath: string,
  passphrase: string,
  draftId: string,
  state: Exclude<ScheduledSendState, "scheduled" | "cancelled">,
  failureReason: string | null = null,
  now: Date = new Date(),
): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureScheduledSendSchema(db);
    db.prepare(`UPDATE scheduled_sends SET state = ?, settled_at = ?, failure_reason = ? WHERE draft_id = ? AND state = 'scheduled'`).run(
      state,
      now.toISOString(),
      failureReason,
      draftId,
    );
  });
}

// ---------------------------------------------------------------------------
// Working hours — "start of their working hours" (#261).
//
// SIMPLIFICATION: there is no per-colleague profile on this daemon to read a
// recipient's own hours from, so "their working hours" is one setting per
// duo — the owner's org default (09:00–18:00, Monday to Friday, in one IANA
// time zone), editable from the app. A per-person override can layer on top
// of this later without changing the resolution below.
// ---------------------------------------------------------------------------

export interface WorkingHours {
  /** "HH:MM", 24-hour, in `timezone`. */
  readonly start: string;
  /** "HH:MM", 24-hour, in `timezone`. */
  readonly end: string;
  /** An IANA time zone name. */
  readonly timezone: string;
  /** Working days, 0 = Sunday … 6 = Saturday. */
  readonly days: readonly number[];
}

export class InvalidWorkingHoursError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkingHoursError";
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The default when the owner has never set one: 09:00–18:00 weekdays, in the daemon's own zone (`TZ`), else UTC. */
export function defaultWorkingHours(env: NodeJS.ProcessEnv = {}): WorkingHours {
  let timezone = "UTC";
  const candidate = env.TZ;
  if (candidate && isTimeZone(candidate)) {
    timezone = candidate;
  }
  return { start: "09:00", end: "18:00", timezone, days: [1, 2, 3, 4, 5] };
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function parseWorkingHours(input: { start?: unknown; end?: unknown; timezone?: unknown; days?: unknown }): WorkingHours {
  const { start, end, timezone, days } = input;
  if (typeof start !== "string" || !HHMM.test(start)) {
    throw new InvalidWorkingHoursError('start must be a 24-hour "HH:MM" time');
  }
  if (typeof end !== "string" || !HHMM.test(end)) {
    throw new InvalidWorkingHoursError('end must be a 24-hour "HH:MM" time');
  }
  if (end <= start) {
    throw new InvalidWorkingHoursError("end must be after start");
  }
  if (typeof timezone !== "string" || !isTimeZone(timezone)) {
    throw new InvalidWorkingHoursError(`timezone ${JSON.stringify(timezone)} is not a recognized IANA time zone name`);
  }
  if (!Array.isArray(days) || days.length === 0 || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new InvalidWorkingHoursError("days must be a non-empty list of weekdays, 0 (Sunday) to 6 (Saturday)");
  }
  return { start, end, timezone, days: [...new Set(days as number[])].sort((a, b) => a - b) };
}

function ensureWorkingHoursSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS working_hours (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL) STRICT`);
}

/** The owner's saved working hours, or the default when none were ever saved (or the stored value is unreadable). */
export function readWorkingHours(storePath: string, passphrase: string, env: NodeJS.ProcessEnv = {}): WorkingHours {
  const raw = withDatabase(storePath, passphrase, false, (db) => {
    ensureWorkingHoursSchema(db);
    return (db.prepare(`SELECT value FROM working_hours WHERE id = 1`).get() as { value: string } | undefined)?.value;
  });
  if (raw === undefined) {
    return defaultWorkingHours(env);
  }
  try {
    return parseWorkingHours(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return defaultWorkingHours(env);
  }
}

export function writeWorkingHours(storePath: string, passphrase: string, hours: WorkingHours): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureWorkingHoursSchema(db);
    db.prepare(`INSERT INTO working_hours (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value`).run(JSON.stringify(hours));
  });
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The UTC instant at which the wall clock in `timeZone` reads the given local date and time. */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  // Two passes settle the zone's offset, including across a DST change.
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zonedParts(guess, timeZone);
    guess += target - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  }
  return guess;
}

/**
 * The next start of working hours strictly after `now`: today's start if
 * today is a working day and it has not begun yet, else the start of the
 * next working day. Strict on purpose — "start of their working hours"
 * picked mid-morning means tomorrow morning, not "now".
 */
export function nextWorkingHoursStart(now: Date, hours: WorkingHours): Date {
  const [startHour, startMinute] = hours.start.split(":").map(Number) as [number, number];
  const today = zonedParts(now.getTime(), hours.timezone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const civil = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!hours.days.includes(civil.getUTCDay())) {
      continue;
    }
    const at = zonedTimeToUtc(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), startHour, startMinute, hours.timezone);
    if (at > now.getTime()) {
      return new Date(at);
    }
  }
  // Unreachable with a non-empty `days` (parseWorkingHours guarantees one), kept total for the type checker.
  throw new InvalidWorkingHoursError("working hours name no working day");
}
