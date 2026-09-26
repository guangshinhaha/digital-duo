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
  | "pending";

export interface ProvisionOutcome {
  readonly duoId: string;
  readonly status: ProvisionStatus;
  /** Present for `provisioned` and `already`. Never a token. */
  readonly accounts?: HostedMatrixAccountsView;
  /** Present for `pending`: the scrubbed reason. */
  readonly error?: string;
}

export interface ProvisionSummary {
  readonly provisioned: number;
  readonly already: number;
  readonly pending: number;
  readonly outcomes: readonly ProvisionOutcome[];
}

export interface MatrixProvisionerOptions {
  readonly registry: HostedRegistry;
  readonly admin: Pick<SynapseAdmin, "putUser" | "mintToken" | "whoAmI">;
  /** Synapse's `server_name`, when configured. Otherwise it is read once from the admin token's own user id. */
  readonly serverName?: string;
  /** One line per event. Carries duo ids and scrubbed reasons only; defaults to stderr. */
  readonly log?: (line: string) => void;
}

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
 *   throws.
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

  /** Provisions every duo that lacks accounts; the backfill, and the retry. Duos that already have them cost nothing. */
  async provisionAll(): Promise<ProvisionSummary> {
    const outcomes: ProvisionOutcome[] = [];
    for (const duoId of this.duoIds()) {
      outcomes.push(await this.provision(duoId));
    }
    return {
      provisioned: outcomes.filter((outcome) => outcome.status === "provisioned").length,
      already: outcomes.filter((outcome) => outcome.status === "already").length,
      pending: outcomes.filter((outcome) => outcome.status === "pending").length,
      outcomes,
    };
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
        return this.fail(duoId, problem);
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
      const accounts = registry.setMatrixAccounts(duoId, { personUserId, duoUserId }, token);
      this.log(`hosted: provisioned Matrix accounts for duo ${duoId}`);
      return { duoId, status: "provisioned", accounts };
    } catch (error) {
      if (error instanceof SynapseAdminError) {
        return this.fail(duoId, error.message);
      }
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
