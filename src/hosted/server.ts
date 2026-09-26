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
import { createServer, type ServeDeps, type WorkspaceSessionAccess } from "../serve/server.js";
import type { WorkspaceService } from "../workspace/service.js";
import { WorkspaceConfigError } from "../workspace/settings.js";
import type { WorkspaceTransportFactory } from "../workspace/transport.js";
import { createDeviceToken, verifyDeviceToken } from "../serve/tokens.js";
import { createEncryptedStore } from "../store/store.js";
import { DuoWorkspaceConnections, SDK_LOG_LEVELS, type SdkLogLevel } from "./duo-workspace.js";
import { googleIdentityVerifier, IdentityError, type IdentityVerifier, type VerifiedIdentity } from "./google.js";
import { MatrixProvisioner, type ProvisionOutcome } from "./matrix-accounts.js";
import { OrgSpaceProvisioner, type SpaceSummary } from "./org-spaces.js";
import { OrgNameError, OrgNameTakenError, OrgNotFoundError, ROOT_DUO_ID } from "./orgs.js";
import { HostedRegistry, InviteInvalidError, matrixAccountsView, type HostedTenant } from "./registry.js";
import { assertSynapseBaseUrl, SynapseAdmin, SynapseConfigError } from "./synapse-admin.js";
import { WorkspaceSessions } from "./workspace-session.js";

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

/**
 * How the daemon reaches Synapse to create accounts (docs/deploy/hosted-workspace.md §5). Absent
 * means no workspace provisioning: hosted mode behaves as it did before #232.
 */
export interface SynapseSettings {
  /** `DUO_WORKSPACE_PRIVATE_URL`: the private-network URL the daemon calls, e.g. `http://synapse.railway.internal:8008`. https, or http on `*.railway.internal`. Not `DUO_WORKSPACE_HOMESERVER`, which stays the personal-hardware trio's variable. */
  readonly adminUrl: string;
  /** `DUO_WORKSPACE_ADMIN_TOKEN`: the service account's token. Never given to a duo, a route or a log. */
  readonly adminToken: string;
  /** `DUO_WORKSPACE_SERVER_NAME`: Synapse's `server_name` (`duo`). When unset it is read from the admin token's own user id. */
  readonly serverName: string | undefined;
  /** `DUO_WORKSPACE_PUBLIC_URL`: the https address clients are given (#233); not used to call Synapse. */
  readonly publicUrl: string | undefined;
}

/**
 * How the hosted duos' own workspace connections are started (#236). Every field is optional and
 * defaults as `duo-workspace.ts` says; `hostedSettingsFrom` fills them from the environment.
 */
export interface WorkspaceConnectionSettings {
  /** `DUO_HOSTED_WORKSPACE_CONNECT`: false stops hosted duos from opening any workspace connection (accounts are still provisioned). Default true. */
  readonly enabled?: boolean;
  /** `DUO_HOSTED_WORKSPACE_MAX_DIALS`: how many duos may be in their first dial at once. */
  readonly maxConcurrentDials?: number;
  /** `DUO_HOSTED_WORKSPACE_STAGGER_MS`: the least time between two duos starting to dial. */
  readonly startStaggerMs?: number;
  /** `DUO_HOSTED_WORKSPACE_SDK_LOG`: how much of matrix-js-sdk's own logging is let through (default `silent`). */
  readonly sdkLogLevel?: SdkLogLevel;
}

