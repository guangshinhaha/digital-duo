import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureDraftLogSchema, recipientKeyOf, type DraftProvenance, type DraftRecipient } from "../drafting/draft-log.js";
import { ensureScheduledSendSchema } from "../drafting/scheduled-sends.js";

/**
 * guangshinhaha/duo#266: autonomy the duo EARNS from its track record with
 * one person, and asks for — never a toggle the owner has to think to flip
 * (docs/concept.md §6: "promote slowly ... an explicit tap from the owner.
 * Never silently"; design principle P4, decisions not settings).
 *
 * The evidence is the draft log itself: every reply the duo drafted to a
 * person, and what the owner did with it — sent as written, edited, shaped,
 * or dismissed. Past a deliberately high bar (below), the duo raises an offer
 * that states that evidence in plain words. Accepting grants autonomy for
 * that one person only; declining (or later revoking) suppresses the same
 * offer for a cooldown. Nothing here ever grants anything by itself — an
 * offer is computed fresh from stored state on every read, the same
 * "nothing changes until they accept" shape as #54's promotion offers
 * (`trust/promotion.ts`).
 *
 * SCOPE (v1): the issue asks for (asker, topic). This daemon has corpus
 * topics (`derivation/topics.ts`) but records no topic against a draft, so
 * there is nothing to group a track record by topic with — building that is
 * its own piece of work. v1 is keyed by person alone; a topic dimension can
 * be added later as a narrower key without changing the offer/grant shape.
 *
 * WHAT COUNTS: only replies — drafts a person asked for through a channel
 * (`provenance.origin === "channel"`). Autonomy here means "answer them
 * myself", so the only evidence that speaks to it is how the owner handled
 * answers to questions that person actually asked; a draft the owner asked
 * their own duo for, even one addressed to someone, is a different act
 * (the client calls its verb Keep, not Send, for exactly this reason). The
 * same rule decides where granted autonomy can act
 * (`drafting/autonomous-send.ts`): only a reply has somewhere to go.
 *
 * Scoping: everything here reads and writes the one store it is handed, so
 * a hosted duo's grants can never be read while drafting for another duo.
 */

/**
 * At least this many decided replies to one person before any offer. A
 * wrong autonomous send is worse than a missed offer (the same posture as
 * #264's fact-check), so this is set well above #262's five-send bar for
 * merely adapting tone: twenty is roughly a month of a regular working
 * relationship, enough that one lucky streak cannot carry it.
 */
export const AUTONOMY_OFFER_MIN_DECIDED = 20;

/**
 * Share of those replies sent exactly as drafted. 0.95 over twenty means at
 * most one was edited, shaped or dismissed. Deliberately stricter than the
 * "90%" the issue gives as an example: at 90% one reply in ten still needed
 * the owner's hand, which is not a record to stop checking on.
 */
export const AUTONOMY_OFFER_MIN_UNEDITED_SHARE = 0.95;

/**
 * The most recent replies must ALL have gone out unedited. A record that was
 * excellent and has just slipped (a changed relationship, a new kind of
 * question) is exactly when not to ask.
 */
export const AUTONOMY_OFFER_RECENT_CLEAN = 5;

/**
 * The replies must span at least a week, oldest to newest. Twenty answers to
 * one burst of questions on one afternoon is one conversation, not a track
 * record.
 */
export const AUTONOMY_OFFER_MIN_SPAN_DAYS = 7;

/** The most recent decided replies a track record is computed over — recent enough to follow a relationship that has changed. */
export const AUTONOMY_TRACK_RECORD_WINDOW = 30;

/** After a decline (or a revoke), the same offer stays quiet this long — #266 AC "declining suppresses the same offer for a set period". */
export const AUTONOMY_OFFER_COOLDOWN_DAYS = 30;

/**
 * A dismissal for one of these reasons anywhere in the window blocks the
 * offer outright, however good the rest of the record: the owner said the
 * duo got the facts wrong, or should not have answered at all — both mean
 * "not unsupervised", not "one miss in twenty".
 */
