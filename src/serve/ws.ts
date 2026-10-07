import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { touchLastSeen, verifyDeviceToken } from "./tokens.js";

/**
 * `GET /ws` — the one push channel: `draft-ready` and, since
 * guangshinhaha/duo#285, `draft-drafting` (`client-tech-design.md` Part
 * 1.1 called it "one channel: draft-ready"; #285 adds a second message
 * shape to that same one channel rather than opening a second socket).
 * Everything else is request/response, because nothing else in this
 * product is time-critical.
 *
 * Auth is by **first message**, never a query parameter: the browser
 * `WebSocket` API cannot set an `Authorization` header, and a `?token=` would
 * land the device token in access logs. The token verifies against the same
 * `device_tokens` hash store the bearer middleware uses — an ask token
 * (#158's separate table) is refused here exactly as it is there.
 */

/** The application close code for every auth failure: the client reconnects with backoff on any close. */
const AUTH_CLOSE = 4001;

/** How often live sockets' tokens are re-verified, so a revocation done by `duo pair revoke` in another process closes this daemon's sockets — the same documented staleness window the HTTP token cache accepts (auth.ts TOKEN_CACHE_TTL_MS). Overridable for tests/ops via `DUO_WS_REVERIFY_MS`. */
const DEFAULT_REVERIFY_MS = 5_000;

/** What a connected, authenticated socket is allowed to push about. */
export interface DraftReadyHub {
  /** Announces a draft id now pending owner action. Sends to every live authenticated socket; a socket that has gone away is skipped, never thrown on. */
  publish(draftId: string): void;
  /**
   * guangshinhaha/duo#285: "your duo is drafting" — announces that a draft
   * is now being composed for this room, before it exists as a draft row
   * at all. Every live socket here is already authenticated as one of the
   * owner's own devices (the same auth `publish` relies on), which is the
   * whole of "shows only to the owner" (#285 AC3): nobody else ever opens
   * this socket. There is no matching "stopped drafting" push — the
   * client clears its own indicator once room activity or its own timeout
   * says the wait is over, the same one-shot shape `draft-ready` already
   * has (it never un-publishes a draft either).
   */
  publishDrafting(roomId: string): void;
  /**
   * Closes every live socket authenticated as one device (#177). Same close
   * code and reason the re-verify pass uses for an out-of-process `duo pair
   * revoke`, but same-tick: an in-process revocation (POST
   * /devices/:id/revoke) already knows the verdict, so it doesn't wait out
   * the re-verify window to act on it.
   */
  closeDevice(deviceId: string): void;
}

interface LiveSocket {
  readonly deviceId: string;
  readonly token: string;
}

function reverifyIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.DUO_WS_REVERIFY_MS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_REVERIFY_MS;
}

/**
 * Registers `/ws` and returns the hub `POST /drafts` publishes through.
 * Called by `createServer` before routes, so the draft-completion push is
 * same-tick with the pipeline that wrote the row.
 */
export function registerDraftReadySocket(
  app: FastifyInstance,
  deps: { readonly storePath: string; readonly passphrase: string; readonly env: NodeJS.ProcessEnv },
): DraftReadyHub {
  const live = new Map<WebSocket, LiveSocket>();
  let reverify: NodeJS.Timeout | undefined;

  /** One shared timer while any socket is live (re-verification is per distinct token, not per socket), unref'd so it can never hold the process open. */
  function ensureReverify(): void {
    if (!reverify) {
      reverify = setInterval(reverifyTokens, reverifyIntervalMs(deps.env));
      reverify.unref();
    }
  }

  function maybeStopReverify(): void {
    if (live.size === 0 && reverify) {
      clearInterval(reverify);
      reverify = undefined;
    }
  }

  function reverifyTokens(): void {
    for (const token of new Set([...live.values()].map((entry) => entry.token))) {
      if (!verifyDeviceToken(deps.storePath, deps.passphrase, token)) {
        for (const [socket, entry] of live) {
          if (entry.token === token) {
            socket.close(AUTH_CLOSE, "device token revoked");
          }
        }
      }
    }
  }

  app.register(websocketPlugin);

  // The route must live in a child context created *after* the plugin:
  // @fastify/websocket wraps websocket routes through an onRoute hook, and a
  // route added at the same root level as the register call escapes that
  // wrap — it then runs as a plain HTTP handler and the "socket" argument is
  // actually the request. Every example in its README registers this way.
  app.register(function wsRoute(fastify: FastifyInstance) {
    fastify.get("/ws", { websocket: true }, (socket: WebSocket) => {
      let authenticated: LiveSocket | undefined;

      socket.on("message", (data: unknown, isBinary: boolean) => {
        if (authenticated) {
          // After auth this channel is server-push only; there is no client
          // message to respond to, so there is nothing to do but not crash.
          return;
        }
        // Anything at all before a successful auth — wrong shape, wrong
        // token, not even JSON — closes with 4001 having sent nothing. No
        // pre-auth message gets any response, so there is nothing to probe.
        let message: { type?: unknown; token?: unknown };
        try {
          if (isBinary) {
            throw new Error("binary");
          }
          message = JSON.parse(String(data));
        } catch {
          socket.close(AUTH_CLOSE, "auth required");
          return;
        }
        if (message.type !== "auth" || typeof message.token !== "string") {
          socket.close(AUTH_CLOSE, "auth required");
          return;
        }
        const device = verifyDeviceToken(deps.storePath, deps.passphrase, message.token);
        if (!device) {
          socket.close(AUTH_CLOSE, "invalid device token");
          return;
        }
        touchLastSeen(deps.storePath, deps.passphrase, device.id);
        authenticated = { deviceId: device.id, token: message.token };
        live.set(socket, authenticated);
        ensureReverify();
        socket.send(JSON.stringify({ type: "ready" }));
      });

      socket.on("close", () => {
        if (authenticated) {
          live.delete(socket);
          maybeStopReverify();
        }
      });
    });
  });

  // Closing the server (tests, shutdown) tears the sockets down with it and
  // stops the re-verify timer, so an idle daemon holds no live interval.
  app.addHook("onClose", async () => {
    for (const socket of live.keys()) {
      socket.close(1001, "server shutting down");
    }
    live.clear();
    maybeStopReverify();
  });

  return {
    publish(draftId: string): void {
      const payload = JSON.stringify({ type: "draft-ready", draftId });
      for (const socket of live.keys()) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      }
    },
    publishDrafting(roomId: string): void {
      const payload = JSON.stringify({ type: "draft-drafting", roomId });
      for (const socket of live.keys()) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
        }
      }
    },
    closeDevice(deviceId: string): void {
      for (const [socket, entry] of live) {
        if (entry.deviceId === deviceId) {
          socket.close(AUTH_CLOSE, "device token revoked");
        }
      }
      // No live.delete here: socket.close fires the "close" handler above,
      // which is already the one place that removes a socket and stops the
      // timer — same teardown path every other close takes.
    },
  };
}
