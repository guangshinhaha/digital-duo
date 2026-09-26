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

  /**
   * Ends a person's OWN access token (`POST /_matrix/client/v3/logout`, with that token as the bearer).
   * Used when a device of the duo is revoked, so a session the daemon handed out stops working now and
   * not at its expiry (#233). A token Synapse already refuses (401) is already ended, so that is not an
   * error; an outage throws as elsewhere and the caller treats this as best effort. The token travels
   * only in the `Authorization` header, like the admin token.
   */
  async logoutAs(accessToken: string): Promise<void> {
    try {
      await this.call("POST", "/_matrix/client/v3/logout", {}, accessToken);
    } catch (error) {
      if (error instanceof SynapseAdminError && error.status === 401) {
        return;
      }
      throw error;
    }
  }

  /**
   * Creates a room as the service account (`PUT /_matrix/client/v3/createRoom/<txnId>`, docs/deploy/hosted-workspace.md
   * §6, §12). **Always private**: `visibility: "private"` and the `private_chat` preset (invite-only) are
   * fixed here and not options, so no caller can make a public room, which would put everyone in it in
   * every org's directory. A Space is the same room with `creation_content.type = "m.space"`, and only
   * the service account may post in it (`events_default: 100`, the spec's recommendation).
   *
   * **Only the service account may invite** (`invite: 100` in both rooms). The `private_chat` preset
   * sets `invite: 0`, so without this override any member could invite any user id, another org's
   * included, and the caller's override replaces the preset's key whole (Synapse merges it with a
   * shallow `update`). Only the daemon adds people, through the admin join API, and that invite is sent
   * by the service account, who holds 100 as the creator and can also send `m.space.child` and
   * `m.room.name` (state events need 50).
   *
   * `txnId` is Matrix's idempotency key (Synapse v1.161.0 `RoomCreateRestServlet`): a second request with
   * the same id, by the same token, within 30 minutes returns the first request's room. The cache is in
   * memory, so a Synapse restart or the 30 minutes ends it; after that the same id creates a new room.
   * Callers therefore use a stable id per room (`org-<orgId>-space`) and still record the room id at once.
   */
  async createPrivateRoom(options: { name: string; txnId: string; space?: boolean }): Promise<string> {
    const { json } = await this.call("PUT", `/_matrix/client/v3/createRoom/${encodeURIComponent(options.txnId)}`, {
      name: options.name,
      visibility: "private",
      preset: "private_chat",
      ...(options.space ? { creation_content: { type: "m.space" } } : {}),
      power_level_content_override: { invite: 100, ...(options.space ? { events_default: 100 } : {}) },
    });
    const roomId = (json as { room_id?: unknown } | null)?.room_id;
    if (typeof roomId !== "string" || !roomId.startsWith("!")) {
      throw new SynapseAdminError("Synapse createRoom returned no room id", 200, null, false);
    }
    return roomId;
  }

  /** Makes `childRoomId` a child of the Space (`PUT .../state/m.space.child/<child>` with `via`). Safe to repeat: it rewrites the same state. */
  async addSpaceChild(spaceRoomId: string, childRoomId: string, via: readonly string[]): Promise<void> {
    await this.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/state/m.space.child/${encodeURIComponent(childRoomId)}`, {
      via,
      suggested: true,
    });
  }

  /** Sets a room's name (`PUT .../state/m.room.name`), as the service account, which is in the room and its creator. */
  async setRoomName(roomId: string, name: string): Promise<void> {
    await this.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, { name });
  }

  /**
   * Who is joined to the room (`GET /_synapse/admin/v1/rooms/<room>/members`): `{members: [user ids], total}`,
   * joined users only, in one unpaginated answer (Synapse v1.161.0 `RoomMembersRestServlet`). 404 for an
   * unknown room. An invited or left user is not listed.
   */
  async roomMembers(roomId: string): Promise<string[]> {
    const { json } = await this.call("GET", `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`);
    const members = (json as { members?: unknown } | null)?.members;
    if (!Array.isArray(members) || !members.every((member) => typeof member === "string")) {
      throw new SynapseAdminError("Synapse room members returned no member list", 200, null, false);
    }
    return members as string[];
  }

  /**
   * Puts a local account into a room with no invite to accept (`POST /_synapse/admin/v1/join/<room>`,
   * body `{user_id}`). The service account must be in the room with the right to invite; for a private
   * room Synapse invites the user as the admin and then joins them as themselves, so the join runs
   * through Synapse's org module as that user (§6.2).
   *
   * **Idempotent here, not in Synapse.** That admin invite is refused with `403 M_FORBIDDEN` when the
   * user is already in the room (v1.161.0 `event_auth.py`), so a repeat call would fail. This asks who is
   * in first and does nothing for a user already joined. A 403 is never read as "already in": a module
   * refusal is the same status and errcode, and errors do not carry the body that would tell them apart.
   */
  async joinUser(roomId: string, userId: string): Promise<void> {
    if ((await this.roomMembers(roomId)).includes(userId)) {
      return;
    }
    await this.call("POST", `/_synapse/admin/v1/join/${encodeURIComponent(roomId)}`, { user_id: userId });
  }

  private async call(method: "GET" | "PUT" | "POST", path: string, body?: unknown, bearer: string = this.adminToken): Promise<{ status: number; json: unknown }> {
    const label = `${method} ${path.replace(/\/users\/[^/]+/, "/users/<id>")}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
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
