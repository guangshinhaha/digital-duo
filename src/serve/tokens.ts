import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * `client-tech-design.md` Part 2 — per-device tokens authenticate a client
 * to the daemon; the tailnet only authenticates the device onto the
 * network. Stored in the same encrypted personal store every other table
 * lives in, rather than a new storage layer, and only each token's SHA-256
 * hash is ever written — the raw token exists nowhere but the moment
 * `duo pair` prints it, so a stolen store yields no working credential.
 */
export interface DeviceToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

interface DeviceTokenRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

function rowToToken(row: DeviceTokenRow): DeviceToken {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at };
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function ensureDeviceTokenSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    ) STRICT
  `);
}

/** Result of `duo pair`: the raw token is returned exactly once and never persisted anywhere in this form — copy it to the device now. */
export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly token: string;
}

/** Mints a new device token, named for the device pairing it (#`client-tech-design.md` Part 2). */
export function createDeviceToken(storePath: string, passphrase: string, name: string): PairedDevice {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDeviceTokenSchema(db);
    db.prepare(`INSERT INTO device_tokens (id, name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)`).run(
      id,
      name,
      hashToken(token),
      createdAt,
    );
  });
  return { id, name, token };
}

/** Every paired device, oldest first — whether it can currently authenticate is `revokedAt === null`. */
export function listDeviceTokens(storePath: string, passphrase: string): DeviceToken[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDeviceTokenSchema(db);
    const rows = db.prepare(`SELECT * FROM device_tokens ORDER BY created_at, id`).all() as unknown as DeviceTokenRow[];
    return rows.map(rowToToken);
  });
}

/**
 * One paired device by id, or undefined — the read-back #177's revoke route
 * returns after `revokeDeviceToken`, so a client sees the `revokedAt` it just
 * caused without the route re-deriving anything from the list.
 */
export function getDeviceToken(storePath: string, passphrase: string, id: string): DeviceToken | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDeviceTokenSchema(db);
    const row = db.prepare(`SELECT * FROM device_tokens WHERE id = ?`).get(id) as DeviceTokenRow | undefined;
    return row ? rowToToken(row) : undefined;
  });
}

export class DeviceTokenNotFoundError extends Error {
  constructor(id: string) {
    super(`No paired device with id "${id}"`);
    this.name = "DeviceTokenNotFoundError";
  }
}

/** Revokes a device immediately. Losing a phone means revoking one token, never re-keying the store (client-tech-design.md Part 2). */
export function revokeDeviceToken(storePath: string, passphrase: string, id: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDeviceTokenSchema(db);
    const result = db.prepare(`UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), id);
    if (result.changes === 0) {
      const exists = db.prepare(`SELECT 1 FROM device_tokens WHERE id = ?`).get(id);
      if (!exists) {
        throw new DeviceTokenNotFoundError(id);
      }
      // Already revoked — revoking twice is a no-op, not an error.
    }
  });
}

/**
 * Verifies a raw bearer token against the store: looked up by its SHA-256
 * hash (an indexed equality lookup, never a byte-by-byte comparison
 * against a stored secret — the raw token is never stored to compare
 * against in the first place) and rejected if revoked.
 *
 * Deliberately read-only (`withDatabase(..., false, ...)`): this runs on
 * every authenticated request, and a write here would mean re-encrypting
 * and rewriting the whole store file — scrypt key derivation plus a
 * full-file AES-GCM pass — on every poll a client makes. `touchLastSeen`
 * below is the (throttled, caller-driven) write path for `last_seen_at`.
 */
export function verifyDeviceToken(storePath: string, passphrase: string, rawToken: string): DeviceToken | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureDeviceTokenSchema(db);
    const row = db.prepare(`SELECT * FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL`).get(hashToken(rawToken)) as
      | DeviceTokenRow
      | undefined;
    return row ? rowToToken(row) : undefined;
  });
}

