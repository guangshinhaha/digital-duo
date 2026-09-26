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
 * - every call needs the admin token as a bearer, else 401 `M_UNKNOWN_TOKEN`.
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
}

export function createFakeSynapse(options: { adminToken?: string; serverName?: string } = {}): FakeSynapse {
  const adminToken = options.adminToken ?? FAKE_ADMIN_TOKEN;
  const serverName = options.serverName ?? FAKE_SERVER_NAME;
  const users = new Map<string, FakeUser>();
  const minted: FakeSynapse["minted"] = [];
  const requests: FakeRequest[] = [];
  let failures: { count: number; status: number; errcode: string } | null = null;
  let hang = false;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fake: FakeSynapse = {
    users,
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
      return json(404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
    },
  };
  return fake;
}
