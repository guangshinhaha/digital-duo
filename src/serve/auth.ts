import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { touchLastSeen, verifyAskToken, verifyDeviceToken } from "./tokens.js";

/** How often (ms) a given device's `last_seen_at` is allowed to trigger a write — see `verifyDeviceToken`'s doc comment on why an unthrottled write-per-request would be expensive. */
const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * How long a successfully verified token is trusted without re-checking
 * against the store. `verifyDeviceToken` runs a full store decrypt (scrypt
 * key derivation plus AES-GCM over the whole file) — expensive enough that
 * doing it on every single request would make a polling client (exactly
 * `client-tech-design.md`'s use case) pay that cost repeatedly, often
 * several times within one UI page load that fires a handful of GETs at
 * once. Short enough that a revoked device stops working within one
 * ordinary polling interval, not an open-ended one.
 */
const TOKEN_CACHE_TTL_MS = 5_000;

/** Auth-failure rate limiting: `client-tech-design.md` Part 2 — "the realistic attacker is a process already on the tailnet, and that attacker gets to retry." Per-IP, in-memory, reset on a rolling window; a single-process daemon on a private network needs nothing heavier. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 10;

/** Shared by the hook's missing-token 401 and the /ask route's defensive fallback for a request the hook somehow passed through unauthenticated (#159) — one literal so the two can never drift. */
export const MISSING_TOKEN_MESSAGE = "Missing bearer token.";

/** Issue #159: who is making this request — an ask-link holder (ask-only powers) or a paired device (the owner's superset). Every route decides authorization against `principal.kind`; `/ask` is the only route that accepts both kinds. */
type PrincipalKind = "ask" | "device";

export interface Principal {
  readonly kind: PrincipalKind;
  readonly name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Attached by the auth hook on every authenticated request (#159); absent only on the exempt `/health` route. */
    principal?: Principal;
  }
}

interface FailureWindow {
  count: number;
  windowStart: number;
}

interface CachedVerification {
  deviceId: string;
  /** Cached alongside the id so a cache-hit request can attach a full principal without re-decrypting the store. */
  name: string;
  verifiedAt: number;
}

function unauthorized(reply: FastifyReply, message: string): void {
  reply.code(401).send({ error: { code: "unauthorized", message } });
}

function rateLimited(reply: FastifyReply): void {
  reply.code(429).send({ error: { code: "rate_limited", message: "Too many failed authentication attempts. Try again later." } });
}

/**
 * Registers the bearer-token auth hook. Every route added after this call
 * requires `Authorization: Bearer <token>`, verified against the store's
 * `device_tokens` table — the actual authentication layer, since a tailnet
 * only authenticates the *device* onto the network, not a *client* to this
 * daemon (`client-tech-design.md` Part 2).
 *
 * `POST /ask` (#159) is the one exception in *kind*, not in mechanism: the
 * same hook also verifies ask tokens there (device tokens still pass — the
 * owner is a superset of an asker) and attaches the principal the route
 * projects its response by. On every other route an ask token is refused
 * exactly as an unknown device token is — structurally, since its hash is
 * not in `device_tokens`.
 */
export function registerAuth(app: FastifyInstance, storePath: string, passphrase: string): void {
  const failures = new Map<string, FailureWindow>();
  const lastTouch = new Map<string, number>();
  // Bounded by paired-device count (a handful, per client-tech-design.md's
  // own scale — a Mac and a phone or two), unlike `failures` below, which
  // is keyed by IP and needs active pruning (see pruneExpiredFailures).
  const verifiedTokens = new Map<string, CachedVerification>();

  /** Removes failure windows outside RATE_LIMIT_WINDOW_MS — called on every recordFailure so `failures` never grows past "IPs that failed within the last window," however many distinct IPs have ever hit this daemon over its uptime. */
  function pruneExpiredFailures(now: number): void {
    for (const [ip, window] of failures) {
      if (now - window.windowStart > RATE_LIMIT_WINDOW_MS) {
        failures.delete(ip);
      }
    }
  }

  /** Records a failure and returns whether *this* request should be the one that gets rate-limited (i.e. it was the failure that reached the cap) — see the doc comment on the call site for why the caller must act on this return value rather than only logging it. */
  function recordFailure(ip: string): boolean {
    const now = Date.now();
    pruneExpiredFailures(now);
    const window = failures.get(ip);
    if (!window || now - window.windowStart > RATE_LIMIT_WINDOW_MS) {
      failures.set(ip, { count: 1, windowStart: now });
      return false;
    }
    window.count += 1;
    return window.count > RATE_LIMIT_MAX_FAILURES;
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/health") {
      return;
    }
    const ip = request.ip;
    const existingWindow = failures.get(ip);
    // A cheap precheck so a client already over the cap doesn't pay for a
    // token check (cached or not) at all — `>=`, not `>`: once count has
    // reached the cap, every further request from this IP is blocked,
    // matching recordFailure's own "the failure that reaches the cap gets
    // blocked" semantics below rather than allowing one extra through.
    if (existingWindow && Date.now() - existingWindow.windowStart <= RATE_LIMIT_WINDOW_MS && existingWindow.count >= RATE_LIMIT_MAX_FAILURES) {
      request.log.warn({ ip }, "rate-limited: too many auth failures");
      rateLimited(reply);
      return;
    }

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      const limited = recordFailure(ip);
      // The request that pushes the count over the cap is blocked itself,
      // not merely the next one — the earlier version returned 401 here
      // unconditionally and only logged `limited`, which let exactly one
      // extra failure through before the cap actually took effect.
      if (limited) {
        rateLimited(reply);
      } else {
        unauthorized(reply, MISSING_TOKEN_MESSAGE);
      }
      return;
    }

    const now = Date.now();
    // Fastify 5 resolves routing before onRequest hooks, so the matched
    // route's own URL is available here; a request that matched no route
    // has none, so fall back to the path portion of request.url — parsed,
    // never a raw exact-compare, because a query string would break it.
    const routeUrl = request.routeOptions?.url ?? request.url.split("?")[0];
    const isAskRoute = routeUrl === "/ask";

    const cached = verifiedTokens.get(token);
    let verified: { deviceId: string; name: string } | undefined =
      cached !== undefined && now - cached.verifiedAt <= TOKEN_CACHE_TTL_MS
        ? { deviceId: cached.deviceId, name: cached.name }
        : undefined;

    // #159, KTD3: device-cache check (free, above) → ask verify (uncached,
    // the dominant /ask caller) → device verify. Ask tokens are never cached
    // and never touchLastSeen — they carry no last_seen by #158's design,
    // and a success cache would serve a revoked or expired link for up to
    // TOKEN_CACHE_TTL_MS (R3). Exactly one recordFailure runs per request,
    // only after both kinds miss — the single failure path below serves
    // both routes, differing only in its two message strings.
    if (isAskRoute && verified === undefined) {
      const ask = verifyAskToken(storePath, passphrase, token);
      if (ask) {
        request.principal = { kind: "ask", name: ask.name };
        return;
      }
    }

    if (verified === undefined) {
      const device = verifyDeviceToken(storePath, passphrase, token);
      if (!device) {
        verifiedTokens.delete(token);
        const limited = recordFailure(ip);
        request.log.warn(
          { ip, limited },
          isAskRoute
            ? "auth failed: unknown, expired, or revoked ask or device token"
            : "auth failed: unknown or revoked device token",
        );
        if (limited) {
          rateLimited(reply);
        } else if (isAskRoute) {
          // Kind-blind by construction: unknown, expired, and revoked
          // tokens of both kinds get this same body — no oracle (R1).
          unauthorized(reply, "Invalid, expired, or revoked token.");
        } else {
          unauthorized(reply, "Invalid or revoked device token.");
        }
        return;
      }
      verified = { deviceId: device.id, name: device.name };
      verifiedTokens.set(token, { deviceId: verified.deviceId, name: verified.name, verifiedAt: now });
    }
    request.principal = { kind: "device", name: verified.name };

    const last = lastTouch.get(verified.deviceId) ?? 0;
    if (now - last > LAST_SEEN_THROTTLE_MS) {
      lastTouch.set(verified.deviceId, now);
      touchLastSeen(storePath, passphrase, verified.deviceId);
    }
  });
}
