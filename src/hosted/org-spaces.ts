import { OrgNotFoundError, type HostedOrg } from "./orgs.js";
import { orgIdOfUserId, SERVICE_ACCOUNT_LOCALPART } from "./matrix-accounts.js";
import type { HostedRegistry, MatrixPending } from "./registry.js";
import { SynapseAdminError, type SynapseAdmin } from "./synapse-admin.js";

/**
 * One Matrix Space per org, with a `#general` in it, and every member's two accounts inside both
 * (docs/deploy/hosted-workspace.md §6.1, §12; issue #234).
 *
 * Why it exists: with `user_directory.search_all_users: false`, sharing a room is what makes people
 * findable, so the org's Space is what makes an org's members findable to each other and to no one
 * else. It is a place and a directory scope, not a trust anchor: the wall is the Synapse module (#235).
 *
 * The rules this keeps:
 *
 * - **Never public.** Both rooms are created through `SynapseAdmin.createPrivateRoom`, which cannot
 *   make a public room. Members are put in by the admin join API, so no invite is ever sent to a person.
 * - **The service account stays in both rooms** (it created them and is never removed), because the
 *   admin join API needs an admin in the room with the right to invite.
 * - **Its joins go through the org module.** The admin-API join runs as the target user, so each one
 *   is checked like a user's own join. A member is joined only to their own org's rooms, and only
 *   when both their account ids carry that org (`orgIdOfUserId`): a mismatch is reported, not joined.
 * - **Idempotent and retry-safe, like the accounts flow.** Progress is written to the registry step
 *   by step, so a room that exists is never created twice by a re-run and a member who is recorded
 *   in costs no call. A member is recorded only after all four joins, and `SynapseAdmin.joinUser` skips
 *   an account already in the room (Synapse refuses a repeat join of an invite-only room), so a run
 *   that died part way is finished by the next one. Synapse trouble marks the org or member pending (visible, counted, retried
 *   with backoff) and never throws into org creation or invite redemption.
 * - **No tokens here.** Nothing in this module handles one; the admin client holds the only one.
 */

/** The name of each org's default room. Rooms are found by id in the registry, never by this name. */
export const GENERAL_ROOM_NAME = "general";

export type SpaceStatus =
  /** Something was created or joined just now. */
  | "provisioned"
  /** Nothing to do; no call was made. */
  | "already"
  /** Synapse could not do it right now; it is marked pending and will be retried. */
  | "pending"
  /** Needs an operator (an account that does not fit its org) or an unexpected error; the org or duo is still retried if it owes work. */
  | "failed"
  /** A member whose Matrix accounts are not provisioned yet, or who was asked for after `stop()`: nothing was done, and not an error. */
  | "waiting";

export interface OrgSpaceOutcome {
  readonly orgId: string;
  readonly status: SpaceStatus;
  readonly spaceRoomId?: string;
  readonly generalRoomId?: string;
  readonly error?: string;
}

export interface MemberSpaceOutcome {
  readonly duoId: string;
  readonly status: SpaceStatus;
  readonly error?: string;
}

export interface SpaceSummary {
  readonly orgs: { readonly provisioned: number; readonly already: number; readonly pending: number; readonly failed: number };
  readonly members: { readonly provisioned: number; readonly already: number; readonly pending: number; readonly failed: number; readonly waiting: number };
  readonly orgOutcomes: readonly OrgSpaceOutcome[];
  readonly memberOutcomes: readonly MemberSpaceOutcome[];
}

export interface OrgSpaceProvisionerOptions {
  readonly registry: HostedRegistry;
  readonly admin: Pick<SynapseAdmin, "createPrivateRoom" | "addSpaceChild" | "setRoomName" | "setFunctionalMembers" | "allowMemberSpaceLinks" | "joinUser" | "whoAmI">;
  /** Synapse's `server_name` (the `via` of the Space's child link). Otherwise read once from the admin token's user id. */
  readonly serverName?: string;
  /** One line per event: org and duo ids, room ids and scrubbed reasons only. Defaults to stderr. */
  readonly log?: (line: string) => void;
  /** As `MatrixProvisioner`: a first failure waits this long, doubling per further failure. Default one minute. */
  readonly retryBaseMs?: number;
  /** ... capped at this. Default thirty minutes. */
  readonly retryMaxMs?: number;
}

const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 30 * 60_000;
/** A rename that lands while a run is finishing is picked up by another pass; bound the passes so a flapping name cannot spin. */
const MAX_PASSES = 3;

/**
 * An org's rooms exist, are linked, carry its current name, hide the service account from a generated name or a
 * member list, and the Space lets members list a room open to the org in it (#274).
 */
export function orgSpaceComplete(org: HostedOrg): boolean {
  return (
    org.spaceRoomId !== undefined &&
    org.generalRoomId !== undefined &&
    org.generalLinked === true &&
    org.spaceSyncedName === org.name &&
    org.functionalMembersSet === true &&
    org.memberLinksAllowed === true
  );
}

