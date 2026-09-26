import { duoUserIdFor } from "../workspace/directory.js";
import { assertOrgId, ROOT_DUO_ID } from "./orgs.js";
import { matrixAccountsView, type HostedMatrixAccountsView, type HostedRegistry } from "./registry.js";
import { SynapseAdminError, type SynapseAdmin } from "./synapse-admin.js";

/**
 * Matrix accounts for hosted duos (docs/deploy/hosted-workspace.md §3-§5).
 *
 * Every duo gets two accounts on the shared Synapse, both created by the
 * daemon through the admin API and neither with a password:
 *
 * - the person, `@<orgId>.<handle>:<server>`;
 * - their duo, `@duo-<orgId>.<handle>:<server>` (exactly `duoUserIdFor` of the
 *   person, so the directory needs no mapping table).
 *
 * `<handle>` is the tenant id, or the literal `root` for the pre-hosted root
 * duo. The org is written into the id so Synapse's module can read it by
 * string parse (§4); the registry stays the source of truth for who is in
 * which org, and `reconcileMatrixAccounts` checks the two have not drifted.
 */

/** The daemon's own service account: no org (no dot), never `duo-`-prefixed, the only Synapse admin. */
export const SERVICE_ACCOUNT_LOCALPART = "workspace-admin";

/** A tenant id, or `root`: what may follow the first dot. */
const HANDLE_PATTERN = /^[a-z0-9]+$/;
/** A Matrix server_name: a hostname, optionally with a port. Permanent once accounts exist. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;

export function assertServerName(serverName: string): string {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`Matrix server name ${JSON.stringify(serverName)} is not a hostname (optionally with a port).`);
  }
  return serverName;
}

/** `@<orgId>.<handle>:<server>`. Throws on an id that could break the first-dot split. */
export function personUserIdFor(orgId: string, handle: string, serverName: string): string {
  assertOrgId(orgId);
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(`Matrix handle ${JSON.stringify(handle)} must be lowercase letters and digits only.`);
  }
  return `@${orgId}.${handle}:${assertServerName(serverName)}`;
}

/** The duo id for a person id, asserting the derivation succeeded (`duoUserIdFor` returns null for an id that is not `@local:server`). */
export function duoUserIdOrThrow(personUserId: string): string {
  const duoUserId = duoUserIdFor(personUserId);
  if (duoUserId === null) {
    throw new Error(`Cannot derive a duo account from ${JSON.stringify(personUserId)}: it is not @localpart:server shaped.`);
  }
  return duoUserId;
}

/**
 * The org an account belongs to, read from its id the way Synapse's module
 * does (§4.2): drop `duo-`, take what precedes the first dot. Null for an
 * id with no org marker (only the service account may have none).
 */
export function orgIdOfUserId(userId: string): string | null {
  const local = /^@([^:]+):/.exec(userId)?.[1];
  if (local === undefined) {
    return null;
  }
  const stripped = local.startsWith("duo-") ? local.slice("duo-".length) : local;
  const dot = stripped.indexOf(".");
  return dot === -1 ? null : stripped.slice(0, dot);
}

export type ProvisionStatus =
  /** Accounts were created (or found) and the duo's token was stored just now. */
  | "provisioned"
  /** Already provisioned earlier; nothing was called. */
  | "already"
  /** Synapse could not do it right now; the duo is marked pending and will be retried. */
  | "pending"
  /**
   * Something the daemon cannot fix by asking Synapse again: recorded accounts that do not fit the
   * duo's org or the configured server (nothing is written, nothing is retried), or an unexpected
   * error (logged by name; the duo is still retried, with backoff, if it has no accounts).
   * Needs an operator.
   */
  | "failed";

export interface ProvisionOutcome {
  readonly duoId: string;
  readonly status: ProvisionStatus;
  /** Present for `provisioned` and `already`. Never a token. */
  readonly accounts?: HostedMatrixAccountsView;
  /** Present for `pending` and `failed`: the scrubbed reason. */
  readonly error?: string;
}

export interface ProvisionSummary {
  readonly provisioned: number;
  readonly already: number;
  readonly pending: number;
  readonly failed: number;
  readonly outcomes: readonly ProvisionOutcome[];
}

export interface MatrixProvisionerOptions {
  readonly registry: HostedRegistry;
  readonly admin: Pick<SynapseAdmin, "putUser" | "mintToken" | "whoAmI">;
  /** Synapse's `server_name`, when configured. Otherwise it is read once from the admin token's own user id. */
  readonly serverName?: string;
  /** One line per event. Carries duo ids and scrubbed reasons only; defaults to stderr. */
  readonly log?: (line: string) => void;
  /** `retryPending` waits this long after a duo's first failed attempt, doubling per further failure. Default one minute. */
  readonly retryBaseMs?: number;
  /** ... and never longer than this between attempts. Default thirty minutes. */
  readonly retryMaxMs?: number;
}

const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 30 * 60_000;

/** The duo's display name on Matrix; the human name is the person's. */
function duoDisplayName(ownerName: string): string {
  return `${ownerName}'s duo`;
}

