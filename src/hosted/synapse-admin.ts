import { isRailwayInternalHost } from "../workspace/settings.js";

/**
 * A small client for the few Synapse admin endpoints hosted provisioning
 * needs (docs/deploy/hosted-workspace.md §5): create-or-update an account,
 * mint an access token for one, and ask who the admin token belongs to.
 *
 * Two rules shape everything here:
 *
 * - **The admin token is an act-as-any-user credential.** It travels only in
 *   the `Authorization` header of a request to the configured base URL. It is
 *   never put in a URL, a log line or an error, and `redirect: "error"`
 *   means a misbehaving front cannot bounce it to another host.
 * - **A minted access token is a secret too**, and is returned to the caller
 *   and nowhere else. Errors carry the HTTP status and Synapse's `errcode`
 *   (a fixed vocabulary such as `M_FORBIDDEN`), never a response body or the
 *   underlying network error text, so no secret can ride an exception into
 *   a log.
 */

export class SynapseConfigError extends Error {
  constructor(reason: string) {
    super(`Synapse admin API is misconfigured: ${reason}`);
    this.name = "SynapseConfigError";
  }
}

/**
 * The admin API could not do what was asked. `retryable` is true for an
 * outage (unreachable, timed out, 5xx, 429), false for a request Synapse
 * understood and refused (a bad token, a bad user id): a retry only helps
 * the first kind, though callers may still retry both, harmlessly.
 */
export class SynapseAdminError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errcode: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SynapseAdminError";
  }
}

export interface SynapseAdminOptions {
  /** The homeserver's base URL as the daemon reaches it: https, or http on a `*.railway.internal` host. */
  readonly baseUrl: string;
  /** `DUO_WORKSPACE_ADMIN_TOKEN`: the service account's access token. */
  readonly adminToken: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * How long a minted token lives. Deliberately required and explicit: Synapse
 * defaults to a token that never expires, so "no expiry" must be a decision
 * (`{ neverExpires: true }`, the duo's own token per §5) and not an omission.
 * A person's session token always gets `validUntilMs`.
 */
export type TokenLifetime = { readonly validUntilMs: number } | { readonly neverExpires: true };

const DEFAULT_TIMEOUT_MS = 10_000;

/** Validates the base URL rule shared with `workspaceSettingsFrom`: https, or http only on Railway's private network. Returns it without a trailing slash. */
export function assertSynapseBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SynapseConfigError("the homeserver URL is not a parseable URL");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isRailwayInternalHost(parsed.hostname))) {
    throw new SynapseConfigError("the homeserver URL must be https (plain http is accepted only for a *.railway.internal host)");
  }
  if (parsed.username || parsed.password) {
    throw new SynapseConfigError("the homeserver URL must not carry credentials");
  }
  return raw.replace(/\/+$/, "");
}

export class SynapseAdmin {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SynapseAdminOptions) {
    if (!options.adminToken) {
      throw new SynapseConfigError("no admin token");
    }
    this.baseUrl = assertSynapseBaseUrl(options.baseUrl);
    this.adminToken = options.adminToken;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Creates the account, or updates it if it exists (`PUT /_synapse/admin/v2/users/<id>`).
   * No password is sent, so a created account has none: it can never be
   * logged into except by a token the daemon mints. `admin: false` is sent
   * on purpose, so a replay can never leave an account privileged.
   * `created` is Synapse's own answer (201 new, 200 already there).
   */
  async putUser(userId: string, profile: { displayName: string }): Promise<{ created: boolean }> {
    const { status } = await this.call("PUT", `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, {
      displayname: profile.displayName,
      admin: false,
    });
    return { created: status === 201 };
  }

  /**
   * Mints an access token for `userId` (`POST /_synapse/admin/v1/users/<id>/login`).
   * Synapse creates no device for it, and the daemon cannot revoke it later,
   * so the lifetime is a required argument (see `TokenLifetime`).
   */
  async mintToken(userId: string, lifetime: TokenLifetime): Promise<string> {
    const body = "validUntilMs" in lifetime ? { valid_until_ms: lifetime.validUntilMs } : {};
    const { json } = await this.call("POST", `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/login`, body);
    const token = (json as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new SynapseAdminError("Synapse admin API returned no access token", 200, null, false);
    }
    return token;
  }

  /** The Matrix user id the admin token belongs to (`GET /_matrix/client/v3/account/whoami`); its server part is Synapse's `server_name`. */
  async whoAmI(): Promise<string> {
    const { json } = await this.call("GET", "/_matrix/client/v3/account/whoami");
    const userId = (json as { user_id?: unknown } | null)?.user_id;
    if (typeof userId !== "string" || !userId.startsWith("@")) {
      throw new SynapseAdminError("Synapse whoami returned no user id", 200, null, false);
    }
    return userId;
  }

  private async call(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const label = `${method} ${path.replace(/\/users\/[^/]+/, "/users/<id>")}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.adminToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Only the error's name, never its message or cause: network errors can quote the URL or headers.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SynapseAdminError(`Synapse admin API ${label} ${timedOut ? "timed out" : "could not be reached"}`, null, null, true);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      // Only a well-formed Matrix errcode is ever quoted, so nothing else in the body can reach a message.
      const rawErrcode = (json as { errcode?: unknown } | null)?.errcode;
      const errcode = typeof rawErrcode === "string" && /^M_[A-Z_]{1,40}$/.test(rawErrcode) ? rawErrcode : null;
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new SynapseAdminError(
        `Synapse admin API ${label} failed: HTTP ${response.status}${errcode ? ` ${errcode}` : ""}`,
        response.status,
        errcode,
        retryable,
      );
    }
    return { status: response.status, json };
  }
}
