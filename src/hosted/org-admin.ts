import type { OrgAdminAccess, OrgAdminOutcome, OrgAdminRefusal } from "../serve/org-routes.js";
import {
  LastOrgAdminError,
  OrgMemberNotFoundError,
  OrgNameError,
  OrgNameTakenError,
  OrgNotFoundError,
  ROOT_DUO_ID,
  RootNotAppointableError,
  SUPER_ADMIN_ACTOR,
  type HostedOrg,
  type OrgAdminLogEntry,
  type OrgMember,
  type OrgRole,
} from "./orgs.js";
import type { HostedRegistry } from "./registry.js";

/**
 * Org admins (#254, docs/deploy/hosted-workspace.md §7): a member who manages their own org, appointed by the super admin
 * or another org admin. This is the one place that decides what each of the three roles may do, so the per-duo routes an
 * org admin's app calls (`<basePath>/org*`, through `OrgAdminAccess`) and the super admin's `/hosted/orgs/:orgId/...` routes
 * cannot drift apart. It reads only the registry: the role never reaches Matrix provisioning, the Spaces or the workspace
 * session (chat power is unchanged; a test holds that).
 */

/** The one 403 every "not for you" answer gives: a member, an org admin asking for a super admin's power, another org. Same body whatever the reason, so it tells nothing. */
export const FORBIDDEN: OrgAdminRefusal = { ok: false, status: 403, code: "forbidden", message: "Only an admin can do this." };

const NOT_FOUND: OrgAdminRefusal = { ok: false, status: 404, code: "not_found", message: "There is no such member in this org." };

const DEFAULT_INVITE_HOURS = 7 * 24;

/** An org member as an admin may see it. `isAdmin` and `superAdmin` are the same fact (the super admin, decided live from the emails), kept under both names: `isAdmin` is what the admin screens have always read. */
export interface OrgMemberView {
  readonly duoId: string;
  readonly name: string;
  readonly email: string | null;
  readonly isRoot: boolean;
  readonly joinedAt: string | null;
  readonly isAdmin: boolean;
  readonly superAdmin: boolean;
  readonly orgRole: OrgRole;
  /** Who appointed this org admin: `super-admin` or a duo id. Null for a member. */
  readonly appointedBy: string | null;
  /** What to call them: "Super admin", the appointing duo's name, or null when unknown. */
  readonly appointedByName: string | null;
  readonly appointedAt: string | null;
  /** Every appoint and revoke of this duo, oldest first (bounded). */
  readonly orgAdminLog: ReadonlyArray<OrgAdminLogEntry & { byName: string | null }>;
}

export interface OrgAdminDeps {
  readonly registry: HostedRegistry;
  /** Live: whether this (lowercased or not) email is a super admin's, from `DUO_HOSTED_ADMIN_EMAILS`. */
  readonly isAdminEmail: (email: string | undefined) => boolean;
  /** Renames the org and pushes the name to its Space, exactly as the super admin's rename does. Throws the org errors. */
  readonly renameOrg: (orgId: string, name: string) => Promise<HostedOrg>;
  /** The link an invitee opens, or null when the server has no public/web address. */
  readonly inviteLink: (code: string) => string | null;
}

/** The invite fields, validated the same way whoever creates the invite. */
export function parseInviteInput(body: unknown): { ok: true; name: string; hours: number; email: string | null } | OrgAdminRefusal {
  const fields = (body ?? {}) as { name?: unknown; email?: unknown; expiresInHours?: unknown };
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const hours = fields.expiresInHours ?? DEFAULT_INVITE_HOURS;
  if (name.length === 0 || typeof hours !== "number" || !Number.isInteger(hours) || hours <= 0 || hours > 24 * 365) {
    return { ok: false, status: 400, code: "bad_request", message: "name is required; expiresInHours must be a whole number from 1 to 8760" };
  }
  const rawEmail = fields.email;
  if (rawEmail !== undefined && rawEmail !== null && (typeof rawEmail !== "string" || !rawEmail.includes("@"))) {
    return { ok: false, status: 400, code: "bad_request", message: "email, when given, must be an email address" };
  }
  const email = typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null;
  return { ok: true, name, hours, email };
}