export class OrgSpaceProvisioner {
  private readonly orgInflight = new Map<string, Promise<OrgSpaceOutcome>>();
  private readonly memberInflight = new Map<string, Promise<MemberSpaceOutcome>>();
  private serverNameCache: string | undefined;
  private readonly log: (line: string) => void;
  private stopped = false;

  constructor(private readonly options: OrgSpaceProvisionerOptions) {
    this.serverNameCache = options.serverName;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /**
   * Makes sure the org has its Space and `#general`, that `#general` is in the Space, and that the
   * Space carries the org's current name: creation and rename are the same call. One run per org at
   * a time; a second caller shares the first's attempt.
   */
  ensureOrg(orgId: string): Promise<OrgSpaceOutcome> {
    const running = this.orgInflight.get(orgId);
    if (running) {
      return running;
    }
    const attempt = this.runOrg(orgId).finally(() => this.orgInflight.delete(orgId));
    this.orgInflight.set(orgId, attempt);
    return attempt;
  }

  /**
   * Puts a member's person and duo accounts into their org's Space and `#general`, first making sure
   * those exist. `waiting` (not an error) when the member's accounts are not provisioned yet, or
   * after `stop()`. Safe to repeat and to resume: each join first asks who is already in the room.
   */
  syncMember(duoId: string): Promise<MemberSpaceOutcome> {
    if (this.stopped) {
      // Shutting down: start nothing. Nothing is marked, so the next start's backfill picks the member up.
      return Promise.resolve({ duoId, status: "waiting" });
    }
    const running = this.memberInflight.get(duoId);
    if (running) {
      return running;
    }
    const attempt = this.runMember(duoId).finally(() => this.memberInflight.delete(duoId));
    this.memberInflight.set(duoId, attempt);
    return attempt;
  }

  /** The backfill: every org, then every member of every org. Whatever is already done costs nothing. */
  syncAll(): Promise<SpaceSummary> {
    return this.sweep(this.options.registry.orgs().map((org) => org.id), this.memberIds());
  }

  /** The timer's sweep: only what is owed and whose backoff has passed. */
  retryPending(now: number = Date.now()): Promise<SpaceSummary> {
    return this.sweep(this.dueOrgIds(now), this.dueMemberIds(now));
  }

  hasRetryDue(now: number = Date.now()): boolean {
    return this.dueOrgIds(now).length > 0 || this.dueMemberIds(now).length > 0;
  }

  /** After this a running sweep finishes the item it is on and starts no other. */
  stop(): void {
    this.stopped = true;
  }

  async whenIdle(): Promise<void> {
    while (this.orgInflight.size > 0 || this.memberInflight.size > 0) {
      await Promise.allSettled([...this.orgInflight.values(), ...this.memberInflight.values()]);
    }
  }

  private memberIds(): string[] {
    return this.options.registry.orgs().flatMap((org) => this.options.registry.listOrgMembers(org.id).map((member) => member.duoId));
  }

  private backoffPassed(pending: MatrixPending | undefined, now: number): boolean {
    if (!pending) {
      return true;
    }
    const base = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const max = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    return Date.parse(pending.lastAttemptAt) + Math.min(base * 2 ** Math.min(pending.attempts - 1, 30), max) <= now;
  }

  private dueOrgIds(now: number): string[] {
    return this.options.registry
      .orgs()
      .filter((org) => !orgSpaceComplete(org) && this.backoffPassed(org.spacePending, now))
      .map((org) => org.id);
  }

  /**
   * Members with accounts that fit their org, who are not recorded in their org's current rooms and
   * whose backoff has passed. A member whose accounts do not fit is left out: it needs an operator, no
   * retry helps, and `runMember` (which still refuses it when called directly) records no pending mark
   * for it, so it would otherwise be due, and logged, on every tick.
   */
  private dueMemberIds(now: number): string[] {
    const { registry } = this.options;
    return this.memberIds().filter((duoId) => this.accountsFitOrg(duoId) && !this.memberDone(duoId) && this.backoffPassed(registry.spacePending(duoId), now));
  }

  /** The member has Matrix accounts and both their ids carry the member's own org. */
  private accountsFitOrg(duoId: string): boolean {
    const accounts = this.options.registry.matrixAccounts(duoId);
    const org = this.options.registry.orgOf(duoId);
    return !!accounts && !!org && orgIdOfUserId(accounts.personUserId) === org.id && orgIdOfUserId(accounts.duoUserId) === org.id;
  }

  private memberDone(duoId: string): boolean {
    const { registry } = this.options;
    const org = registry.orgOf(duoId);
    const recorded = registry.matrixSpaces(duoId);
    return !!org && !!recorded && orgSpaceComplete(org) && recorded.spaceRoomId === org.spaceRoomId && recorded.generalRoomId === org.generalRoomId;
  }

  private async sweep(orgIds: readonly string[], duoIds: readonly string[]): Promise<SpaceSummary> {
    const orgOutcomes: OrgSpaceOutcome[] = [];
    for (const orgId of orgIds) {
      if (this.stopped) {
        break;
      }
      try {
        orgOutcomes.push(await this.ensureOrg(orgId));
      } catch (error) {
        orgOutcomes.push(this.unexpectedOrg(orgId, error));
      }
    }
    const memberOutcomes: MemberSpaceOutcome[] = [];
    for (const duoId of duoIds) {
      if (this.stopped) {
        break;
      }
      try {
        memberOutcomes.push(await this.syncMember(duoId));
      } catch (error) {
        memberOutcomes.push(this.unexpectedMember(duoId, error));
      }
    }
    const orgCount = (status: SpaceStatus) => orgOutcomes.filter((outcome) => outcome.status === status).length;
    const memberCount = (status: SpaceStatus) => memberOutcomes.filter((outcome) => outcome.status === status).length;
    return {
      orgs: { provisioned: orgCount("provisioned"), already: orgCount("already"), pending: orgCount("pending"), failed: orgCount("failed") },
      members: {
        provisioned: memberCount("provisioned"),
        already: memberCount("already"),
        pending: memberCount("pending"),
        failed: memberCount("failed"),
        waiting: memberCount("waiting"),
      },
      orgOutcomes,
      memberOutcomes,
    };
  }

  /** The error's name only (a message could quote something it should not); best-effort marks the org so it backs off. */
  private unexpectedOrg(orgId: string, error: unknown): OrgSpaceOutcome {
    const name = error instanceof Error ? error.name : "error";
    this.log(`hosted: org space provisioning failed unexpectedly for org ${orgId} (${name})`);
    const reason = `unexpected error (${name}); see the daemon log`;
    try {
      this.options.registry.recordOrgSpaceFailure(orgId, reason);
    } catch {
      // The registry may be what failed, or the org may not exist; the outcome and the log still say so.
    }
    return { orgId, status: "failed", error: reason };
  }

  private unexpectedMember(duoId: string, error: unknown): MemberSpaceOutcome {
    const name = error instanceof Error ? error.name : "error";
    this.log(`hosted: org space join failed unexpectedly for duo ${duoId} (${name})`);
    const reason = `unexpected error (${name}); see the daemon log`;
    try {
      this.options.registry.recordSpaceFailure(duoId, reason);
    } catch {
      // As above.
    }
    return { duoId, status: "failed", error: reason };
  }

  private async serverName(): Promise<string> {
    if (this.serverNameCache === undefined) {
      const adminUserId = await this.options.admin.whoAmI();
      const name = /^@[^:]+:(.+)$/.exec(adminUserId)?.[1];
      if (!name) {
        throw new SynapseAdminError("Synapse whoami returned an id with no server name", 200, null, false);
      }
      this.serverNameCache = name;
    }
    return this.serverNameCache;
  }

  /**
   * A registry write that keeps a room id. `createPrivateRoom` sends a stable transaction id, so a
   * repeat inside Synapse's 30 minute in-memory cache returns the same room, but past that (or after
   * a Synapse restart) a room whose id was not recorded is lost: one immediate retry of the write,
   * then log the id so an operator can find it, and rethrow.
   */
  private record(orgId: string, patch: Parameters<HostedRegistry["updateOrgSpace"]>[1]): HostedOrg {
    const { registry } = this.options;
    try {
      try {
        return registry.updateOrgSpace(orgId, patch);
      } catch {
        return registry.updateOrgSpace(orgId, patch);
      }
    } catch (error) {
      this.log(`hosted: created ${JSON.stringify(patch)} for org ${orgId} but could not record it (${error instanceof Error ? error.name : "error"}); an unrecorded room may now exist`);
      throw error;
    }
  }

  private async runOrg(orgId: string): Promise<OrgSpaceOutcome> {
    const { registry, admin } = this.options;
    const start = registry.org(orgId);
    if (!start) {
      throw new OrgNotFoundError(orgId);
    }
    if (orgSpaceComplete(start)) {
      return { orgId, status: "already", spaceRoomId: start.spaceRoomId, generalRoomId: start.generalRoomId };
    }
    try {
      const serverName = await this.serverName();
      let org: HostedOrg = start;
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        if (org.spaceRoomId === undefined) {
          const spaceRoomId = await admin.createPrivateRoom({ name: org.name, space: true, txnId: `org-${orgId}-space` });
          org = this.record(orgId, { spaceRoomId, spaceSyncedName: org.name });
          this.log(`hosted: created the Space for org ${orgId} (${spaceRoomId})`);
        }
        if (org.generalRoomId === undefined) {
          const generalRoomId = await admin.createPrivateRoom({ name: GENERAL_ROOM_NAME, txnId: `org-${orgId}-general` });
          org = this.record(orgId, { generalRoomId });
          this.log(`hosted: created #general for org ${orgId} (${generalRoomId})`);
        }
        if (!org.generalLinked) {
          await admin.addSpaceChild(org.spaceRoomId!, org.generalRoomId!, [serverName]);
          org = this.record(orgId, { generalLinked: true });
        }
        if (org.spaceSyncedName !== org.name) {
          await admin.setRoomName(org.spaceRoomId!, org.name);
          org = this.record(orgId, { spaceSyncedName: org.name });
          this.log(`hosted: renamed the Space for org ${orgId}`);
        }
        if (!org.functionalMembersSet) {
          const serviceAccountId = `@${SERVICE_ACCOUNT_LOCALPART}:${serverName}`;
          await admin.setFunctionalMembers(org.spaceRoomId!, [serviceAccountId]);
          await admin.setFunctionalMembers(org.generalRoomId!, [serviceAccountId]);
          org = this.record(orgId, { functionalMembersSet: true });
          this.log(`hosted: hid the service account from the Space and #general's names for org ${orgId}`);
        }
        if (!org.memberLinksAllowed) {
          // #274: members may list a room in the Space (the org wall judges each link), so a room open to the org is findable by it.
          await admin.allowMemberSpaceLinks(org.spaceRoomId!);
          org = this.record(orgId, { memberLinksAllowed: true });
          this.log(`hosted: let members list rooms open to the org in the Space for org ${orgId}`);
        }
        // A rename that landed while this pass ran leaves the org out of step; go round again.
        org = registry.org(orgId) ?? org;
        if (orgSpaceComplete(org)) {
          break;
        }
      }
      if (!orgSpaceComplete(org)) {
        return this.failOrg(orgId, "the org's name kept changing while its Space was being named");
      }
      registry.clearOrgSpacePending(orgId);
      return { orgId, status: "provisioned", spaceRoomId: org.spaceRoomId, generalRoomId: org.generalRoomId };
    } catch (error) {
      if (error instanceof SynapseAdminError) {
        return this.failOrg(orgId, error.message);
      }
      throw error;
    }
  }

