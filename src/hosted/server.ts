import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import type { DuoConfig } from "../config.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { CORS_ALLOWED_HEADERS, resolveCorsOrigins } from "../serve/cors.js";
import { createServer, type ServeDeps } from "../serve/server.js";
import { createDeviceToken } from "../serve/tokens.js";
import { createEncryptedStore } from "../store/store.js";
import { HostedRegistry, InviteInvalidError, type HostedTenant } from "./registry.js";

/** Where a hosted duo lives: everything under one directory per duo, nothing shared between them. */
export function tenantPaths(hostedRoot: string, tenantId: string) {
  const root = join(hostedRoot, "users", tenantId);
  return {
    root,
    storePath: join(root, "data", "duo.db"),
    duoDir: join(root, "duo"),
    lifecycleLogPath: join(root, "duo-lifecycle-runtime", "events.json"),
    sharedPersonaPath: join(root, "shared-duo", "persona.json"),
    sharedUsageLogPath: join(root, "shared-duo-runtime", "usage.json"),
  };
}

export interface HostedSettings {
  readonly hostedRoot: string;
  readonly masterKey: string;
  readonly adminToken: string;
  /** The daemon's public origin and the web app's, for building invite links. Both optional: without them an invite returns its code only. */
  readonly publicUrl: string | undefined;
  readonly webUrl: string | undefined;
}

export class HostedConfigError extends Error {
  constructor(key: string) {
    super(`Hosted mode needs ${key} set (a long random secret). Refusing to start without it.`);
    this.name = "HostedConfigError";
  }
}

export function hostedSettingsFrom(env: NodeJS.ProcessEnv): HostedSettings {
  const masterKey = env.DUO_HOSTED_MASTER_KEY;
  const adminToken = env.DUO_HOSTED_ADMIN_TOKEN;
  if (!masterKey || masterKey.length < 16) {
    throw new HostedConfigError("DUO_HOSTED_MASTER_KEY");
  }
  if (!adminToken || adminToken.length < 16) {
    throw new HostedConfigError("DUO_HOSTED_ADMIN_TOKEN");
  }
  return {
    hostedRoot: env.DUO_HOSTED_ROOT || "hosted",
    masterKey,
    adminToken,
    publicUrl: env.DUO_HOSTED_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    webUrl: env.DUO_HOSTED_WEB_URL?.replace(/\/+$/, "") || undefined,
  };
}

/** What every hosted duo shares: the providers and the confidence knobs. Everything owner-specific comes from the tenant. */
export interface SharedDuoRuntime {
  readonly config: DuoConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly embeddingProvider: EmbeddingProvider;
  readonly inferenceProvider: InferenceProvider | undefined;
  readonly trustProxy: boolean;
}

/** One duo's isolated app, reachable only by emitting requests/upgrades into its never-listening server. */
interface MountedDuo {
  readonly app: FastifyInstance;
  readonly server: Server;
}

async function mountDuo(deps: ServeDeps): Promise<MountedDuo> {
  let server: Server | undefined;
  const app = createServer(deps, {
    serverFactory: (handler) => {
      server = createHttpServer(handler);
      return server;
    },
  });
  await app.ready();
  if (!server) {
    throw new Error("hosted: the duo's server factory was never called");
  }
  return { app, server };
}

