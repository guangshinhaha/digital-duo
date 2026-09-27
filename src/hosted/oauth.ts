import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LEGACY_SCOPES, SCOPES, isScope, type Scope } from "../serve/scopes.js";

/**
 * Issue #240: what the hosted daemon keeps to be a small OAuth 2.1
 * authorization server for the claude.ai connector. Claude registers itself
 * (dynamic client registration), sends the owner to sign in, and receives an
 * access token that names one duo, so a saved note can only ever land in the
 * duo whose owner signed in. The sign-in itself is the existing Google
 * identity; this store only remembers what was granted.
 *
 * Every secret (a code, an access token, a refresh token) is random and
 * stored only as its SHA-256 hash, like the device tokens: a copy of the file
 * yields nothing that can be replayed. Codes and pending sign-in requests are
 * in memory only, since they live for minutes; clients and grants persist so
 * a restart does not sign every connector out.
 */

export class OAuthError extends Error {
  constructor(
    /** The RFC 6749 error code the token and registration endpoints answer with. */
    readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_redirect_uri" | "invalid_client_metadata" | "temporarily_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** Where Claude sends the owner back after sign-in; a client can only register these. */
export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] as const;

const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** Registration is open to anyone (that is how Claude connects), so the number of remembered clients is capped. */
const MAX_CLIENTS = 1000;
/** A client is only ever forgotten to make room once it has sat unused this long: Claude registers and then authorizes within moments. */
const UNUSED_CLIENT_GRACE_MS = 60 * 60_000;
/** Sign-ins waiting on an owner are held in memory, and starting one needs no sign-in, so they are capped. */
const MAX_PENDING_REQUESTS = 1000;
const MAX_REDIRECT_URIS_PER_CLIENT = 5;
const MAX_CLIENT_NAME_LENGTH = 80;
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OAuthClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: string;
}

/** One authorization: a connected Claude, for one duo. Refreshing rotates its tokens but keeps its id. */
interface Grant {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly duoId: string;
  readonly createdAt: string;
  /** What the owner allowed at sign-in. A grant made before scopes existed has none recorded and is save-only. */
  readonly scopes?: readonly string[];
  lastUsedAt: string | null;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  /** The refresh token this one replaced: presenting it again means a copy was stolen, so the whole grant is revoked. */
  previousRefreshHash: string | null;
}

interface OAuthFile {
  clients: OAuthClient[];
  grants: Grant[];
}

/** A sign-in the owner has been sent to complete; consumed once when they approve or deny. */
export interface PendingAuthorization {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeChallenge: string;
  /** What Claude asked for (or everything the server offers, when it named nothing): the most the owner can grant. */
  readonly requestedScopes: readonly Scope[];
  readonly expiresAt: number;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly duoId: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: number;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: readonly Scope[];
}

/** What an owner sees of a connection: never a token, only that it exists and when it was last used. */
export interface Connection {
  readonly id: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly scopes: readonly Scope[];
}

/** A grant's scopes as recorded, or save-only for one made before scopes existed. */
function scopesOf(grant: Grant): Scope[] {
  const recorded = grant.scopes?.filter(isScope);
  return recorded === undefined ? [...LEGACY_SCOPES] : SCOPES.filter((scope) => recorded.includes(scope));
}