/** Maps a thrown org error to its refusal; undefined means it is not one of ours and the caller rethrows. */
export function refusalFor(error: unknown): OrgAdminRefusal | undefined {
  if (error instanceof OrgNotFoundError) {
    return { ok: false, status: 404, code: "org_not_found", message: error.message };
  }
  if (error instanceof OrgMemberNotFoundError) {
    return NOT_FOUND;
  }
  if (error instanceof OrgNameTakenError) {
    return { ok: false, status: 409, code: "org_name_taken", message: error.message };
  }
  if (error instanceof OrgNameError) {
    return { ok: false, status: 400, code: "bad_request", message: error.message };
  }
  if (error instanceof LastOrgAdminError) {
    return { ok: false, status: 409, code: "last_org_admin", message: error.message };
  }
  if (error instanceof RootNotAppointableError) {
    return { ok: false, status: 409, code: "root_not_appointable", message: error.message };
  }
  return undefined;
}

export class OrgAdmin {
  constructor(private readonly deps: OrgAdminDeps) {}

  /** What each duo is called in the history: a duo's own name, or "Super admin". */
  private actorName(actor: string): string | null {
    if (actor === SUPER_ADMIN_ACTOR) {
      return "Super admin";
    }
    return this.deps.registry.tenants().find((tenant) => tenant.id === actor)?.name ?? null;
  }

  private view(member: OrgMember): OrgMemberView {
    const superAdmin = this.deps.isAdminEmail(member.email ?? undefined);
    return {
      duoId: member.duoId,
      name: member.name,
      email: member.email,
      isRoot: member.isRoot,
      joinedAt: member.joinedAt,
      isAdmin: superAdmin,
      superAdmin,
      orgRole: member.orgRole,
      appointedBy: member.orgAdmin?.by ?? null,
      appointedByName: member.orgAdmin ? this.actorName(member.orgAdmin.by) : null,
      appointedAt: member.orgAdmin?.since ?? null,
      orgAdminLog: member.orgAdminLog.map((entry) => ({ ...entry, byName: this.actorName(entry.by) })),
    };
  }

  /** The org's members with their role marks. Throws `OrgNotFoundError`. */
  membersOf(orgId: string): OrgMemberView[] {
    return this.deps.registry.listOrgMembers(orgId).map((member) => this.view(member));
  }

  /** A pending invite as an org admin may see it: never the code's hash, never who redeemed it. */
  pendingInvites(orgId: string, now = Date.now()) {
    return this.deps.registry
      .invites()
      .filter((invite) => invite.orgId === orgId && invite.usedAt === null && Date.parse(invite.expiresAt) > now)
      .map((invite) => ({ id: invite.id, name: invite.name, email: invite.email ?? null, orgId: invite.orgId, createdAt: invite.createdAt, expiresAt: invite.expiresAt }));
  }

  /** Creates an invite into `orgId` and shows its code once. Throws `OrgNotFoundError`. */
  mintInvite(orgId: string | undefined, input: { name: string; hours: number; email: string | null }) {
    const { invite, code } = this.deps.registry.createInvite(input.name, new Date(Date.now() + input.hours * 3_600_000).toISOString(), input.email, orgId);
    return { id: invite.id, name: invite.name, email: invite.email ?? null, orgId: invite.orgId, expiresAt: invite.expiresAt, code, link: this.deps.inviteLink(code) };
  }

  /**
   * Appoints `duoId`, a member of `orgId`, on behalf of `actor` (`SUPER_ADMIN_ACTOR` or an org admin's duo id). The super admin
   * and the root duo cannot be appointed: they already reach every org. Unknown and other-org ids are one and the same 404.
   */
  grant(orgId: string, duoId: string, actor: string): OrgAdminOutcome<{ member: OrgMemberView; changed: boolean }> {
    try {
      const target = this.deps.registry.listOrgMembers(orgId).find((member) => member.duoId === duoId);
      if (target && !target.isRoot && this.deps.isAdminEmail(target.email ?? undefined)) {
        return { ok: false, status: 409, code: "super_admin_protected", message: "The super admin manages every org already and cannot be made an org admin." };
      }
      const { member, changed } = this.deps.registry.grantOrgAdmin(orgId, duoId, actor);
      return { ok: true, value: { member: this.view(member), changed } };
    } catch (error) {
      const refusal = refusalFor(error);
      if (refusal) {
        return refusal;
      }
      throw error;
    }
  }