function tenantDeps(shared: SharedDuoRuntime, settings: HostedSettings, tenant: HostedTenant, passphrase: string): ServeDeps {
  const paths = tenantPaths(settings.hostedRoot, tenant.id);
  return {
    storePath: paths.storePath,
    passphrase,
    duoDir: paths.duoDir,
    lifecycleLogPath: paths.lifecycleLogPath,
    embeddingProvider: shared.embeddingProvider,
    inferenceProvider: shared.inferenceProvider,
    confidenceConfig: shared.config.confidence,
    classificationCeiling: shared.config.classificationCeiling,
    ownerName: tenant.name,
    // Every env-derived path a route reads points inside this duo's own
    // directory, so no route can reach another duo's files through env.
    env: {
      ...shared.env,
      DUO_STORE_PATH: paths.storePath,
      DUO_DIR: paths.duoDir,
      DUO_PASSPHRASE: passphrase,
      DUO_OWNER_NAME: tenant.name,
      DUO_LIFECYCLE_LOG_PATH: paths.lifecycleLogPath,
      DUO_SHARED_PERSONA_PATH: paths.sharedPersonaPath,
      DUO_SHARED_USAGE_LOG_PATH: paths.sharedUsageLogPath,
    },
    trustProxy: shared.trustProxy,
  };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ error: { code, message } });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const SIGNUP_FAILURE_WINDOW_MS = 15 * 60_000;
const SIGNUP_MAX_FAILURES = 10;
const DEFAULT_INVITE_HOURS = 7 * 24;
const MAX_NAME_LENGTH = 80;

export interface HostedServer {
  /** The front: dispatches `/hosted/*` to the control app, `/t/<id>/*` to that duo, anything else to the root duo when there is one. */
  readonly server: Server;
  readonly registry: HostedRegistry;
  close(): Promise<void>;
}

/**
 * Hosted mode (docs/deploy/hosted-mode.md): one process, many duos, each an
 * unchanged `createServer` app over its own encrypted store. The front
 * strips `/t/<id>` and hands the request to that duo's app, so each duo sees
 * exactly the routes, auth, rate limiting and WebSocket it would see alone.
 *
 * `root` is an optional legacy single-owner duo (the pre-hosted deployment)
 * kept at the bare origin so its existing pairings and ask links keep
 * working unchanged.
 */