function hash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export class OAuthStore {
  private data: OAuthFile;
  private readonly requests = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();

  private readonly maxClients: number;
  private readonly maxPendingRequests: number;

  constructor(
    private readonly path: string,
    private readonly allowedRedirectUris: readonly string[] = CLAUDE_REDIRECT_URIS,
    private readonly now: () => number = Date.now,
    limits: { maxClients?: number; maxPendingRequests?: number } = {},
  ) {
    this.maxClients = limits.maxClients ?? MAX_CLIENTS;
    this.maxPendingRequests = limits.maxPendingRequests ?? MAX_PENDING_REQUESTS;
    this.data = this.load();
  }

  /**
   * A damaged file must not stop the hosted daemon at boot, and everything in it can be recovered by connecting
   * again: it is set aside as `.corrupt` and the store starts empty, which signs connectors out and nothing else.
   */
  private load(): OAuthFile {
    if (!existsSync(this.path)) {
      return { clients: [], grants: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<OAuthFile>;
      return { clients: Array.isArray(parsed.clients) ? parsed.clients : [], grants: Array.isArray(parsed.grants) ? parsed.grants : [] };
    } catch {
      renameSync(this.path, `${this.path}.corrupt`);
      return { clients: [], grants: [] };
    }
  }

  /** Forgets grants whose refresh token has lapsed: they can never be used again, and would otherwise pin their client forever. */
  private dropExpiredGrants(): void {
    const now = this.now();
    const live = this.data.grants.filter((grant) => grant.refreshExpiresAt > now);
    if (live.length !== this.data.grants.length) {
      this.data.grants = live;
      this.persist();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Dynamic client registration (RFC 7591): Claude registers itself. Only Claude's own callback addresses are accepted. */
  registerClient(input: { clientName?: unknown; redirectUris?: unknown }): OAuthClient {
    const uris = input.redirectUris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS_PER_CLIENT || uris.some((uri) => typeof uri !== "string")) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a short list of addresses.");
    }
    const refused = (uris as string[]).find((uri) => !this.allowedRedirectUris.includes(uri));
    if (refused !== undefined) {
      throw new OAuthError("invalid_redirect_uri", "That redirect address isn't one this server sends people back to.");
    }
    this.dropExpiredGrants();
    if (this.data.clients.length >= this.maxClients) {
      const inUse = new Set(this.data.grants.map((grant) => grant.clientId));
      const settled = this.now() - UNUSED_CLIENT_GRACE_MS;
      const oldestUnused = this.data.clients.find((existing) => !inUse.has(existing.id) && Date.parse(existing.createdAt) <= settled);
      if (!oldestUnused) {
        throw new OAuthError("invalid_client_metadata", "Too many clients are registered on this server.");
      }
      this.data.clients = this.data.clients.filter((existing) => existing !== oldestUnused);
    }
    const rawName = typeof input.clientName === "string" ? input.clientName.trim() : "";
    const client: OAuthClient = {
      id: newSecret().slice(0, 32),
      name: rawName.length > 0 ? rawName.slice(0, MAX_CLIENT_NAME_LENGTH) : "Claude",
      redirectUris: [...(uris as string[])],
      createdAt: new Date(this.now()).toISOString(),
    };
    this.data.clients.push(client);
    this.persist();
    return client;
  }

  getClient(id: string): OAuthClient | undefined {
    return this.data.clients.find((client) => client.id === id);
  }

  /** Remembers a validated authorization request; the owner is sent to sign in against the returned id. */
  beginAuthorization(input: {
    client: OAuthClient;
    redirectUri: string;
    state: string | undefined;
    codeChallenge: string;
    requestedScopes?: readonly Scope[];
  }): PendingAuthorization {
    this.sweep();
    if (this.requests.size >= this.maxPendingRequests) {
      throw new OAuthError("temporarily_unavailable", "Too many sign-ins are waiting; try again shortly.");
    }
    const pending: PendingAuthorization = {
      id: newSecret(),
      clientId: input.client.id,
      clientName: input.client.name,
      redirectUri: input.redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
      requestedScopes: input.requestedScopes ?? SCOPES,
      expiresAt: this.now() + REQUEST_TTL_MS,
    };
    this.requests.set(pending.id, pending);
    return pending;
  }

  getAuthorization(id: string): PendingAuthorization | undefined {
    const pending = this.requests.get(id);
    return pending && pending.expiresAt > this.now() ? pending : undefined;
  }

  /** Takes a pending authorization exactly once, whether it is approved or denied. */
  takeAuthorization(id: string): PendingAuthorization | undefined {
    const pending = this.getAuthorization(id);
    this.requests.delete(id);
    return pending;
  }

  /** Issues the one-time code that Claude trades for tokens; it names the duo the signed-in owner owns. */
  issueCode(pending: PendingAuthorization, duoId: string, granted: readonly Scope[]): string {
    const code = newSecret();
    this.codes.set(hash(code), {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      duoId,
      scopes: granted.filter((scope) => pending.requestedScopes.includes(scope)),
      expiresAt: this.now() + CODE_TTL_MS,
    });
    return code;
  }

  /** Trades a code for tokens (RFC 6749 §4.1.3 with PKCE). A code works once, and only for the client and address it was issued to. */
  exchangeCode(input: { code: string; clientId: string; redirectUri: string; codeVerifier: string }): IssuedTokens {
    const key = hash(input.code);
    const record = this.codes.get(key);
    this.codes.delete(key);
    if (!record || record.expiresAt <= this.now()) {
      throw new OAuthError("invalid_grant", "That code is invalid or has expired.");
    }
    const client = this.getClient(record.clientId);
    if (!client || record.clientId !== input.clientId || record.redirectUri !== input.redirectUri) {
      throw new OAuthError("invalid_grant", "That code was not issued to this client.");
    }
    if (!PKCE_VERIFIER.test(input.codeVerifier) || !safeEqual(createHash("sha256").update(input.codeVerifier).digest("base64url"), record.codeChallenge)) {
      throw new OAuthError("invalid_grant", "The code verifier does not match.");
    }
    const grant: Grant = {
      id: newSecret().slice(0, 16),
      clientId: client.id,
      clientName: client.name,
      duoId: record.duoId,
      createdAt: new Date(this.now()).toISOString(),
      scopes: record.scopes,
      lastUsedAt: null,
      accessHash: "",
      accessExpiresAt: 0,
      refreshHash: "",
      refreshExpiresAt: 0,
      previousRefreshHash: null,
    };
    const tokens = this.rotate(grant);
    this.data.grants.push(grant);
    this.persist();
    return tokens;
  }

  /** Trades a refresh token for a new pair. Presenting a token that was already replaced revokes the whole connection. */
  refresh(input: { refreshToken: string; clientId: string }): IssuedTokens {
    const presented = hash(input.refreshToken);
    const stolen = this.data.grants.find((grant) => grant.previousRefreshHash === presented && grant.clientId === input.clientId);
    if (stolen) {
      this.data.grants = this.data.grants.filter((grant) => grant !== stolen);
      this.persist();
      throw new OAuthError("invalid_grant", "That refresh token was already used; the connection has been revoked. Connect again.");
    }
    const grant = this.data.grants.find((candidate) => candidate.refreshHash === presented && candidate.clientId === input.clientId);
    if (!grant || grant.refreshExpiresAt <= this.now()) {
      throw new OAuthError("invalid_grant", "That refresh token is invalid or has expired.");
    }
    const tokens = this.rotate(grant);
    this.persist();
    return tokens;
  }

  private rotate(grant: Grant): IssuedTokens {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    grant.previousRefreshHash = grant.refreshHash === "" ? null : grant.refreshHash;
    grant.accessHash = hash(accessToken);
    grant.accessExpiresAt = this.now() + ACCESS_TTL_MS;
    grant.refreshHash = hash(refreshToken);
    grant.refreshExpiresAt = this.now() + REFRESH_TTL_MS;
    return { accessToken, refreshToken, expiresInSeconds: ACCESS_TTL_MS / 1000, scopes: scopesOf(grant) };
  }

  /** Which duo an access token is for, or undefined when it is unknown, expired or revoked. */
  verifyAccess(accessToken: string): { duoId: string; connectionId: string; scopes: readonly Scope[] } | undefined {
    const presented = hash(accessToken);
    const grant = this.data.grants.find((candidate) => candidate.accessHash === presented);
    if (!grant || grant.accessExpiresAt <= this.now()) {
      return undefined;
    }
    grant.lastUsedAt = new Date(this.now()).toISOString();
    return { duoId: grant.duoId, connectionId: grant.id, scopes: scopesOf(grant) };
  }

  connections(duoId: string): Connection[] {
    this.dropExpiredGrants();
    return this.data.grants
      .filter((grant) => grant.duoId === duoId)
      .map((grant) => ({ id: grant.id, clientName: grant.clientName, createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt, scopes: scopesOf(grant) }));
  }

  /** Revokes one connection of this duo at once; false when the duo has no such connection. */
  revoke(duoId: string, connectionId: string): boolean {
    const before = this.data.grants.length;
    this.data.grants = this.data.grants.filter((grant) => !(grant.duoId === duoId && grant.id === connectionId));
    if (this.data.grants.length === before) {
      return false;
    }
    this.persist();
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, pending] of this.requests) {
      if (pending.expiresAt <= now) {
        this.requests.delete(id);
      }
    }
    for (const [key, code] of this.codes) {
      if (code.expiresAt <= now) {
        this.codes.delete(key);
      }
    }
  }
}
