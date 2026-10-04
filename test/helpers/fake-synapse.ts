import { randomBytes } from "node:crypto";

/**
 * An in-process fake of the few Synapse endpoints hosted provisioning uses, as a `fetch`.
 * No sockets: the daemon's base URL is a `*.railway.internal` address that only exists on
 * Railway, so tests hand this to `SynapseAdmin` / `createHostedServer` as their `fetch`.
 *
 * It behaves the way the admin docs say the real one does (checked 2026-09-26):
 * - `PUT /_synapse/admin/v2/users/<id>`: 201 when it creates, 200 when it modifies;
 * - `POST /_synapse/admin/v1/users/<id>/login`: `{access_token}` for an existing user, 404 otherwise;
 * - `GET /_matrix/client/v3/account/whoami`: the admin token's own user id;
 * - every call needs the admin token as a bearer, else 401 `M_UNKNOWN_TOKEN`;
 * - rooms (#234), as Synapse v1.161.0 does them: `PUT /createRoom/<txnId>` returns the first room again for a
 *   repeated id (until `expireTransactions()`, standing in for its 30 minute cache); the `private_chat` preset
 *   starts `invite` at 0 and the caller's `power_level_content_override` replaces keys whole (shallow update);
 *   the admin join API on an invite-only room first invites, so a user already joined gets 403 `M_FORBIDDEN`;
 *   `GET /_synapse/admin/v1/rooms/<room>/members` lists joined users only (no pagination, 404 for an unknown room);
 *   state events need the sender's level to reach `state_default`.
 */
export const FAKE_SYNAPSE_URL = "http://synapse.railway.internal:8008";
export const FAKE_SERVER_NAME = "duo.test";
export const FAKE_ADMIN_TOKEN = "syt_admin_token_that_must_never_leak";

export interface FakeUser {
  displayname: string | undefined;
  admin: boolean;
  hasPassword: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
  redirect: string | undefined;
}

export interface FakeSynapse {
  readonly fetch: typeof fetch;
  readonly users: Map<string, FakeUser>;
  /** Every access token this fake ever minted, with the request's `valid_until_ms`. */
  readonly minted: Array<{ userId: string; token: string; validUntilMs: number | null }>;
  readonly requests: FakeRequest[];
  /** While true every call fails as if the server were down (a refused connection). */
  down: boolean;
  /** Fail the next N calls with this HTTP status, then behave. */
  failNext(count: number, status: number, errcode?: string): void;
  /** Make the next call hang until its abort signal fires. */
  hangNext(): void;
  /** #233: the clock `whoami` judges a minted token's `valid_until_ms` by (default: real time). */
  now?: () => number;

  // --- rooms (#234): createRoom, m.space.child, m.room.name and the admin join API ---
  /** Every room the fake has created, by room id. */
  readonly rooms: Map<string, FakeRoom>;
  /** Forget the createRoom transaction ids, as Synapse does after 30 minutes or a restart. */
  expireTransactions(): void;
  /** Whether `userId` may invite in the room: their power level (default 0) reaches the room's `invite` level. */
  mayInvite(roomId: string, userId: string): boolean;
}

/** A room as the fake keeps it (#234). `joinRule` is "public" only for a `public_chat` preset, so tests can prove no room is ever public. */
export interface FakeRoom {
  roomId: string;
  name: string | undefined;
  /** `creation_content.type`, e.g. "m.space". */
  type: string | undefined;
  visibility: string | undefined;
  preset: string | undefined;
  joinRule: "invite" | "public";
  members: Set<string>;
  /** m.space.child state: child room id -> content (`via`, `suggested`). */
  children: Map<string, { via?: string[]; suggested?: boolean }>;
  /** `io.element.functional_members` state's `service_members`, once set (#272); undefined means never set. */
  functionalMembers: string[] | undefined;
  powerLevelOverride: unknown;
  /** The room's effective power levels: Synapse's defaults, the preset's, then the caller's override on top (shallow). */
  powerLevels: { invite: number; events_default: number; state_default: number; users_default: number; users: Record<string, number> };
}

export interface FakeSynapseOptions {
  adminToken?: string;
  serverName?: string;
  /**
   * #234: stand in for the org module (#235) on joins: an admin-API join runs as the target user, so refuse
   * (403 M_FORBIDDEN) a join of an account whose org (read from its id) differs from that of any non-service member of the room.
   * This models the module until #235 ships and has an end-to-end test of its own; a test that uses it is proving the
   * provisioner copes with a refusal, not that the real module refuses.
   */
  orgWall?: boolean;
}