export interface HostedSettings {
  readonly hostedRoot: string;
  readonly masterKey: string;
  readonly adminToken: string;
  /** The daemon's public origin and the web app's, for building invite links. Both optional: without them an invite returns its code only. */
  readonly publicUrl: string | undefined;
  readonly webUrl: string | undefined;
  /** Google OAuth web client id. When set, sign-up and login require a Google sign-in; when unset, sign-up takes a typed name (local/dev). */
  readonly googleClientId: string | undefined;
  /**
   * Lowercased emails of the super admins: they create and rename orgs, invite people into any org, and the first of them to sign in claims the root duo.
   * From `hostedSettingsFrom` this is read from the env on every access, so editing `DUO_HOSTED_ADMIN_EMAILS` takes effect on the next request.
   */
  readonly adminEmails: readonly string[];
  /** Set when the Synapse admin variables are; without it no Matrix accounts are provisioned. */
  readonly synapse?: SynapseSettings;
  /** Only used when `synapse` is set: each provisioned duo then also connects to the workspace. */
  readonly workspaceConnections?: WorkspaceConnectionSettings;
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
    synapse: synapseSettingsFrom(env),
    workspaceConnections: workspaceConnectionSettingsFrom(env),
    hostedRoot: env.DUO_HOSTED_ROOT || "hosted",
    masterKey,
    adminToken,
    publicUrl: env.DUO_HOSTED_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    webUrl: env.DUO_HOSTED_WEB_URL?.replace(/\/+$/, "") || undefined,
    googleClientId: env.DUO_HOSTED_GOOGLE_CLIENT_ID || undefined,
    // A getter, not a snapshot: the list is re-read from `env` (process.env in
    // the daemon) whenever it is used, so removing an email withdraws admin
    // without a restart. Only where the running process's env can be edited
    // (a shell, an orchestrator that sets it live); a platform that changes
    // env vars by redeploying still needs the redeploy.
    get adminEmails() {
      return parseAdminEmails(env.DUO_HOSTED_ADMIN_EMAILS);
    },
  };
}

/**
 * The Synapse admin variables are all-or-nothing, like the workspace ones: a URL with no token (or
 * the reverse) is a half-finished setup, and provisioning would quietly not happen. Neither set
 * means no provisioning.
 */
export function synapseSettingsFrom(env: NodeJS.ProcessEnv): SynapseSettings | undefined {
  const adminUrl = env.DUO_WORKSPACE_PRIVATE_URL || undefined;
  const adminToken = env.DUO_WORKSPACE_ADMIN_TOKEN || undefined;
  if (adminUrl === undefined && adminToken === undefined) {
    return undefined;
  }
  if (adminUrl === undefined || adminToken === undefined) {
    throw new HostedConfigError(adminUrl === undefined ? "DUO_WORKSPACE_PRIVATE_URL (it is needed with DUO_WORKSPACE_ADMIN_TOKEN)" : "DUO_WORKSPACE_ADMIN_TOKEN (it is needed with DUO_WORKSPACE_PRIVATE_URL)");
  }
  try {
    assertSynapseBaseUrl(adminUrl);
  } catch (error) {
    if (error instanceof SynapseConfigError) {
      throw new HostedConfigError(`DUO_WORKSPACE_PRIVATE_URL (${error.message})`);
    }
    throw error;
  }
  return {
    adminUrl,
    adminToken,
    serverName: env.DUO_WORKSPACE_SERVER_NAME || undefined,
    publicUrl: env.DUO_WORKSPACE_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
  };
}