export async function createHostedServer(
  shared: SharedDuoRuntime,
  settings: HostedSettings,
  root: ServeDeps | undefined,
): Promise<HostedServer> {
  const registry = new HostedRegistry(join(settings.hostedRoot, "registry.json"), settings.masterKey);
  const duos = new Map<string, MountedDuo>();
  for (const tenant of registry.tenants()) {
    duos.set(tenant.id, await mountDuo(tenantDeps(shared, settings, tenant, registry.passphraseFor(tenant))));
  }
  const rootDuo = root ? await mountDuo(root) : undefined;

  let controlServer: Server | undefined;
  const control = Fastify({
    logger: false,
    trustProxy: shared.trustProxy,
    serverFactory: (handler) => {
      controlServer = createHttpServer(handler);
      return controlServer;
    },
  });
  control.register(cors, {
    origin: resolveCorsOrigins(shared.env),
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    methods: ["GET", "POST", "OPTIONS"],
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token || !constantTimeEquals(token, settings.adminToken)) {
      sendError(reply, 401, "unauthorized", "Admin token required.");
    }
  };

  const signupFailures = new Map<string, { windowStart: number; count: number }>();
  const signupBlocked = (ip: string) => {
    const window = signupFailures.get(ip);
    return window !== undefined && Date.now() - window.windowStart <= SIGNUP_FAILURE_WINDOW_MS && window.count >= SIGNUP_MAX_FAILURES;
  };
  const recordSignupFailure = (ip: string) => {
    const window = signupFailures.get(ip);
    if (!window || Date.now() - window.windowStart > SIGNUP_FAILURE_WINDOW_MS) {
      signupFailures.set(ip, { windowStart: Date.now(), count: 1 });
    } else {
      window.count += 1;
    }
  };

  control.get("/hosted/health", async () => ({ ok: true, duos: duos.size }));

  control.post<{ Body: { invite?: unknown; name?: unknown } }>("/hosted/signup", async (request, reply) => {
    if (signupBlocked(request.ip)) {
      sendError(reply, 429, "rate_limited", "Too many failed sign-ups from this address; try again later.");
      return;
    }
    const invite = request.body?.invite;
    const rawName = request.body?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (typeof invite !== "string" || invite.length === 0 || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      sendError(reply, 400, "bad_request", `invite and name are required; name is at most ${MAX_NAME_LENGTH} characters`);
      return;
    }
    let redeemable;
    try {
      redeemable = registry.findRedeemableInvite(invite);
    } catch (error) {
      if (error instanceof InviteInvalidError) {
        recordSignupFailure(request.ip);
        sendError(reply, 403, "invite_invalid", error.message);
        return;
      }
      throw error;
    }
    const tenantId = registry.newTenantId();
    const paths = tenantPaths(settings.hostedRoot, tenantId);
    const passphrase = randomBytes(32).toString("base64url");
    createEncryptedStore(paths.storePath, passphrase);
    mkdirSync(paths.duoDir, { recursive: true });
    const device = createDeviceToken(paths.storePath, passphrase, `${name}'s first device`);
    const tenant = registry.addTenant(redeemable.id, name, passphrase, tenantId);
    duos.set(tenant.id, await mountDuo(tenantDeps(shared, settings, tenant, passphrase)));
    reply.code(201);
    return { tenantId: tenant.id, basePath: `/t/${tenant.id}`, token: device.token, ownerName: tenant.name };
  });

  control.post<{ Body: { name?: unknown; expiresInHours?: unknown } }>(
    "/hosted/invites",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
      const hours = request.body?.expiresInHours ?? DEFAULT_INVITE_HOURS;
      if (name.length === 0 || typeof hours !== "number" || !Number.isInteger(hours) || hours <= 0 || hours > 24 * 365) {
        sendError(reply, 400, "bad_request", "name is required; expiresInHours must be a whole number from 1 to 8760");
        return;
      }
      const { invite, code } = registry.createInvite(name, new Date(Date.now() + hours * 3_600_000).toISOString());
      const link =
        settings.webUrl && settings.publicUrl
          ? `${settings.webUrl}/#join?host=${encodeURIComponent(settings.publicUrl)}&invite=${encodeURIComponent(code)}`
          : null;
      reply.code(201);
      return { id: invite.id, name: invite.name, expiresAt: invite.expiresAt, code, link };
    },
  );

  control.get("/hosted/invites", { preHandler: requireAdmin }, async () =>
    registry.invites().map(({ codeHash: _codeHash, ...rest }) => rest),
  );

  control.get("/hosted/duos", { preHandler: requireAdmin }, async () =>
    registry.tenants().map(({ passphraseCipher: _cipher, ...rest }) => rest),
  );

  await control.ready();
  if (!controlServer) {
    throw new Error("hosted: the control server factory was never called");
  }
  const controlTarget = controlServer;

  /** Picks the server a request belongs to and rewrites its URL into that server's own path space. */
  const route = (request: IncomingMessage): Server | undefined => {
    const url = request.url ?? "/";
    if (url === "/hosted" || url.startsWith("/hosted/") || url.startsWith("/hosted?")) {
      return controlTarget;
    }
    const match = /^\/t\/([a-z0-9]+)(\/[^?]*)?(\?.*)?$/.exec(url);
    if (match) {
      const duo = duos.get(match[1]);
      if (!duo) {
        return undefined;
      }
      request.url = `${match[2] ?? "/"}${match[3] ?? ""}`;
      return duo.server;
    }
    return rootDuo?.server;
  };

  const front = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const target = route(request);
    if (!target) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not_found", message: "No duo here." } }));
      return;
    }
    target.emit("request", request, response);
  });
  front.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = route(request);
    if (!target || target === controlTarget) {
      socket.destroy();
      return;
    }
    target.emit("upgrade", request, socket, head);
  });

  return {
    server: front,
    registry,
    close: async () => {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await Promise.all([control.close(), rootDuo?.app.close(), ...Array.from(duos.values(), (duo) => duo.app.close())]);
    },
  };
}