export function createFakeSynapse(options: FakeSynapseOptions = {}): FakeSynapse {
  const adminToken = options.adminToken ?? FAKE_ADMIN_TOKEN;
  const serverName = options.serverName ?? FAKE_SERVER_NAME;
  const users = new Map<string, FakeUser>();
  const minted: FakeSynapse["minted"] = [];
  const requests: FakeRequest[] = [];
  let failures: { count: number; status: number; errcode: string } | null = null;
  let hang = false;
  const loggedOut = new Set<string>(); // #233
  const rooms = new Map<string, FakeRoom>();
  const transactions = new Map<string, string>();

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fake: FakeSynapse = {
    users,
    rooms,
    expireTransactions() {
      transactions.clear();
    },
    mayInvite(roomId, userId) {
      const room = rooms.get(roomId);
      return !!room && (room.powerLevels.users[userId] ?? room.powerLevels.users_default) >= room.powerLevels.invite;
    },
    minted,
    requests,
    down: false,
    failNext(count, status, errcode = "M_UNKNOWN") {
      failures = { count, status, errcode };
    },
    hangNext() {
      hang = true;
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      requests.push({
        method,
        path: url.pathname,
        authorization: headers.get("authorization"),
        body: rawBody === undefined ? undefined : JSON.parse(rawBody),
        redirect: init?.redirect,
      });

      if (fake.down) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED synapse.railway.internal:8008"), { code: "ECONNREFUSED" }) });
      }
      if (hang) {
        hang = false;
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
        });
      }
      if (failures && failures.count > 0) {
        failures.count -= 1;
        return json(failures.status, { errcode: failures.errcode, error: `Injected failure (token ${adminToken})` });
      }
      // --- #233: a minted token is a real credential on the fake, as it is on Synapse. ---
      // `whoami` with a minted token answers as that token's own user, so a test can prove whose
      // session it was handed. A token past its `valid_until_ms` (per `fake.now`) is refused.
      if (method === "GET" && url.pathname === "/_matrix/client/v3/account/whoami") {
        const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
        const session = minted.find((entry) => entry.token === bearer);
        if (session) {
          const expired = loggedOut.has(session.token) || (session.validUntilMs !== null && session.validUntilMs <= (fake.now?.() ?? Date.now()));
          return expired ? json(401, { errcode: "M_UNKNOWN_TOKEN", error: "Access token has expired" }) : json(200, { user_id: session.userId });
        }
      }
      // A client signing out: `POST /_matrix/client/v3/logout` with its own token expires that token only.
      if (method === "POST" && url.pathname === "/_matrix/client/v3/logout") {
        const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (minted.some((entry) => entry.token === bearer) && !loggedOut.has(bearer)) {
          loggedOut.add(bearer);
          return json(200, {});
        }
        return json(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" });
      }
      // --- end #233 ---
      if (headers.get("authorization") !== `Bearer ${adminToken}`) {
        return json(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" });
      }

      if (method === "GET" && url.pathname === "/_matrix/client/v3/account/whoami") {
        return json(200, { user_id: `@workspace-admin:${serverName}` });
      }
      const put = method === "PUT" ? /^\/_synapse\/admin\/v2\/users\/([^/]+)$/.exec(url.pathname) : null;
      if (put) {
        const userId = decodeURIComponent(put[1]!);
        const body = JSON.parse(rawBody ?? "{}") as { displayname?: string; admin?: boolean; password?: string };
        if (!new RegExp(`^@[a-z0-9._=/+-]+:${serverName.replace(/\./g, "\\.")}$`).test(userId)) {
          return json(400, { errcode: "M_INVALID_USERNAME", error: "bad user id" });
        }
        const existing = users.get(userId);
        users.set(userId, {
          displayname: body.displayname ?? existing?.displayname,
          admin: body.admin ?? existing?.admin ?? false,
          hasPassword: body.password !== undefined || existing?.hasPassword === true,
        });
        return json(existing ? 200 : 201, { name: userId });
      }
      const login = method === "POST" ? /^\/_synapse\/admin\/v1\/users\/([^/]+)\/login$/.exec(url.pathname) : null;
      if (login) {
        const userId = decodeURIComponent(login[1]!);
        if (!users.has(userId)) {
          return json(404, { errcode: "M_NOT_FOUND", error: "User not found" });
        }
        const body = JSON.parse(rawBody ?? "{}") as { valid_until_ms?: number };
        const token = `syt_minted_${randomBytes(12).toString("hex")}`;
        minted.push({ userId, token, validUntilMs: body.valid_until_ms ?? null });
        return json(200, { access_token: token });
      }
      // --- rooms (#234) ---
      const adminUserId = `@workspace-admin:${serverName}`;
      const roomOrg = (userId: string): string | null => {
        const local = /^@([^:]+):/.exec(userId)?.[1] ?? "";
        const stripped = local.startsWith("duo-") ? local.slice(4) : local;
        return stripped.includes(".") ? stripped.slice(0, stripped.indexOf(".")) : null;
      };
      const create = /^\/_matrix\/client\/v3\/createRoom(?:\/([^/]+))?$/.exec(url.pathname);
      if ((method === "POST" && create && create[1] === undefined) || (method === "PUT" && create && create[1] !== undefined)) {
        const txnId = create[1] === undefined ? null : decodeURIComponent(create[1]);
        const seen = txnId === null ? undefined : transactions.get(txnId);
        if (seen !== undefined) {
          return json(200, { room_id: seen });
        }
        const body = JSON.parse(rawBody ?? "{}") as {
          name?: string;
          visibility?: string;
          preset?: string;
          creation_content?: { type?: string };
          power_level_content_override?: Record<string, unknown>;
        };
        const roomId = `!${randomBytes(9).toString("hex")}:${serverName}`;
        rooms.set(roomId, {
          roomId,
          name: body.name,
          type: body.creation_content?.type,
          visibility: body.visibility,
          preset: body.preset,
          joinRule: body.preset === "public_chat" || body.visibility === "public" ? "public" : "invite",
          members: new Set([adminUserId]),
          children: new Map(),
          functionalMembers: undefined,
          powerLevelOverride: body.power_level_content_override,
          // The creator holds 100; private_chat sets invite 0; the caller's override replaces whole keys.
          powerLevels: {
            invite: 0,
            events_default: 0,
            state_default: 50,
            users_default: 0,
            users: { [adminUserId]: 100 },
            ...(body.power_level_content_override as object | undefined),
          },
        });
        if (txnId !== null) {
          transactions.set(txnId, roomId);
        }
        return json(200, { room_id: roomId });
      }
      const listed = method === "GET" ? /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/members$/.exec(url.pathname) : null;
      if (listed) {
        const room = rooms.get(decodeURIComponent(listed[1]!));
        if (!room) {
          return json(404, { errcode: "M_NOT_FOUND", error: "Room not found" });
        }
        const members = [...room.members];
        return json(200, { members, total: members.length });
      }
      const state = method === "PUT" ? /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/(m\.space\.child|m\.room\.name|io\.element\.functional_members)(?:\/([^/]+))?$/.exec(url.pathname) : null;
      if (state) {
        const room = rooms.get(decodeURIComponent(state[1]!));
        if (!room) {
          return json(404, { errcode: "M_NOT_FOUND", error: "Unknown room" });
        }
        if (!room.members.has(adminUserId)) {
          return json(403, { errcode: "M_FORBIDDEN", error: "not in the room" });
        }
        if ((room.powerLevels.users[adminUserId] ?? room.powerLevels.users_default) < room.powerLevels.state_default) {
          return json(403, { errcode: "M_FORBIDDEN", error: "not enough power to send this state event" });
        }
        const body = JSON.parse(rawBody ?? "{}") as { name?: string; via?: string[]; suggested?: boolean; service_members?: string[] };
        if (state[2] === "m.room.name") {
          room.name = body.name;
        } else if (state[2] === "io.element.functional_members") {
          room.functionalMembers = body.service_members ?? [];
        } else {
          room.children.set(decodeURIComponent(state[3] ?? ""), { via: body.via, suggested: body.suggested });
        }
        return json(200, { event_id: `$${randomBytes(6).toString("hex")}` });
      }
      const join = method === "POST" ? /^\/_synapse\/admin\/v1\/join\/([^/]+)$/.exec(url.pathname) : null;
      if (join) {
        const roomId = decodeURIComponent(join[1]!);
        const userId = (JSON.parse(rawBody ?? "{}") as { user_id?: string }).user_id ?? "";
        const room = rooms.get(roomId);
        if (!room) {
          return json(404, { errcode: "M_NOT_FOUND", error: "Unknown room" });
        }
        if (!users.has(userId)) {
          return json(404, { errcode: "M_NOT_FOUND", error: "User not found" });
        }
        if (!room.members.has(adminUserId)) {
          return json(403, { errcode: "M_FORBIDDEN", error: "the server admin must be in the room" });
        }
        if (room.joinRule === "invite") {
          // The admin API invites first, as the admin; Synapse refuses to invite someone who is already in.
          if (!fake.mayInvite(roomId, adminUserId)) {
            return json(403, { errcode: "M_FORBIDDEN", error: "not enough power to invite" });
          }
          if (room.members.has(userId)) {
            return json(403, { errcode: "M_FORBIDDEN", error: `${userId} is already in the room.` });
          }
        }
        if (options.orgWall) {
          const joinerOrg = roomOrg(userId);
          const clash = [...room.members].some((member) => member !== adminUserId && roomOrg(member) !== joinerOrg);
          if (joinerOrg === null || clash) {
            return json(403, { errcode: "M_FORBIDDEN", error: "org wall" });
          }
        }
        room.members.add(userId);
        return json(200, { room_id: roomId });
      }
      return json(404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
    },
  };
  return fake;
}
