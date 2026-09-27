import { randomUUID } from "node:crypto";
import { generateVAPIDKeys } from "web-push";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * digital-duo#251: one device's push registration and the rule for when it
 * may be interrupted. `manual` is this device's own do-not-disturb (the
 * client's `DndPrefs`, mirrored here because a **web** push has to show a
 * notification the instant it arrives — a browser will not let a page
 * swallow one silently — so holding it has to happen before it is ever
 * sent, on the server, not on the device that would otherwise show it).
 * `from`/`to` are a daily "HH:MM" window in `timezone`; both null (the
 * default) is no window. A half-set window — one of the two null, the
 * other not — is refused at registration (`parseQuietHours` below): the
 * client's own `DndPrefs` doc comment states the same rule ("a half-typed
 * form"), so the two must never drift apart.
 */
export interface QuietHours {
  readonly manual: boolean;
  readonly from: string | null;
  readonly to: string | null;
  readonly timezone: string;
}

export const QUIET_HOURS_OFF: QuietHours = { manual: false, from: null, to: null, timezone: "UTC" };

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly quietHours: QuietHours;
}

export interface PushSubscriptionRecord extends PushSubscriptionInput {
  readonly deviceId: string;
  readonly createdAt: string;
}

interface SubscriptionRow {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  quiet_manual: number;
  quiet_from: string | null;
  quiet_to: string | null;
  quiet_timezone: string;
  created_at: string;
}

function rowToRecord(row: SubscriptionRow): PushSubscriptionRecord {
  return {
    deviceId: row.device_id,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    quietHours: { manual: row.quiet_manual === 1, from: row.quiet_from, to: row.quiet_to, timezone: row.quiet_timezone },
    createdAt: row.created_at,
  };
}

export function ensurePushSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      device_id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      quiet_manual INTEGER NOT NULL DEFAULT 0,
      quiet_from TEXT,
      quiet_to TEXT,
      quiet_timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at TEXT NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_vapid_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT
  `);
}

export class InvalidQuietHoursError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuietHoursError";
  }
}

export class InvalidEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEndpointError";
  }
}

/**
 * Every real `PushSubscription.endpoint` a browser hands back is an
 * `https:` URL at the browser's own push service (FCM, Mozilla's, Apple's
 * web push gateway, …) — never anything else. This daemon POSTs to
 * whatever is stored here on every draft it writes, so an unvalidated
 * endpoint is this daemon's own address to send wherever a caller with a
 * device token names — the same shape of risk `workspace/settings.ts`
 * already refuses for `DUO_WORKSPACE_HOMESERVER` (plaintext there,
 * an arbitrary destination here). Refused, not merely warned about.
 */
export function parseSubscriptionEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidEndpointError("endpoint is required: the browser's own PushSubscription.endpoint");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidEndpointError(`endpoint is not a parseable URL (got ${JSON.stringify(value)})`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidEndpointError(
      `endpoint must be https (got ${JSON.stringify(parsed.protocol)}) — a real PushSubscription's endpoint always is, and this daemon posts to it on every draft it writes`,
    );
  }
  return value;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates a caller-supplied quiet-hours shape into the one this module
 * stores — never a half-set window (the client's own `DndPrefs` rule,
 * restated server-side since this daemon is the one that now evaluates it).
 * `timezone` is checked by asking `Intl` to actually use it: an unrecognized
 * IANA name throws here, at registration, rather than silently mishandling
 * every future evaluation of it.
 */
export function parseQuietHours(input: {
  manual?: unknown;
  from?: unknown;
  to?: unknown;
  timezone?: unknown;
}): QuietHours {
  const manual = input.manual === true;
  const from = input.from === null || input.from === undefined ? null : input.from;
  const to = input.to === null || input.to === undefined ? null : input.to;
  if ((from === null) !== (to === null)) {
    throw new InvalidQuietHoursError("quietHours.from and quietHours.to must both be set, or both left out — a half-set window is no window");
  }
  if (from !== null && (typeof from !== "string" || !HHMM.test(from))) {
    throw new InvalidQuietHoursError('quietHours.from must be "HH:MM"');
  }
  if (to !== null && (typeof to !== "string" || !HHMM.test(to))) {
    throw new InvalidQuietHoursError('quietHours.to must be "HH:MM"');
  }
  const timezone = input.timezone === undefined || input.timezone === null ? "UTC" : input.timezone;
  if (typeof timezone !== "string") {
    throw new InvalidQuietHoursError("quietHours.timezone must be a string");
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch {
    throw new InvalidQuietHoursError(`quietHours.timezone "${timezone}" is not a recognized IANA time zone name`);
  }
  return { manual, from: from as string | null, to: to as string | null, timezone };
}

/** Registers or replaces this device's subscription — one row per device, so re-subscribing (a rotated browser subscription, or updated quiet hours from Settings) simply overwrites what was there. */
export function upsertSubscription(storePath: string, passphrase: string, deviceId: string, input: PushSubscriptionInput): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensurePushSchema(db);
    db.prepare(
      `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, quiet_manual, quiet_from, quiet_to, quiet_timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
         quiet_manual = excluded.quiet_manual, quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to, quiet_timezone = excluded.quiet_timezone,
         created_at = excluded.created_at`,
    ).run(
      deviceId,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      input.quietHours.manual ? 1 : 0,
      input.quietHours.from,
      input.quietHours.to,
      input.quietHours.timezone,
      new Date().toISOString(),
    );
  });
}