  /** Takes the role from `duoId`. Only the super admin (`actor === SUPER_ADMIN_ACTOR`) may revoke the last org admin, or touch a super admin's own duo. */
  revoke(orgId: string, duoId: string, actor: string): OrgAdminOutcome<{ member: OrgMemberView; changed: boolean }> {
    const superAdminActing = actor === SUPER_ADMIN_ACTOR;
    try {
      const target = this.deps.registry.listOrgMembers(orgId).find((member) => member.duoId === duoId);
      if (!superAdminActing && target && !target.isRoot && this.deps.isAdminEmail(target.email ?? undefined)) {
        return { ok: false, status: 409, code: "super_admin_protected", message: "The super admin's access is not managed by an org admin." };
      }
      const { member, changed } = this.deps.registry.revokeOrgAdmin(orgId, duoId, actor, { allowLast: superAdminActing });
      return { ok: true, value: { member: this.view(member), changed } };
    } catch (error) {
      const refusal = refusalFor(error);
      if (refusal) {
        return refusal;
      }
      throw error;
    }
  }

  /** `renameOrg` for an org admin's own org, answering as a value. */
  async renameAs(orgId: string, body: unknown): Promise<OrgAdminOutcome> {
    try {
      const renamed = await this.deps.renameOrg(orgId, (body as { name?: unknown } | null)?.name as string);
      return { ok: true, value: { org: { id: renamed.id, name: renamed.name } } };
    } catch (error) {
      const refusal = refusalFor(error);
      if (refusal) {
        return refusal;
      }
      throw error;
    }
  }

  /** Whether the duo behind this id is a super admin: a tenant by its stored email, the root duo by its claim's. Live, like every super-admin check. */
  private isSuperAdminDuo(duoId: string): boolean {
    const { registry } = this.deps;
    const email = duoId === ROOT_DUO_ID ? registry.root()?.email : registry.tenants().find((tenant) => tenant.id === duoId)?.email;
    return this.deps.isAdminEmail(email);
  }

  /** The handle one duo's app gets: everything is about that duo's own org, and its role is read fresh on every call. */
  forDuo(duoId: string): OrgAdminAccess {
    const { registry } = this.deps;
    const org = () => registry.orgOf(duoId);
    /** The org this duo administers, or the refusal: it must hold the role now. */
    const asOrgAdmin = (): { orgId: string } | OrgAdminRefusal => {
      const own = org();
      return own && registry.orgRoleOf(duoId) === "org_admin" ? { orgId: own.id } : FORBIDDEN;
    };
    /** A request field that names an org is never followed; naming any org but the caller's own is the refusal every other-org attempt gets. */
    const namesOtherOrg = (body: unknown, orgId: string): boolean => {
      const named = (body as { orgId?: unknown } | null | undefined)?.orgId;
      return named !== undefined && named !== null && named !== orgId;
    };
    return {
      overview: () => {
        const own = org();
        return own && { org: { id: own.id, name: own.name }, role: registry.orgRoleOf(duoId), superAdmin: this.isSuperAdminDuo(duoId) };
      },
      members: () => {
        const scope = asOrgAdmin();
        return "orgId" in scope ? { ok: true, value: this.membersOf(scope.orgId) } : scope;
      },
      invites: () => {
        const scope = asOrgAdmin();
        return "orgId" in scope ? { ok: true, value: this.pendingInvites(scope.orgId) } : scope;
      },
      invite: (body) => {
        const scope = asOrgAdmin();
        if (!("orgId" in scope)) {
          return scope;
        }
        if (namesOtherOrg(body, scope.orgId)) {
          return FORBIDDEN;
        }
        const input = parseInviteInput(body);
        if (!input.ok) {
          return input;
        }
        return { ok: true, status: 201, value: this.mintInvite(scope.orgId, input) };
      },
      rename: async (body) => {
        const scope = asOrgAdmin();
        if (!("orgId" in scope)) {
          return scope;
        }
        return namesOtherOrg(body, scope.orgId) ? FORBIDDEN : this.renameAs(scope.orgId, body);
      },
      grant: (target) => {
        const scope = asOrgAdmin();
        return "orgId" in scope ? this.grant(scope.orgId, target, duoId) : scope;
      },
      revoke: (target) => {
        const scope = asOrgAdmin();
        return "orgId" in scope ? this.revoke(scope.orgId, target, duoId) : scope;
      },
    };
  }
}