/**
 * Creates each hosted duo's Matrix accounts and stores the duo's token.
 *
 * - **Idempotent.** A duo whose accounts are recorded is left alone with no
 *   call at all; the two account calls are `PUT`s that are safe to replay; a
 *   run that dies half way is finished by the next.
 * - **Never throws for a Synapse problem.** An outage, a wrong admin token or
 *   a refused request leaves the duo marked pending (visible, counted,
 *   retried) and returns `pending`, so it cannot block a sign-up. Only a
 *   bug (an id the naming rules reject, a duo the registry does not know)
 *   throws from `provision`; the sweeps (`provisionAll`, `retryPending`)
 *   catch it per duo and report it as `failed`, so one bad duo costs one outcome.
 * - **One run per duo at a time.** A sign-up, the startup backfill and an
 *   admin's `provision` can overlap; they share one attempt, so a duo is
 *   never given two tokens.
 * - **The token goes from Synapse to the registry's encrypted field and
 *   nowhere else**: not logged, not in an outcome, not in an error.
 */
export class MatrixProvisioner {
  private readonly inflight = new Map<string, Promise<ProvisionOutcome>>();
  private serverNameCache: string | undefined;
  private readonly log: (line: string) => void;
  private stopped = false;

  constructor(private readonly options: MatrixProvisionerOptions) {
    this.serverNameCache = options.serverName === undefined ? undefined : assertServerName(options.serverName);
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** Every duo the registry knows, the root duo included once it has been served. */
  private duoIds(): string[] {
    return this.options.registry.orgs().flatMap((org) => this.options.registry.listOrgMembers(org.id).map((member) => member.duoId));
  }

  /** Duos whose accounts are still owed. */
  pendingDuoIds(): string[] {
    return this.duoIds().filter((duoId) => !this.options.registry.matrixAccounts(duoId));
  }

  provision(duoId: string): Promise<ProvisionOutcome> {
    const running = this.inflight.get(duoId);
    if (running) {
      return running;
    }
    const attempt = this.run(duoId).finally(() => this.inflight.delete(duoId));
    this.inflight.set(duoId, attempt);
    return attempt;
  }

  /** Provisions every duo that lacks accounts; the backfill. Duos that already have them cost nothing. */
  provisionAll(): Promise<ProvisionSummary> {
    return this.sweep(this.duoIds());
  }

  /**
   * The timer's sweep: only duos still owed accounts whose backoff has passed. A duo that failed
   * n times waits base x 2^(n-1) after its last attempt (capped), so a Synapse that is down or
   * hanging costs a duo one attempt, one registry write and one log line per backoff, not per tick.
   * The backoff is read from the registry's own pending record, so it survives a restart.
   */
  retryPending(now: number = Date.now()): Promise<ProvisionSummary> {
    return this.sweep(this.dueDuoIds(now));
  }

  /** Whether any duo is owed accounts and due a retry now; lets a timer skip a tick without starting a sweep. */
  hasRetryDue(now: number = Date.now()): boolean {
    return this.dueDuoIds(now).length > 0;
  }

  private dueDuoIds(now: number): string[] {
    const base = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const max = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    return this.pendingDuoIds().filter((duoId) => {
      const pending = this.options.registry.matrixPending(duoId);
      return !pending || Date.parse(pending.lastAttemptAt) + Math.min(base * 2 ** Math.min(pending.attempts - 1, 30), max) <= now;
    });
  }

  /** After this, a running sweep finishes the duo it is on and starts no other. For shutdown; `provision` is unaffected. */
  stop(): void {
    this.stopped = true;
  }

  /** One duo at a time. One duo's unexpected error is that duo's outcome, never the sweep's. */
  private async sweep(duoIds: readonly string[]): Promise<ProvisionSummary> {
    const outcomes: ProvisionOutcome[] = [];
    for (const duoId of duoIds) {
      if (this.stopped) {
        break;
      }
      try {
        outcomes.push(await this.provision(duoId));
      } catch (error) {
        outcomes.push(this.unexpected(duoId, error));
      }
    }
    const count = (status: ProvisionStatus) => outcomes.filter((outcome) => outcome.status === status).length;
    return { provisioned: count("provisioned"), already: count("already"), pending: count("pending"), failed: count("failed"), outcomes };
  }

  /** Logs the error's name only (a message could quote something it should not), and best-effort marks the duo so it backs off. */
  private unexpected(duoId: string, error: unknown): ProvisionOutcome {
    const name = error instanceof Error ? error.name : "error";
    this.log(`hosted: Matrix provisioning failed unexpectedly for duo ${duoId} (${name})`);
    const reason = `unexpected error (${name}); see the daemon log`;
    try {
      this.options.registry.recordMatrixFailure(duoId, reason);
    } catch {
      // The registry may be what failed, or the duo may not exist; the outcome and the log still say so.
    }
    return { duoId, status: "failed", error: reason };
  }

  /** Resolves when nothing is running; for tests and orderly shutdown. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  private async serverName(): Promise<string> {
    if (this.serverNameCache === undefined) {
      const adminUserId = await this.options.admin.whoAmI();
      const name = /^@[^:]+:(.+)$/.exec(adminUserId)?.[1];
      if (!name) {
        throw new SynapseAdminError("Synapse whoami returned an id with no server name", 200, null, false);
      }
      this.serverNameCache = assertServerName(name);
    }
    return this.serverNameCache;
  }

  private async run(duoId: string): Promise<ProvisionOutcome> {
    const { registry, admin } = this.options;
    const org = registry.orgOf(duoId);
    const member = org && registry.listOrgMembers(org.id).find((candidate) => candidate.duoId === duoId);
    if (!org || !member) {
      throw new Error(`No hosted duo "${duoId}" to provision Matrix accounts for.`);
    }

    const existing = registry.matrixAccounts(duoId);
    if (existing) {
      // Recorded accounts must still be this org's and this server's; a mismatch is reported, never silently re-provisioned.
      const problem = accountProblem(duoId, org.id, existing, this.serverNameCache);
      if (problem) {
        // Not `fail`: a pending mark on a duo that has accounts is never cleared and never retried
        // (`pendingDuoIds` skips it), so it would only add a registry write per sweep and a false "will be retried".
        this.log(`hosted: ${problem}; it needs an operator, nothing was changed`);
        return { duoId, status: "failed", error: problem };
      }
      return { duoId, status: "already", accounts: matrixAccountsView(existing) };
    }

    try {
      const serverName = await this.serverName();
      const personUserId = personUserIdFor(org.id, duoId === ROOT_DUO_ID ? "root" : duoId, serverName);
      const duoUserId = duoUserIdOrThrow(personUserId);
      await admin.putUser(personUserId, { displayName: member.name });
      await admin.putUser(duoUserId, { displayName: duoDisplayName(member.name) });
      // The duo's token never expires (§5): the daemon holds it for good and the registry keeps it encrypted.
      const token = await admin.mintToken(duoUserId, { neverExpires: true });
      const accounts = this.storeToken(duoId, personUserId, duoUserId, token);
      this.log(`hosted: provisioned Matrix accounts for duo ${duoId}`);
      return { duoId, status: "provisioned", accounts };
    } catch (error) {
      if (error instanceof SynapseAdminError) {
        return this.fail(duoId, error.message);
      }
      throw error;
    }
  }

  /**
   * The mint and this write are two steps, and Synapse cannot be asked for the token again: a
   * process that dies between them, or a write that keeps failing, leaves a token that never
   * expires on the duo's account and that nothing recorded (docs/deploy/hosted-mode.md). One
   * immediate retry covers a transient write error and cannot double-mint (the token is already
   * in hand); a second failure is logged, without the token, and rethrown.
   */
  private storeToken(duoId: string, personUserId: string, duoUserId: string, token: string): HostedMatrixAccountsView {
    const { registry } = this.options;
    try {
      try {
        return registry.setMatrixAccounts(duoId, { personUserId, duoUserId }, token);
      } catch {
        return registry.setMatrixAccounts(duoId, { personUserId, duoUserId }, token);
      }
    } catch (error) {
      this.log(`hosted: minted a Matrix token for duo ${duoId} but could not store it (${error instanceof Error ? error.name : "error"}); an unrecorded token now exists on ${duoUserId}`);
      throw error;
    }
  }

  private fail(duoId: string, reason: string): ProvisionOutcome {
    this.options.registry.recordMatrixFailure(duoId, reason);
    this.log(`hosted: Matrix provisioning for duo ${duoId} is pending: ${reason}`);
    return { duoId, status: "pending", error: reason };
  }
}

/** Why recorded accounts do not fit the duo's org (or the configured server), or null when they do. */
function accountProblem(duoId: string, orgId: string, accounts: HostedMatrixAccountsView, serverName: string | undefined): string | null {
  const handle = duoId === ROOT_DUO_ID ? "root" : duoId;
  const person = /^@([^:]+):(.+)$/.exec(accounts.personUserId);
  const duo = /^@([^:]+):(.+)$/.exec(accounts.duoUserId);
  if (!person || !duo || person[1] !== `${orgId}.${handle}` || duo[1] !== `duo-${orgId}.${handle}` || person[2] !== duo[2]) {
    return `the recorded Matrix accounts for duo ${duoId} do not match its org (${orgId})`;
  }
  if (serverName !== undefined && person[2] !== serverName) {
    return `the recorded Matrix accounts for duo ${duoId} are on a different server than the one configured`;
  }
  return null;
}

/**
 * The reconcile check the record asks for (§3): does every provisioned id
 * still start with its duo's org? Read-only; returns one line per problem
 * (empty means consistent), naming no token.
 */
export function reconcileMatrixAccounts(registry: HostedRegistry): string[] {
  const problems: string[] = [];
  for (const org of registry.orgs()) {
    for (const member of registry.listOrgMembers(org.id)) {
      const accounts = registry.matrixAccounts(member.duoId);
      const problem = accounts && accountProblem(member.duoId, org.id, accounts, undefined);
      if (problem) {
        problems.push(problem);
      }
    }
  }
  return problems;
}