/**
 * Stamps `last_seen_at` for one device. Callers (the daemon's auth
 * middleware) should throttle how often they call this — see
 * `verifyDeviceToken`'s doc comment on why an unthrottled write-per-request
 * would be expensive — rather than this function throttling for them,
 * since "how fresh does this need to be" is a policy decision that
 * belongs where the request rate is known.
 */
export function touchLastSeen(storePath: string, passphrase: string, id: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureDeviceTokenSchema(db);
    db.prepare(`UPDATE device_tokens SET last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  });
}

/**
 * Issue #158 — ask links are a second token kind alongside `DeviceToken`,
 * deliberately not device tokens with a permission flag: a device pairing
 * carries full owner power on every route, while an ask link is a
 * short-lived, ask-only credential minted for one person. Separating the
 * kinds by table is also what makes refusal structural on every existing
 * route — an ask token's hash is not in `device_tokens`, so the daemon's
 * auth hook already refuses it exactly as it refuses an unknown token
 * (nothing in `src/serve/auth.ts` knows ask links exist). #159's `POST /ask`
 * is the only route that will ever accept one.
 */
export interface AskToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface AskTokenRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function rowToAskToken(row: AskTokenRow): AskToken {
  return { id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

export function ensureAskTokenSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT
  `);
}

/** Result of `duo ask-link new`: the raw token is returned exactly once and never persisted anywhere in this form — copy it now. */
export interface MintedAskLink {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** Mints an ask link whose expiry is set by the caller as an ISO-8601 string (issue #158). */
export function createAskToken(storePath: string, passphrase: string, name: string, expiresAt: string): MintedAskLink {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  withDatabase(storePath, passphrase, true, (db) => {
    ensureAskTokenSchema(db);
    db.prepare(`INSERT INTO ask_tokens (id, name, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)`).run(
      id,
      name,
      hashToken(token),
      createdAt,
      expiresAt,
    );
  });
  return { id, name, token, expiresAt };
}

/** Every ask link, oldest first — whether it can still be used is `revokedAt === null` and an unexpired `expiresAt`. */
export function listAskTokens(storePath: string, passphrase: string): AskToken[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureAskTokenSchema(db);
    const rows = db.prepare(`SELECT * FROM ask_tokens ORDER BY created_at, id`).all() as unknown as AskTokenRow[];
    return rows.map(rowToAskToken);
  });
}

export class AskTokenNotFoundError extends Error {
  constructor(id: string) {
    super(`No ask link with id "${id}"`);
    this.name = "AskTokenNotFoundError";
  }
}

/** Revokes an ask link immediately; revoking an already-revoked link is a no-op, not an error (issue #158). */
export function revokeAskToken(storePath: string, passphrase: string, id: string): void {
  withDatabase(storePath, passphrase, true, (db) => {
    ensureAskTokenSchema(db);
    const result = db.prepare(`UPDATE ask_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), id);
    if (result.changes === 0) {
      const exists = db.prepare(`SELECT 1 FROM ask_tokens WHERE id = ?`).get(id);
      if (!exists) {
        throw new AskTokenNotFoundError(id);
      }
      // Already revoked — revoking twice is a no-op, not an error.
    }
  });
}

/**
 * Verifies a raw ask-link bearer token: unrevoked and unexpired, looked up
 * by SHA-256 hash exactly like `verifyDeviceToken`. Read-only for the same
 * cost reason, and with no write path at all — "not silently renewed"
 * (issue #158) is enforced by there being nothing here that could extend,
 * recreate, or reset an expiry. Timestamps compare as ISO-8601 strings,
 * which is order-equivalent to time comparison and the repo's convention.
 */
export function verifyAskToken(storePath: string, passphrase: string, rawToken: string): AskToken | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureAskTokenSchema(db);
    const row = db
      .prepare(`SELECT * FROM ask_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(hashToken(rawToken), new Date().toISOString()) as AskTokenRow | undefined;
    return row ? rowToAskToken(row) : undefined;
  });
}