  private failOrg(orgId: string, reason: string): OrgSpaceOutcome {
    this.options.registry.recordOrgSpaceFailure(orgId, reason);
    this.log(`hosted: the Space for org ${orgId} is pending: ${reason}`);
    return { orgId, status: "pending", error: reason };
  }

  private async runMember(duoId: string): Promise<MemberSpaceOutcome> {
    const { registry, admin } = this.options;
    const org = registry.orgOf(duoId);
    if (!org) {
      throw new Error(`No hosted duo "${duoId}" to join into an org Space.`);
    }
    const accounts = registry.matrixAccounts(duoId);
    if (!accounts) {
      return { duoId, status: "waiting" };
    }
    // Only ever this duo's own org: both accounts must carry it in their ids, or nothing is joined.
    if (orgIdOfUserId(accounts.personUserId) !== org.id || orgIdOfUserId(accounts.duoUserId) !== org.id) {
      const problem = `the Matrix accounts recorded for duo ${duoId} do not belong to its org (${org.id}); they were not joined to its Space`;
      this.log(`hosted: ${problem}`);
      return { duoId, status: "failed", error: problem };
    }
    if (this.memberDone(duoId)) {
      return { duoId, status: "already" };
    }

    const rooms = await this.ensureOrg(org.id);
    if (rooms.status !== "provisioned" && rooms.status !== "already") {
      return this.failMember(duoId, `the org's Space is not ready yet${rooms.error ? ` (${rooms.error})` : ""}`);
    }
    const spaceRoomId = rooms.spaceRoomId!;
    const generalRoomId = rooms.generalRoomId!;
    try {
      for (const userId of [accounts.personUserId, accounts.duoUserId]) {
        await admin.joinUser(spaceRoomId, userId);
        await admin.joinUser(generalRoomId, userId);
      }
    } catch (error) {
      if (error instanceof SynapseAdminError) {
        return this.failMember(duoId, error.message);
      }
      throw error;
    }
    registry.setMatrixSpaces(duoId, { spaceRoomId, generalRoomId });
    this.log(`hosted: joined duo ${duoId}'s person and duo accounts to the Space and #general of org ${org.id}`);
    return { duoId, status: "provisioned" };
  }

  private failMember(duoId: string, reason: string): MemberSpaceOutcome {
    this.options.registry.recordSpaceFailure(duoId, reason);
    this.log(`hosted: joining duo ${duoId} to its org's Space is pending: ${reason}`);
    return { duoId, status: "pending", error: reason };
  }
}