const DISQUALIFYING_DISMISS_REASONS: ReadonlySet<string> = new Set(["wrong_facts", "shouldnt_answer"]);

/** The undo window (#268) an autonomous send is held for when the owner never chose one. Long enough for a push to land and be read on a phone; Gmail's longest undo-send is 30s for the same reason. */
export const DEFAULT_AUTONOMY_HOLD_SECONDS = 30;

/** The longest undo window accepted. Past ten minutes a held "answer" is no longer an answer the asker is waiting for. */
export const MAX_AUTONOMY_HOLD_SECONDS = 600;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How the owner handled one decided reply. */
export type ReplyHandling = "unedited" | "edited" | "dismissed";

/** One decided reply, as the track record reads it — exported so the pure computation below is testable without a store. */
export interface DecidedReply {
  readonly recipientKey: string;
  readonly recipientName: string | null;
  readonly handling: ReplyHandling;
  readonly dismissReason: string | null;
  /** When the owner decided it (ISO-8601). */
  readonly decidedAt: string;
}

/** What the duo has to show for itself with one person. */
export interface TrackRecord {
  readonly recipientKey: string;
  readonly recipientName: string | null;
  /** Decided replies considered (at most AUTONOMY_TRACK_RECORD_WINDOW, newest first). */
  readonly considered: number;
  readonly sentUnedited: number;
  readonly edited: number;
  readonly dismissed: number;
  /** sentUnedited / considered, 0 when nothing was considered. */
  readonly uneditedShare: number;
  /** Oldest and newest decision in the window (ISO-8601), null when empty. */
  readonly since: string | null;
  readonly latest: string | null;
  /** True when the most recent AUTONOMY_OFFER_RECENT_CLEAN replies all went out unedited. */
  readonly recentClean: boolean;
  /** True when any reply in the window was dismissed as wrong on the facts or as one the duo should not have answered. */
  readonly disqualified: boolean;
}

/** Groups decided replies by person (newest first within each) and measures each window. Pure. */
export function computeTrackRecords(replies: readonly DecidedReply[]): TrackRecord[] {
  const byKey = new Map<string, DecidedReply[]>();
  for (const reply of [...replies].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))) {
    const list = byKey.get(reply.recipientKey) ?? [];
    if (list.length < AUTONOMY_TRACK_RECORD_WINDOW) {
      list.push(reply);
    }
    byKey.set(reply.recipientKey, list);
  }
  return [...byKey.entries()].map(([recipientKey, window]) => {
    const sentUnedited = window.filter((reply) => reply.handling === "unedited").length;
    const recent = window.slice(0, AUTONOMY_OFFER_RECENT_CLEAN);
    return {
      recipientKey,
      recipientName: window.find((reply) => reply.recipientName !== null)?.recipientName ?? null,
      considered: window.length,
      sentUnedited,
      edited: window.filter((reply) => reply.handling === "edited").length,
      dismissed: window.filter((reply) => reply.handling === "dismissed").length,
      uneditedShare: window.length === 0 ? 0 : sentUnedited / window.length,
      since: window.length > 0 ? window[window.length - 1].decidedAt : null,
      latest: window.length > 0 ? window[0].decidedAt : null,
      recentClean: recent.length === AUTONOMY_OFFER_RECENT_CLEAN && recent.every((reply) => reply.handling === "unedited"),
      disqualified: window.some((reply) => reply.dismissReason !== null && DISQUALIFYING_DISMISS_REASONS.has(reply.dismissReason)),
    };
  });
}

/** Whether a track record clears every part of the documented bar above. Pure. */
export function meetsAutonomyThreshold(record: TrackRecord): boolean {
  if (record.considered < AUTONOMY_OFFER_MIN_DECIDED || record.uneditedShare < AUTONOMY_OFFER_MIN_UNEDITED_SHARE) {
    return false;
  }
  if (!record.recentClean || record.disqualified || record.since === null || record.latest === null) {
    return false;
  }
  return Date.parse(record.latest) - Date.parse(record.since) >= AUTONOMY_OFFER_MIN_SPAN_DAYS * DAY_MS;
}