/** A whole number of at least `min`, or a refusal naming the variable: a value that would hot-loop or stall the duos' connections is not a setting. */
function envInteger(env: NodeJS.ProcessEnv, key: string, min: number): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new WorkspaceConfigError(`${key} must be a whole number of at least ${min} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function sdkLogLevelFrom(raw: string | undefined): SdkLogLevel | undefined {
  const level = raw?.trim().toLowerCase();
  if (level === undefined || level === "") {
    return undefined;
  }
  if (!(SDK_LOG_LEVELS as readonly string[]).includes(level)) {
    throw new WorkspaceConfigError(`DUO_HOSTED_WORKSPACE_SDK_LOG must be one of ${SDK_LOG_LEVELS.join(", ")} (got ${JSON.stringify(raw)})`);
  }
  return level as SdkLogLevel;
}

export function workspaceConnectionSettingsFrom(env: NodeJS.ProcessEnv): WorkspaceConnectionSettings {
  const connect = env.DUO_HOSTED_WORKSPACE_CONNECT?.trim().toLowerCase();
  return {
    enabled: !(connect === "0" || connect === "false" || connect === "off" || connect === "no"),
    maxConcurrentDials: envInteger(env, "DUO_HOSTED_WORKSPACE_MAX_DIALS", 1),
    startStaggerMs: envInteger(env, "DUO_HOSTED_WORKSPACE_STAGGER_MS", 0),
    sdkLogLevel: sdkLogLevelFrom(env.DUO_HOSTED_WORKSPACE_SDK_LOG),
  };
}

function parseAdminEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
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

/**
 * The only process-env variables a hosted tenant's duo may see. The process env holds the
 * master key, the admin tokens and (with #232) the Synapse admin token, which acts as any
 * user; a duo's `deps.env` is reachable from per-duo routes, so it is built from this list
 * and not spread from the whole env. What a duo's routes actually read is CORS and the
 * websocket re-verify interval; the per-duo paths and identity are set explicitly below.
 */
export const TENANT_ENV_ALLOWLIST = ["DUO_CORS_ORIGINS", "DUO_WS_REVERIFY_MS", "TZ"] as const;

/** The variables that must never reach any duo, tenant or root. */
export const HOSTED_SECRET_ENV = ["DUO_HOSTED_MASTER_KEY", "DUO_HOSTED_ADMIN_TOKEN", "DUO_WORKSPACE_ADMIN_TOKEN"] as const;

/** A tenant duo's base env: the allowlisted variables of `env`, and nothing else. */
export function tenantEnvFrom(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const key of TENANT_ENV_ALLOWLIST) {
    if (env[key] !== undefined) {
      picked[key] = env[key];
    }
  }
  return picked;
}

/**
 * The pre-hosted root duo keeps the whole process env (its shared-duo paths and provider settings
 * come from it, as they did before hosted mode), minus the hosted secrets.
 */
export function rootEnvFrom(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of HOSTED_SECRET_ENV) {
    delete copy[key];
  }
  return copy;
}

/**
 * The duo's workspace service is created later than the duo's app (when its accounts exist), and
 * the app reads `deps.workspace` on each request, so the field is a live view of whatever service
 * the duo has now, and undefined until it has one.
 */
function withLiveWorkspace(deps: ServeDeps, current: () => WorkspaceService | undefined): ServeDeps {
  return Object.defineProperty({ ...deps }, "workspace", { get: current, enumerable: true, configurable: true }) as ServeDeps;
}

export function tenantDeps(
  shared: SharedDuoRuntime,
  settings: HostedSettings,
  tenant: HostedTenant,
  passphrase: string,
  workspaceSession?: WorkspaceSessionAccess,
  workspace?: () => WorkspaceService | undefined,
): ServeDeps {
  const paths = tenantPaths(settings.hostedRoot, tenant.id);
  const deps: ServeDeps = {
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
      ...tenantEnvFrom(shared.env),
      DUO_STORE_PATH: paths.storePath,
      DUO_DIR: paths.duoDir,
      DUO_PASSPHRASE: passphrase,
      DUO_OWNER_NAME: tenant.name,
      DUO_LIFECYCLE_LOG_PATH: paths.lifecycleLogPath,
      DUO_SHARED_PERSONA_PATH: paths.sharedPersonaPath,
      DUO_SHARED_USAGE_LOG_PATH: paths.sharedUsageLogPath,
    },
    trustProxy: shared.trustProxy,
    ...(workspaceSession ? { workspaceSession } : {}),
  };
  return workspace ? withLiveWorkspace(deps, workspace) : deps;
}

/** A provisioning outcome as an admin may see it: ids and status, never a token. */
function publicOutcome(outcome: ProvisionOutcome) {
  return { duoId: outcome.duoId, status: outcome.status, ...(outcome.accounts ? { accounts: outcome.accounts } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
}

/** The org-space sweep as an admin may see it: counts and per-item status, no secret exists in it to leave out. */
function publicSpaces(summary: SpaceSummary) {
  return {
    orgs: summary.orgs,
    members: summary.members,
    orgOutcomes: summary.orgOutcomes,
    memberOutcomes: summary.memberOutcomes,
  };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ error: { code, message } });
}

/** Answers an org error as its HTTP status; false means it is not an org error and the caller rethrows. */
function sendOrgError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof OrgNotFoundError) {
    sendError(reply, 404, "org_not_found", error.message);
  } else if (error instanceof OrgNameTakenError) {
    sendError(reply, 409, "org_name_taken", error.message);
  } else if (error instanceof OrgNameError) {
    sendError(reply, 400, "bad_request", error.message);
  } else {
    return false;
  }
  return true;
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

/** Test seams for `createHostedServer`; production passes none. */
export interface HostedServerExtras {
  /** The `fetch` used for Synapse admin calls. */
  readonly synapseFetch?: typeof fetch;
  /** One line per provisioning event (default: stderr). Carries duo ids and scrubbed reasons only. */
  readonly log?: (line: string) => void;
  /** How long a sign-up waits for provisioning before answering anyway (default 5s). */
  readonly signupProvisionWaitMs?: number;
  /** Per-call timeout for Synapse admin requests (default 10s). Also the workspace-session mint's, which defaults to a shorter 5s so a hung Synapse does not hold a client's request. */
  readonly synapseTimeoutMs?: number;
  /** How a duo's workspace transport is built (default: the matrix-js-sdk adapter). Tests hand in a fake. */
  readonly workspaceTransportFactory?: WorkspaceTransportFactory;
  /** The clock the workspace-session cache judges token age and expiry by (default: real time). */
  readonly sessionNow?: () => number;
  /** How often owed provisioning is retried (default 60s). */
  readonly provisionRetryMs?: number;
}

const DEFAULT_SIGNUP_PROVISION_WAIT_MS = 5_000;
const DEFAULT_PROVISION_RETRY_MS = 60_000;
const DEFAULT_SESSION_TIMEOUT_MS = 5_000;
/** `POST|DELETE /workspace/session` at the bare origin (the root duo) or under `/t/<id>` (a tenant duo). */
const WORKSPACE_SESSION_PATH = /^(?:\/t\/[a-z0-9]+)?\/workspace\/session(?:\?.*)?$/;

export interface HostedServer {
  /** The front: dispatches `/hosted/*` to the control app, `/t/<id>/*` to that duo, anything else to the root duo when there is one. */
  readonly server: Server;
  readonly registry: HostedRegistry;
  /** Set when the Synapse admin variables are configured. */
  readonly matrix: MatrixProvisioner | undefined;
  /** Each org's Space and `#general`, and members' joins into them (#234). Set with `matrix`. */
  readonly spaces: OrgSpaceProvisioner | undefined;
  /** Each provisioned duo's own workspace connection (#236). Set with `matrix`, unless `DUO_HOSTED_WORKSPACE_CONNECT` turns it off. */
  readonly workspace: DuoWorkspaceConnections | undefined;
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
  identityVerifier: IdentityVerifier | undefined = settings.googleClientId ? googleIdentityVerifier(settings.googleClientId) : undefined,
  extras: HostedServerExtras = {},
): Promise<HostedServer> {
  const registry = new HostedRegistry(join(settings.hostedRoot, "registry.json"), settings.masterKey);
  // A person's own Matrix session for the signed-in app (#233). Needs the public URL clients are given;
  // without it the per-duo route answers as if workspace sign-in were not set up. Each duo gets a handle
  // bound to its own id, so the route never takes an account from the request.
  const sessions =
    settings.synapse?.publicUrl
      ? new WorkspaceSessions({
          registry,
          admin: new SynapseAdmin({
            baseUrl: settings.synapse.adminUrl,
            adminToken: settings.synapse.adminToken,
            fetch: extras.synapseFetch,
            timeoutMs: extras.synapseTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
          }),
          publicUrl: settings.synapse.publicUrl,
          log: extras.log,
          now: extras.sessionNow,
        })
      : undefined;
  const sessionAccess = (duoId: string): WorkspaceSessionAccess | undefined =>
    sessions && {
      session: () => sessions.sessionFor(duoId),
      renew: () => sessions.renew(duoId),
      end: () => void sessions.end(duoId),
    };
  // Each provisioned duo's own outbound workspace connection (#236), started from the registry's word
  // that the duo has accounts and following it (a re-minted token restarts it). It only queues here: the
  // dialing happens off a timer, so a Synapse that is down or slow never holds up boot or a sign-up.
  const connections =
    settings.synapse && settings.workspaceConnections?.enabled !== false
      ? new DuoWorkspaceConnections({
          registry,
          config: shared.config,
          homeserverUrl: settings.synapse.adminUrl,
          transportFactory: extras.workspaceTransportFactory,
          maxConcurrentDials: settings.workspaceConnections?.maxConcurrentDials,
          startStaggerMs: settings.workspaceConnections?.startStaggerMs,
          sdkLogLevel: settings.workspaceConnections?.sdkLogLevel,
          log: extras.log,
        })
      : undefined;
  const stopFollowingRegistry = connections ? registry.onChange(() => connections.reconcile()) : undefined;
  const liveWorkspace = (duoId: string) => connections && (() => connections.serviceFor(duoId));
  const mountTenant = async (tenant: HostedTenant, passphrase: string): Promise<MountedDuo> => {
    const deps = tenantDeps(shared, settings, tenant, passphrase, sessionAccess(tenant.id), liveWorkspace(tenant.id));
    const mounted = await mountDuo(deps);
    connections?.attach(tenant.id, deps);
    return mounted;
  };
  const duos = new Map<string, MountedDuo>();
  for (const tenant of registry.tenants()) {
    duos.set(tenant.id, await mountTenant(tenant, registry.passphraseFor(tenant)));
  }
  const rootAccess = sessionAccess(ROOT_DUO_ID);
  const rootLive = liveWorkspace(ROOT_DUO_ID);
  const rootServed = root && { ...root, ...(rootAccess ? { workspaceSession: rootAccess } : {}) };
  const rootDuo = rootServed ? await mountDuo(rootLive ? withLiveWorkspace(rootServed, rootLive) : rootServed) : undefined;
  if (root) {
    registry.declareRootDuo(root.ownerName);
    connections?.attach(ROOT_DUO_ID, root);
  }

  // Matrix accounts (#232). Only when the Synapse admin variables are set. A Synapse that is down
  // never stops a duo from being served or a person from joining: the duo is marked pending and
  // the timer below retries it.
  const synapseAdmin = settings.synapse
    ? new SynapseAdmin({ baseUrl: settings.synapse.adminUrl, adminToken: settings.synapse.adminToken, fetch: extras.synapseFetch, timeoutMs: extras.synapseTimeoutMs })
    : undefined;
  const matrix = synapseAdmin
    ? new MatrixProvisioner({
        registry,
        admin: synapseAdmin,
        serverName: settings.synapse?.serverName,
        log: extras.log,
        retryBaseMs: extras.provisionRetryMs ?? DEFAULT_PROVISION_RETRY_MS,
      })
    : undefined;
  // Each org's Space and `#general` (#234), and members' joins into them. Same rules as the accounts:
  // a Synapse that is down marks the org or member pending and never blocks creating an org or redeeming an invite.
  const spaces = synapseAdmin
    ? new OrgSpaceProvisioner({
        registry,
        admin: synapseAdmin,
        serverName: settings.synapse?.serverName,
        log: extras.log,
        retryBaseMs: extras.provisionRetryMs ?? DEFAULT_PROVISION_RETRY_MS,
      })
    : undefined;
  const settleWithin = async (attempt: Promise<unknown>): Promise<void> => {
    await Promise.race([attempt, new Promise<void>((resolve) => setTimeout(resolve, extras.signupProvisionWaitMs ?? DEFAULT_SIGNUP_PROVISION_WAIT_MS).unref())]);
  };
  // An unexpected failure is logged by name only (a message could quote something it should not), and never stops the server.
  const logUnexpected = (error: unknown): void => {
    (extras.log ?? ((line) => console.error(line)))(`hosted: Matrix provisioning failed unexpectedly (${error instanceof Error ? error.name : "error"})`);
  };
  // One sweep at a time: a tick that finds the last sweep still running (a slow Synapse) skips itself
  // instead of piling a second sweep onto it. The provisioner's own backoff spaces out each failed duo.
  let sweeping = false;
  const runSweep = (sweep: () => Promise<unknown>): void => {
    if (!matrix || sweeping) {
      return;
    }
    sweeping = true;
    sweep()
      .catch(logUnexpected)
      .finally(() => {
        sweeping = false;
      });
  };
  // Accounts first: a member can be joined to their org's Space only once their accounts exist.
  const runProvisioning = (): void =>
    runSweep(async () => {
      await matrix!.provisionAll();
      await spaces!.syncAll();
    });
  let retryTimer: NodeJS.Timeout | undefined;
  if (matrix) {
    runProvisioning();
    retryTimer = setInterval(() => {
      if (matrix.hasRetryDue() || spaces!.hasRetryDue()) {
        runSweep(async () => {
          await matrix.retryPending();
          await spaces!.retryPending();
        });
      }
    }, extras.provisionRetryMs ?? DEFAULT_PROVISION_RETRY_MS);
    retryTimer.unref();
  }

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

  const isAdminEmail = (email: string | undefined) => email !== undefined && settings.adminEmails.includes(email.toLowerCase());

  /**
   * Super admin is decided per request from `settings.adminEmails` (live from DUO_HOSTED_ADMIN_EMAILS when the settings come from
   * `hostedSettingsFrom`) against the duo's stored email, which every login refreshes from the verified identity.
   */
  const isSuperAdminTenant = (tenant: HostedTenant) => isAdminEmail(tenant.email);

  /** A device token paired to a super admin's duo — the root duo once an admin has claimed it, or any admin tenant. */
  const isAdminDevice = (token: string): boolean => {
    const claim = registry.root();
    if (root && claim && isAdminEmail(claim.email) && verifyDeviceToken(root.storePath, root.passphrase, token)) {
      return true;
    }
    return registry
      .tenants()
      .filter(isSuperAdminTenant)
      .some((tenant) => verifyDeviceToken(tenantPaths(settings.hostedRoot, tenant.id).storePath, registry.passphraseFor(tenant), token) !== undefined);
  };

  // The super admin: the server-side admin token (for `duo hosted ...` on the
  // box) or a super admin's own signed-in device (the app's admin pages). No
  // credential is a 401; a credential that is not a super admin's is a 403,
  // so a member of an org learns "not allowed" rather than "log in".
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) {
      sendError(reply, 401, "unauthorized", "Only an admin can do this.");
    } else if (!(constantTimeEquals(token, settings.adminToken) || isAdminDevice(token))) {
      sendError(reply, 403, "forbidden", "Only an admin can do this.");
    }
  };

  /** Verifies a sign-in credential, answering the failure itself; undefined means the reply is already sent. */
  const identify = async (credential: unknown, request: FastifyRequest, reply: FastifyReply): Promise<VerifiedIdentity | undefined> => {
    if (!identityVerifier) {
      sendError(reply, 400, "sign_in_not_configured", "Sign-in isn't set up on this server.");
      return undefined;
    }
    if (typeof credential !== "string" || credential.length === 0) {
      sendError(reply, 400, "bad_request", "credential (the Google sign-in token) is required");
      return undefined;
    }
    try {
      return await identityVerifier.verify(credential);
    } catch (error) {
      if (error instanceof IdentityError) {
        recordSignupFailure(request.ip);
        sendError(reply, 401, "sign_in_failed", error.message);
        return undefined;
      }
      throw error;
    }
  };

  const mintDevice = (storePath: string, passphrase: string) =>
    createDeviceToken(storePath, passphrase, `Signed in with Google, ${new Date().toISOString().slice(0, 10)}`);

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

  // Public: what the web app needs to render its sign-in page.
  control.get("/hosted/config", async () => ({ googleClientId: settings.googleClientId ?? null }));

  control.post<{ Body: { credential?: unknown } }>("/hosted/login", async (request, reply) => {
    if (signupBlocked(request.ip)) {
      sendError(reply, 429, "rate_limited", "Too many failed sign-ins from this address; try again later.");
      return;
    }
    const identity = await identify(request.body?.credential, request, reply);
    if (!identity) {
      return;
    }
    // The stored email is what admin-ness is judged on, so it follows the
    // verified identity rather than staying as it was at sign-up.
    registry.refreshRootEmail(identity.subject, identity.email);
    const found = registry.tenantBySubject(identity.subject);
    const tenant = found && registry.refreshTenantEmail(found.id, identity.email);
    if (tenant) {
      const device = mintDevice(tenantPaths(settings.hostedRoot, tenant.id).storePath, registry.passphraseFor(tenant));
      return { tenantId: tenant.id, basePath: `/t/${tenant.id}`, token: device.token, ownerName: tenant.name, isAdmin: isSuperAdminTenant(tenant), orgId: tenant.orgId };
    }
    // The root duo belongs to whichever admin signs in first; after that,
    // only that same Google account opens it.
    const claim = registry.root();
    if (root && isAdminEmail(identity.email) && (!claim || claim.identitySubject === identity.subject)) {
      if (!claim) {
        registry.claimRoot(identity.subject, identity.email);
      }
      const device = mintDevice(root.storePath, root.passphrase);
      return { tenantId: null, basePath: "", token: device.token, ownerName: root.ownerName, isAdmin: true, orgId: registry.orgOf(ROOT_DUO_ID)?.id ?? null };
    }
    sendError(reply, 404, "no_duo", "There's no duo for this Google account yet. Ask for an invite link.");
  });

  control.post<{ Body: { invite?: unknown; name?: unknown; credential?: unknown } }>("/hosted/signup", async (request, reply) => {
    if (signupBlocked(request.ip)) {
      sendError(reply, 429, "rate_limited", "Too many failed sign-ups from this address; try again later.");
      return;
    }
    const invite = request.body?.invite;
    if (typeof invite !== "string" || invite.length === 0) {
      sendError(reply, 400, "bad_request", "invite is required");
      return;
    }
    // With sign-in configured, a duo is always bound to a Google account —
    // that is what lets its owner log back in anywhere. Without it (local
    // development), sign-up takes a typed name as before.
    let identity: VerifiedIdentity | undefined;
    if (identityVerifier) {
      identity = await identify(request.body?.credential, request, reply);
      if (!identity) {
        return;
      }
      if (registry.tenantBySubject(identity.subject) || registry.root()?.identitySubject === identity.subject) {
        sendError(reply, 409, "already_has_duo", "This Google account already has a duo. Sign in instead.");
        return;
      }
    }
    const rawName = request.body?.name;
    const typedName = typeof rawName === "string" ? rawName.trim() : "";
    const name = (typedName || identity?.name || identity?.email || "").slice(0, MAX_NAME_LENGTH);
    if (name.length === 0) {
      sendError(reply, 400, "bad_request", `name is required (at most ${MAX_NAME_LENGTH} characters)`);
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
    if (redeemable.email && redeemable.email !== identity?.email) {
      recordSignupFailure(request.ip);
      sendError(reply, 403, "invite_wrong_account", `This invite is for ${redeemable.email}. Sign in with that Google account.`);
      return;
    }
    const tenantId = registry.newTenantId();
    const paths = tenantPaths(settings.hostedRoot, tenantId);
    const passphrase = randomBytes(32).toString("base64url");
    createEncryptedStore(paths.storePath, passphrase);
    mkdirSync(paths.duoDir, { recursive: true });
    const device = createDeviceToken(paths.storePath, passphrase, `${name}'s first device`);
    const tenant = registry.addTenant(
      redeemable.id,
      name,
      passphrase,
      tenantId,
      identity ? { identitySubject: identity.subject, email: identity.email, isAdmin: isAdminEmail(identity.email) } : {},
    );
    duos.set(tenant.id, await mountTenant(tenant, passphrase));
    if (matrix) {
      // Redeeming an invite must not depend on Synapse: wait a moment so the app can usually connect
      // straight away, then answer regardless. A failed or slow run leaves the duo pending for the retry.
      // The accounts come first, then the person and their duo are put into the org's Space (#234).
      const attempt = matrix
        .provision(tenant.id)
        .then(() => spaces!.syncMember(tenant.id))
        .catch(logUnexpected);
      await settleWithin(attempt);
    }
    reply.code(201);
    return { tenantId: tenant.id, basePath: `/t/${tenant.id}`, token: device.token, ownerName: tenant.name, isAdmin: isSuperAdminTenant(tenant), orgId: tenant.orgId };
  });

  control.post<{ Body: { name?: unknown; email?: unknown; expiresInHours?: unknown; orgId?: unknown } }>(
    "/hosted/invites",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
      const hours = request.body?.expiresInHours ?? DEFAULT_INVITE_HOURS;
      if (name.length === 0 || typeof hours !== "number" || !Number.isInteger(hours) || hours <= 0 || hours > 24 * 365) {
        sendError(reply, 400, "bad_request", "name is required; expiresInHours must be a whole number from 1 to 8760");
        return;
      }
      const rawEmail = request.body?.email;
      if (rawEmail !== undefined && rawEmail !== null && (typeof rawEmail !== "string" || !rawEmail.includes("@"))) {
        sendError(reply, 400, "bad_request", "email, when given, must be an email address");
        return;
      }
      const email = typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null;
      const rawOrgId = request.body?.orgId;
      if (rawOrgId !== undefined && rawOrgId !== null && (typeof rawOrgId !== "string" || rawOrgId.length === 0)) {
        sendError(reply, 400, "bad_request", "orgId, when given, must be an org id");
        return;
      }
      let created;
      try {
        // No org named means the default org, so an invite made the old way still works.
        created = registry.createInvite(name, new Date(Date.now() + hours * 3_600_000).toISOString(), email, typeof rawOrgId === "string" ? rawOrgId : undefined);
      } catch (error) {
        if (sendOrgError(reply, error)) {
          return;
        }
        throw error;
      }
      const { invite, code } = created;
      const link =
        settings.webUrl && settings.publicUrl
          ? `${settings.webUrl}/#join?host=${encodeURIComponent(settings.publicUrl)}&invite=${encodeURIComponent(code)}`
          : null;
      reply.code(201);
      return { id: invite.id, name: invite.name, email: invite.email ?? null, orgId: invite.orgId, expiresAt: invite.expiresAt, code, link };
    },
  );

  control.get("/hosted/invites", { preHandler: requireAdmin }, async () =>
    registry.invites().map(({ codeHash: _codeHash, ...rest }) => rest),
  );

  // Org administration — super admin only (requireAdmin: 401 with no
  // credential, 403 for anyone who is not a super admin). POST for rename
  // because the CORS policy allows only GET and POST.
  control.get("/hosted/orgs", { preHandler: requireAdmin }, async () => registry.listOrgs());

  control.post<{ Body: { name?: unknown } }>("/hosted/orgs", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const created = registry.createOrg(request.body?.name as string);
      // The org exists whatever Synapse does; its Space is made now if Synapse answers in time, else by the retry.
      if (spaces) {
        await settleWithin(spaces.ensureOrg(created.id).catch(logUnexpected));
      }
      reply.code(201);
      return { ...(registry.org(created.id) ?? created), memberCount: 0 };
    } catch (error) {
      if (sendOrgError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  control.post<{ Params: { orgId: string }; Body: { name?: unknown } }>("/hosted/orgs/:orgId/rename", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const renamed = registry.renameOrg(request.params.orgId, request.body?.name as string);
      if (spaces) {
        await settleWithin(spaces.ensureOrg(renamed.id).catch(logUnexpected));
      }
      return { ...(registry.org(renamed.id) ?? renamed), memberCount: registry.listOrgMembers(renamed.id).length };
    } catch (error) {
      if (sendOrgError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  control.get<{ Params: { orgId: string } }>("/hosted/orgs/:orgId/members", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      return registry.listOrgMembers(request.params.orgId).map((member) => ({ ...member, isAdmin: isAdminEmail(member.email ?? undefined) }));
    } catch (error) {
      if (sendOrgError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  // Never the passphrase cipher and never the Matrix token cipher: a duo's accounts are shown as ids and a date.
  // `workspace` is the duo's own workspace connection: its phase and failed attempts, from the daemon's memory.
  control.get("/hosted/duos", { preHandler: requireAdmin }, async () => {
    const connection = new Map(connections?.states().map((state) => [state.duoId, state]));
    return registry.tenants().map(({ passphraseCipher: _cipher, matrix: accounts, ...rest }) => {
      const state = connection.get(rest.id);
      return {
        ...rest,
        ...(accounts ? { matrix: matrixAccountsView(accounts) } : {}),
        ...(state ? { workspace: { phase: state.phase, attempts: state.attempts } } : {}),
      };
    });
  });

  // Backfill on demand (`duo hosted provision`): creates the accounts every duo still lacks and answers
  // with counts and per-duo status, never a token. Startup already does this when Synapse is configured.
  control.post("/hosted/matrix/provision", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!matrix) {
      sendError(reply, 400, "matrix_not_configured", "Set DUO_WORKSPACE_PRIVATE_URL and DUO_WORKSPACE_ADMIN_TOKEN to provision Matrix accounts.");
      return;
    }
    const summary = await matrix.provisionAll();
    const spaceSummary = await spaces!.syncAll();
    return { ...summary, outcomes: summary.outcomes.map(publicOutcome), spaces: publicSpaces(spaceSummary) };
  });

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
    // The server-side admin token belongs to no duo, so the duo's own auth would call it an unknown device
    // (401). The workspace-session route tells it apart (403 no_duo, as the admin token is not a bad
    // credential, just not a person's) before dispatching. Constant-time, no store is read.
    if (request.method !== "OPTIONS" && WORKSPACE_SESSION_PATH.test(request.url ?? "")) {
      const header = request.headers.authorization;
      if (header?.startsWith("Bearer ") && constantTimeEquals(header.slice("Bearer ".length), settings.adminToken)) {
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "no_duo", message: "The admin token belongs to no duo and has no workspace account. Sign in as a person." } }));
        return;
      }
    }
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
    matrix,
    spaces,
    workspace: connections,
    close: async () => {
      if (retryTimer) {
        clearInterval(retryTimer);
      }
      // Stop the sweep from starting its next duo, then wait for the one in flight.
      matrix?.stop();
      spaces?.stop();
      await matrix?.whenIdle();
      await spaces?.whenIdle();
      // Then the duos' own connections: nothing may start one after this, and each is stopped on its own.
      stopFollowingRegistry?.();
      await connections?.stop();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await Promise.all([control.close(), rootDuo?.app.close(), ...Array.from(duos.values(), (duo) => duo.app.close())]);
    },
  };
}
