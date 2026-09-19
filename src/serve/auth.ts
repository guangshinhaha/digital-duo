import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { touchLastSeen, verifyDeviceToken } from "./tokens.js";

/** How often (ms) a given device's `last_seen_at` is allowed to trigger a write — see `verifyDeviceToken`'s doc comment on why an unthrottled write-per-request would be expensive. */
const LAST_SEEN_THROTTLE_MS = 60_000;

/** Auth-failure rate limiting: `client-tech-design.md` Part 2 — "the realistic attacker is a process already on the tailnet, and that attacker gets to retry." Per-IP, in-memory, reset on a rolling window; a single-process daemon on a private network needs nothing heavier. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 10;

interface FailureWindow {
  count: number;
  windowStart: number;
}

/**
 * Registers the bearer-token auth hook. Every route added after this call
 * requires `Authorization: Bearer <token>`, verified against the store's
 * `device_tokens` table — the actual authentication layer, since a tailnet
 * only authenticates the *device* onto the network, not a *client* to this
 * daemon (`client-tech-design.md` Part 2).
 */
export function registerAuth(app: FastifyInstance, storePath: string, passphrase: string): void {
  const failures = new Map<string, FailureWindow>();
  const lastTouch = new Map<string, number>();

  function recordFailure(ip: string): boolean {
    const now = Date.now();
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
    if (existingWindow && Date.now() - existingWindow.windowStart <= RATE_LIMIT_WINDOW_MS && existingWindow.count > RATE_LIMIT_MAX_FAILURES) {
      request.log.warn({ ip }, "rate-limited: too many auth failures");
      reply.code(429).send({ error: { code: "rate_limited", message: "Too many failed authentication attempts. Try again later." } });
      return;
    }

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      recordFailure(ip);
      reply.code(401).send({ error: { code: "unauthorized", message: "Missing bearer token." } });
      return;
    }

    const device = verifyDeviceToken(storePath, passphrase, token);
    if (!device) {
      const limited = recordFailure(ip);
      request.log.warn({ ip, limited }, "auth failed: unknown or revoked device token");
      reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or revoked device token." } });
      return;
    }

    const now = Date.now();
    const last = lastTouch.get(device.id) ?? 0;
    if (now - last > LAST_SEEN_THROTTLE_MS) {
      lastTouch.set(device.id, now);
      touchLastSeen(storePath, passphrase, device.id);
    }
  });
}