export function ensureRecipientAutonomySchema(db: Database): void {
  ensureDraftLogSchema(db);
  ensureScheduledSendSchema(db);
  // One row per person ever granted. A revoke stamps `revoked_at` rather
  // than deleting, so "what was my duo allowed to do, and when" stays
  // answerable (the trust epic's audit stance, #267).
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipient_autonomy_grants (
      recipient_key TEXT PRIMARY KEY,
      recipient_name TEXT,
      granted_at TEXT NOT NULL,
      evidence TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipient_autonomy_declines (
      recipient_key TEXT PRIMARY KEY,
      declined_at TEXT NOT NULL
    ) STRICT
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_settings (id INTEGER PRIMARY KEY CHECK (id = 1), hold_seconds INTEGER NOT NULL) STRICT`);
}

interface ReplyRow {
  id: string;
  provenance: string | null;
  recipient_ref: string | null;
  recipient_name: string | null;
  outcome: string;
  draft_text: string | null;
  sent_text: string | null;
  dismiss_reason: string | null;
  outcome_recorded_at: string | null;
  created_at: string;
}

function parseChannelProvenance(raw: string | null): DraftProvenance | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { origin?: unknown; channelKind?: unknown; askerRef?: unknown; threadId?: unknown; permalink?: unknown };
    if (parsed.origin === "channel" && typeof parsed.channelKind === "string" && typeof parsed.askerRef === "string") {
      return { origin: "channel", channelKind: parsed.channelKind, askerRef: parsed.askerRef, threadId: null, permalink: null };
    }
  } catch {
    // An unreadable provenance is not a reply anyone can be shown to have asked — skipped.
  }
  return undefined;
}

/** Who a channel reply is to, as the grant key — the same `recipientKeyOf` shapes (#258) and per-recipient voice (#262) already key by. */
function replyKey(provenance: DraftProvenance, recipient: DraftRecipient | null): string | undefined {
  const key = recipientKeyOf(provenance, recipient);
  return key === "owner" ? undefined : key;
}

/** The display name for a reply's person: the stated recipient's name, else the channel's own asker reference. */
function replyName(provenance: DraftProvenance, recipient: DraftRecipient | null): string | null {
  if (recipient?.name) {
    return recipient.name;
  }
  return provenance.origin === "channel" ? provenance.askerRef : null;
}

function readDecidedReplies(db: Database): DecidedReply[] {
  ensureRecipientAutonomySchema(db);
  // Only replies the OWNER decided: an escalation has no draft to judge, and
  // a send the duo made by itself (#268) is not evidence for the autonomy
  // that made it — counting it would let a grant feed its own record.
  const rows = db
    .prepare(
      `
      SELECT d.id, d.provenance, d.recipient_ref, d.recipient_name, d.outcome, d.draft_text, d.sent_text, d.dismiss_reason, d.outcome_recorded_at, d.created_at
      FROM drafts d
      WHERE d.outcome IN ('sent', 'edited', 'discarded') AND d.escalated = 0
        AND NOT EXISTS (SELECT 1 FROM scheduled_sends s WHERE s.draft_id = d.id AND s.autonomous = 1 AND s.state = 'sent')
    `,
    )
    .all() as unknown as ReplyRow[];
  const shaped = new Set(
    (db.prepare(`SELECT DISTINCT draft_id FROM draft_shapes WHERE undone_at IS NULL`).all() as unknown as { draft_id: string }[]).map((row) => row.draft_id),
  );
  const replies: DecidedReply[] = [];
  for (const row of rows) {
    const provenance = parseChannelProvenance(row.provenance);
    if (provenance === undefined) {
      continue;
    }
    const recipient = row.recipient_ref !== null ? { id: row.recipient_ref, name: row.recipient_name } : null;
    const key = replyKey(provenance, recipient);
    if (key === undefined) {
      continue;
    }
    // "Unedited" is strict: sent, with no shape the owner kept, and — when a
    // sent text was recorded at all — the very text the duo drafted.
    let handling: ReplyHandling;
    if (row.outcome === "discarded") {
      handling = "dismissed";
    } else if (row.outcome === "sent" && !shaped.has(row.id) && (row.sent_text === null || row.sent_text.trim() === (row.draft_text ?? "").trim())) {
      handling = "unedited";
    } else {
      handling = "edited";
    }
    replies.push({
      recipientKey: key,
      recipientName: replyName(provenance, recipient),
      handling,
      dismissReason: row.dismiss_reason,
      decidedAt: row.outcome_recorded_at ?? row.created_at,
    });
  }
  return replies;
}

/** Every person the duo has drafted decided replies to, with its record — what a person's profile reads to say how close the duo is to asking. */
export function listTrackRecords(storePath: string, passphrase: string): TrackRecord[] {
  return withDatabase(storePath, passphrase, false, (db) => computeTrackRecords(readDecidedReplies(db)));
}

export function getTrackRecord(storePath: string, passphrase: string, recipientKey: string): TrackRecord | undefined {
  return listTrackRecords(storePath, passphrase).find((record) => record.recipientKey === recipientKey);
}

// ---------------------------------------------------------------------------
// Settings — the undo window (#268).
// ---------------------------------------------------------------------------

export interface AutonomySettings {
  /** How long an autonomous send is held for Stop/Edit before it goes. 0 = no hold, settable only with explicit confirmation. */
  readonly holdSeconds: number;
}

export class InvalidAutonomySettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAutonomySettingError";
  }
}

export function readAutonomySettings(storePath: string, passphrase: string): AutonomySettings {
  const stored = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecipientAutonomySchema(db);
    return (db.prepare(`SELECT hold_seconds FROM autonomy_settings WHERE id = 1`).get() as { hold_seconds: number } | undefined)?.hold_seconds;
  });
  return { holdSeconds: stored ?? DEFAULT_AUTONOMY_HOLD_SECONDS };
}

/**
 * Saves the undo window. #268 AC: "0 disables the hold only after explicit
 * confirmation" — a 0 without `confirmNoHold: true` is refused, so no client
 * bug, slider dragged to the end, or stray request can quietly turn every
 * autonomous send into an instant one.
 */
export function writeAutonomySettings(storePath: string, passphrase: string, input: { holdSeconds?: unknown; confirmNoHold?: unknown }): AutonomySettings {
  const { holdSeconds, confirmNoHold } = input;
  if (typeof holdSeconds !== "number" || !Number.isInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > MAX_AUTONOMY_HOLD_SECONDS) {
    throw new InvalidAutonomySettingError(`holdSeconds must be a whole number of seconds from 0 to ${MAX_AUTONOMY_HOLD_SECONDS}`);
  }
  if (holdSeconds === 0 && confirmNoHold !== true) {
    throw new InvalidAutonomySettingError("Turning the undo window off means your duo's replies go out the instant they're written. Send confirmNoHold: true to confirm.");
  }
  withDatabase(storePath, passphrase, true, (db) => {
    ensureRecipientAutonomySchema(db);
    db.prepare(`INSERT INTO autonomy_settings (id, hold_seconds) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hold_seconds = excluded.hold_seconds`).run(holdSeconds);
  });
  return { holdSeconds };
}

// ---------------------------------------------------------------------------
// Offers, grants, declines.
// ---------------------------------------------------------------------------

export interface AutonomyOffer {
  /** The person's key — also the offer's id in the accept/decline routes. */
  readonly recipientKey: string;
  readonly recipientName: string | null;
  readonly trackRecord: TrackRecord;
  /** The undo window a granted send would be held for, as of now. */
  readonly holdSeconds: number;
  /** The evidence, and the ask, in plain words (#266 AC "the offer states the evidence in plain words"). */
  readonly evidence: string;
}

export interface AutonomyGrant {
  readonly recipientKey: string;
  readonly recipientName: string | null;
  readonly grantedAt: string;
  /** The track record that earned it, as it stood when the owner accepted. */
  readonly evidence: TrackRecord;
  /** Null while the grant stands. */
  readonly revokedAt: string | null;
}

export class NoPendingAutonomyOfferError extends Error {
  constructor(recipientKey: string) {
    super(`No autonomy offer is pending for "${recipientKey}".`);
    this.name = "NoPendingAutonomyOfferError";
  }
}

export class AutonomyGrantNotFoundError extends Error {
  constructor(recipientKey: string) {
    super(`Your duo has no standing autonomy for "${recipientKey}".`);
    this.name = "AutonomyGrantNotFoundError";
  }
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** The offer's words — the evidence first, then the ask, then the safety net. */
export function describeOfferEvidence(record: TrackRecord, holdSeconds: number): string {
  const who = record.recipientName ?? "this person";
  const changed = record.considered - record.sentUnedited;
  const evidence =
    changed === 0
      ? `You've sent all of my last ${plural(record.considered, "reply", "replies")} to ${who} without changing a word.`
      : `You've sent ${record.sentUnedited} of my last ${plural(record.considered, "reply", "replies")} to ${who} without changing a word.`;
  const net =
    holdSeconds > 0
      ? ` I'd hold each answer for ${plural(holdSeconds, "second")} first, so you can stop or edit it.`
      : " Your undo window is off, so each answer would go out straight away.";
  return `${evidence} May I answer ${who} myself?${net}`;
}

interface GrantRow {
  recipient_key: string;
  recipient_name: string | null;
  granted_at: string;
  evidence: string;
  revoked_at: string | null;
}

function rowToGrant(row: GrantRow): AutonomyGrant {
  return {
    recipientKey: row.recipient_key,
    recipientName: row.recipient_name,
    grantedAt: row.granted_at,
    evidence: JSON.parse(row.evidence) as TrackRecord,
    revokedAt: row.revoked_at,
  };
}

function readGrant(db: Database, recipientKey: string): AutonomyGrant | undefined {
  const row = db.prepare(`SELECT * FROM recipient_autonomy_grants WHERE recipient_key = ?`).get(recipientKey) as GrantRow | undefined;
  return row ? rowToGrant(row) : undefined;
}

/** True while an offer for this person must stay quiet: declined, or a grant revoked, within the cooldown. */
function inCooldown(db: Database, recipientKey: string, now: Date): boolean {
  const cutoff = now.getTime() - AUTONOMY_OFFER_COOLDOWN_DAYS * DAY_MS;
  const declined = (db.prepare(`SELECT declined_at FROM recipient_autonomy_declines WHERE recipient_key = ?`).get(recipientKey) as { declined_at: string } | undefined)
    ?.declined_at;
  if (declined !== undefined && Date.parse(declined) > cutoff) {
    return true;
  }
  const revoked = readGrant(db, recipientKey)?.revokedAt;
  return revoked !== null && revoked !== undefined && Date.parse(revoked) > cutoff;
}

function pendingOffers(db: Database, now: Date): AutonomyOffer[] {
  ensureRecipientAutonomySchema(db);
  const holdSeconds =
    (db.prepare(`SELECT hold_seconds FROM autonomy_settings WHERE id = 1`).get() as { hold_seconds: number } | undefined)?.hold_seconds ?? DEFAULT_AUTONOMY_HOLD_SECONDS;
  return computeTrackRecords(readDecidedReplies(db))
    .filter(meetsAutonomyThreshold)
    .filter((record) => {
      const grant = readGrant(db, record.recipientKey);
      return !(grant !== undefined && grant.revokedAt === null) && !inCooldown(db, record.recipientKey, now);
    })
    .map((record) => ({
      recipientKey: record.recipientKey,
      recipientName: record.recipientName,
      trackRecord: record,
      holdSeconds,
      evidence: describeOfferEvidence(record, holdSeconds),
    }));
}

/**
 * Every offer the duo would make right now, computed fresh — never a queue
 * something could half-drain, and reading it changes nothing (#54's rule).
 * A person already granted, or inside a decline/revoke cooldown, has none.
 */
export function getAutonomyOffers(storePath: string, passphrase: string, now: Date = new Date()): AutonomyOffer[] {
  return withDatabase(storePath, passphrase, false, (db) => pendingOffers(db, now));
}

/**
 * The owner's explicit yes: grants autonomy for this one person, recording
 * the track record that earned it. Re-checks the offer inside the same
 * write, so a stale card (the record slipped, or it was declined on another
 * device) can never grant what is no longer offered.
 */
export function acceptAutonomyOffer(storePath: string, passphrase: string, recipientKey: string, now: Date = new Date()): AutonomyGrant {
  return withDatabase(storePath, passphrase, true, (db) => {
    const offer = pendingOffers(db, now).find((candidate) => candidate.recipientKey === recipientKey);
    if (!offer) {
      throw new NoPendingAutonomyOfferError(recipientKey);
    }
    db.prepare(
      `INSERT INTO recipient_autonomy_grants (recipient_key, recipient_name, granted_at, evidence, revoked_at) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(recipient_key) DO UPDATE SET recipient_name = excluded.recipient_name, granted_at = excluded.granted_at, evidence = excluded.evidence, revoked_at = NULL`,
    ).run(recipientKey, offer.recipientName, now.toISOString(), JSON.stringify(offer.trackRecord));
    db.prepare(`DELETE FROM recipient_autonomy_declines WHERE recipient_key = ?`).run(recipientKey);
    return readGrant(db, recipientKey)!;
  });
}

/** The owner's no: the same offer stays quiet for AUTONOMY_OFFER_COOLDOWN_DAYS. */
export function declineAutonomyOffer(storePath: string, passphrase: string, recipientKey: string, now: Date = new Date()): void {
  withDatabase(storePath, passphrase, true, (db) => {
    if (!pendingOffers(db, now).some((candidate) => candidate.recipientKey === recipientKey)) {
      throw new NoPendingAutonomyOfferError(recipientKey);
    }
    db.prepare(
      `INSERT INTO recipient_autonomy_declines (recipient_key, declined_at) VALUES (?, ?) ON CONFLICT(recipient_key) DO UPDATE SET declined_at = excluded.declined_at`,
    ).run(recipientKey, now.toISOString());
  });
}

/** Every standing grant, newest first — what a trust/settings surface lists for review and revocation. Revoked grants are left out. */
export function listAutonomyGrants(storePath: string, passphrase: string): AutonomyGrant[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecipientAutonomySchema(db);
    const rows = db.prepare(`SELECT * FROM recipient_autonomy_grants WHERE revoked_at IS NULL ORDER BY granted_at DESC, recipient_key`).all() as unknown as GrantRow[];
    return rows.map(rowToGrant);
  });
}