/**
 * The raw delete, against a `db` the caller already has open. Exported so
 * `tokens.ts`'s `revokeDeviceToken` can remove a revoked device's
 * subscription inside its OWN write transaction — nesting a second
 * `withDatabase` call there would decrypt-and-reencrypt the whole store a
 * second time, against a copy that has not seen the revoke yet, and that
 * second write would then be silently discarded when the outer
 * transaction's own re-encrypt finishes last. One transaction, one write,
 * same law `revokeAllAutonomy` (`trust/grid.ts`) already follows for its
 * own multi-table revoke.
 */
export function deleteSubscriptionRow(db: Database, deviceId: string): void {
  ensurePushSchema(db);
  db.prepare(`DELETE FROM push_subscriptions WHERE device_id = ?`).run(deviceId);
}

/** Removes this device's own subscription. A device with none is a no-op, not an error — `DELETE` is idempotent everywhere else in this codebase (`revokeDeviceToken`'s own precedent). */
export function removeSubscription(storePath: string, passphrase: string, deviceId: string): void {
  withDatabase(storePath, passphrase, true, (db) => deleteSubscriptionRow(db, deviceId));
}

function readSubscriptionRows(db: Database): PushSubscriptionRecord[] {
  ensurePushSchema(db);
  const rows = db.prepare(`SELECT * FROM push_subscriptions ORDER BY created_at, device_id`).all() as unknown as SubscriptionRow[];
  return rows.map(rowToRecord);
}

/** Every registered subscription — "each of the owner's subscriptions" (#251): one duo, one owner, every paired device that has turned push on. */
export function listSubscriptions(storePath: string, passphrase: string): PushSubscriptionRecord[] {
  return withDatabase(storePath, passphrase, false, readSubscriptionRows);
}

/**
 * Every registered subscription and this duo's VAPID keys (`undefined` when
 * not generated yet), read together — one `withDatabase` call, not two.
 * `notifyDraftWaiting` (`push/notify.ts`) is the caller: it fires without
 * being awaited, so every synchronous millisecond spent here (each
 * `withDatabase` call decrypts and opens the whole store) is time the
 * event loop — and the response the route already sent — is blocked for.
 * The keys, when already generated (the ordinary case, after the first
 * ever push), come back in this same read; only their generation, the
 * once-ever case, still needs its own write (`getOrCreateVapidKeys`).
 */
export function readPushState(storePath: string, passphrase: string): { subscriptions: PushSubscriptionRecord[]; vapidKeys: VapidKeys | undefined } {
  return withDatabase(storePath, passphrase, false, (db) => ({
    subscriptions: readSubscriptionRows(db),
    vapidKeys: readVapidKeys(db),
  }));
}

function hhmmInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** Whether "HH:MM" falls in the ["from","to") window, wrapping past midnight when `to` <= `from` (e.g. "22:00"–"07:00"). */
function withinWindow(hhmm: string, from: string, to: string): boolean {
  return from <= to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

/**
 * Whether this subscription's own rule holds a push back right now — the
 * server-side twin of the client's `isDndActive` (`notificationPrefs.ts`),
 * evaluated here because only the server can decide before a web push is
 * ever sent. Manual do-not-disturb always holds; a daily window holds
 * exactly the minutes inside it, in the subscription's own time zone.
 */
export function isQuietNow(quietHours: QuietHours, now: Date = new Date()): boolean {
  if (quietHours.manual) {
    return true;
  }
  if (quietHours.from === null || quietHours.to === null) {
    return false;
  }
  return withinWindow(hhmmInZone(now, quietHours.timezone), quietHours.from, quietHours.to);
}

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

function readVapidKeys(db: Database): VapidKeys | undefined {
  ensurePushSchema(db);
  const row = db.prepare(`SELECT * FROM push_vapid_keys ORDER BY created_at LIMIT 1`).get() as
    | { public_key: string; private_key: string }
    | undefined;
  return row ? { publicKey: row.public_key, privateKey: row.private_key } : undefined;
}

/**
 * This duo's VAPID identity: generated once, the first time anything asks
 * for it, and kept forever after — replacing it would invalidate every
 * subscription every device has already registered, so nothing here ever
 * rotates it. `generate` defaults to `web-push`'s own `generateVAPIDKeys`
 * (itself a synchronous, non-network call) — a caller overrides it only to
 * keep a test deterministic, never to reach the real one; every production
 * caller can simply omit it.
 */
export function getOrCreateVapidKeys(storePath: string, passphrase: string, generate: () => VapidKeys = generateVAPIDKeys): VapidKeys {
  // Read-only first (`verifyDeviceToken`'s own discipline): this is called
  // on every push send, and a write transaction re-encrypts and rewrites
  // the whole store file — worth paying only on the one call, ever, that
  // actually generates the keys.
  const existing = withDatabase(storePath, passphrase, false, readVapidKeys);
  if (existing) {
    return existing;
  }
  return withDatabase(storePath, passphrase, true, (db) => {
    // Re-check inside the write: nothing in this single-process daemon can
    // race between the read above and here (every withDatabase call here
    // is synchronous, so JS's own single thread can never interleave two),
    // but re-checking costs nothing and keeps this correct even if a
    // caller ever changed that.
    const raced = readVapidKeys(db);
    if (raced) {
      return raced;
    }
    const keys = generate();
    db.prepare(`INSERT INTO push_vapid_keys (id, public_key, private_key, created_at) VALUES (?, ?, ?, ?)`).run(
      randomUUID(),
      keys.publicKey,
      keys.privateKey,
      new Date().toISOString(),
    );
    return keys;
  });
}
