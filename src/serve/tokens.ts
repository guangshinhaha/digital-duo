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