/** The standing grant for this person, or undefined — the one check `drafting/autonomous-send.ts` makes before the duo sends anything itself. */
export function activeAutonomyGrant(storePath: string, passphrase: string, recipientKey: string): AutonomyGrant | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRecipientAutonomySchema(db);
    const grant = readGrant(db, recipientKey);
    return grant !== undefined && grant.revokedAt === null ? grant : undefined;
  });
}

/**
 * Takes autonomy back: from now on replies to this person wait for the owner
 * again, and the duo will not ask again for AUTONOMY_OFFER_COOLDOWN_DAYS.
 * Throws `AutonomyGrantNotFoundError` when there is no standing grant.
 */
export function revokeAutonomyGrant(storePath: string, passphrase: string, recipientKey: string, now: Date = new Date()): AutonomyGrant {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureRecipientAutonomySchema(db);
    const result = db.prepare(`UPDATE recipient_autonomy_grants SET revoked_at = ? WHERE recipient_key = ? AND revoked_at IS NULL`).run(now.toISOString(), recipientKey);
    if (result.changes === 0) {
      throw new AutonomyGrantNotFoundError(recipientKey);
    }
    return readGrant(db, recipientKey)!;
  });
}

/** The grant key for a draft — exported for the send path, which must key a draft exactly as the track record did. Undefined for anything that is not a reply to someone. */
export function autonomyKeyForDraft(provenance: DraftProvenance, recipient: DraftRecipient | null): string | undefined {
  return provenance.origin === "channel" ? replyKey(provenance, recipient) : undefined;
}
