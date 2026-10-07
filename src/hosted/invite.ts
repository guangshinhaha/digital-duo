import type { OrgMemberView } from "./org-admin.js";
import type { HostedOrgSummary } from "./orgs.js";
import { hostedSettingsFrom } from "./server.js";

/**
 * Asks the running hosted daemon on this machine to do an admin job. The
 * CLI goes through the daemon rather than writing the registry itself, so
 * the daemon stays the registry's only writer.
 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** A provision sweep asks Synapse once per duo, each call bounded at 10s, so it gets longer. */
const PROVISION_CALL_TIMEOUT_MS = 180_000;

async function callDaemon<T>(
  env: NodeJS.ProcessEnv,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<T> {
  const settings = hostedSettingsFrom(env);
  const port = env.PORT || "7717";
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.adminToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`${method} ${path}: the daemon did not answer within ${timeoutMs / 1000}s. It may still be working; check its log.`);
    }
    throw error;
  }
  const parsed = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) {
    throw new Error(parsed.error?.message ?? `${method} ${path} failed: HTTP ${response.status}`);
  }
  return parsed;
}

/** Implements `duo hosted invite <name> [--org <id>]`; with no org the invite is into the default org. */
export async function runHostedInvite(
  name: string,
  expiresInHours: number,
  env: NodeJS.ProcessEnv = process.env,
  orgId?: string,
): Promise<{ name: string; orgId: string; expiresAt: string; code: string; link: string | null }> {
  return callDaemon(env, "POST", "/hosted/invites", { name, expiresInHours, ...(orgId ? { orgId } : {}) });
}

/** Implements `duo hosted provision`: creates the Matrix accounts every hosted duo still lacks, then each org's Space and `#general` and the members' places in them (idempotent). */
export function runHostedProvision(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = PROVISION_CALL_TIMEOUT_MS,
): Promise<{
  provisioned: number;
  already: number;
  pending: number;
  failed: number;
  outcomes: Array<{ duoId: string; status: string; error?: string }>;
  spaces: {
    orgs: { provisioned: number; already: number; pending: number; failed: number };
    members: { provisioned: number; already: number; pending: number; failed: number; waiting: number };
    orgOutcomes: Array<{ orgId: string; status: string; error?: string }>;
    memberOutcomes: Array<{ duoId: string; status: string; error?: string }>;
  };
}> {
  return callDaemon(env, "POST", "/hosted/matrix/provision", {}, timeoutMs);
}

/** Implements `duo hosted provision --remint <duoId>`: gives a duo Synapse no longer knows the token of a new one. The answer carries status and ids, never the token. */
export function runHostedRemint(
  duoId: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = PROVISION_CALL_TIMEOUT_MS,
): Promise<{ duoId: string; status: string; error?: string; accounts?: { personUserId: string; duoUserId: string } }> {
  return callDaemon(env, "POST", "/hosted/matrix/remint", { duoId }, timeoutMs);
}

/** Implements `duo hosted org create "<name>"`. */
export function runHostedOrgCreate(name: string, env: NodeJS.ProcessEnv = process.env): Promise<HostedOrgSummary> {
  return callDaemon(env, "POST", "/hosted/orgs", { name });
}

/** Implements `duo hosted org list`. */
export function runHostedOrgList(env: NodeJS.ProcessEnv = process.env): Promise<HostedOrgSummary[]> {
  return callDaemon(env, "GET", "/hosted/orgs");
}

/** Implements `duo hosted org rename <id> "<name>"`. */
export function runHostedOrgRename(orgId: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<HostedOrgSummary> {
  return callDaemon(env, "POST", `/hosted/orgs/${encodeURIComponent(orgId)}/rename`, { name });
}

/** Implements `duo hosted org members <id>`. */
export function runHostedOrgMembers(orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgMemberView[]> {
  return callDaemon(env, "GET", `/hosted/orgs/${encodeURIComponent(orgId)}/members`);
}

/** One line of `duo hosted org members`: id, name, email, then the role marks (`super admin`, or `org admin` with who appointed them and when), and duo#318's verification/answering marks. */
export function formatOrgMemberLine(member: OrgMemberView): string {
  const marks: string[] = [];
  if (member.superAdmin) {
    marks.push("super admin");
  }
  if (member.orgRole === "org_admin") {
    marks.push(`org admin (appointed by ${member.appointedByName ?? member.appointedBy ?? "unknown"}${member.appointedAt ? ` on ${member.appointedAt.slice(0, 10)}` : ""})`);
  }
  if (!member.verified) {
    marks.push("unverified");
  }
  if (!member.answeringEnabled) {
    marks.push(`answering revoked (by ${member.answeringRevokedByName ?? "unknown"}${member.answeringRevokedAt ? ` on ${member.answeringRevokedAt.slice(0, 10)}` : ""})`);
  }
  return [member.duoId, member.name, member.email ?? "-", ...marks].join("\t");
}

export interface OrgAdminChange {
  member: OrgMemberView;
  /** False when the duo already had (grant) or already lacked (revoke) the role: nothing was written. */
  changed: boolean;
}

/** Implements `duo hosted org admin grant <orgId> <duoId>`: appoints a member as their org's admin, as the super admin. */
export function runHostedOrgAdminGrant(orgId: string, duoId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgAdminChange> {
  return callDaemon(env, "POST", `/hosted/orgs/${encodeURIComponent(orgId)}/admins/${encodeURIComponent(duoId)}/grant`, {});
}

/** Implements `duo hosted org admin revoke <orgId> <duoId>`: as the super admin, so it may revoke an org's last org admin. */
export function runHostedOrgAdminRevoke(orgId: string, duoId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgAdminChange> {
  return callDaemon(env, "POST", `/hosted/orgs/${encodeURIComponent(orgId)}/admins/${encodeURIComponent(duoId)}/revoke`, {});
}

/** duo#318: implements `duo hosted answering revoke <orgId> <duoId>`: stops a member's duo from answering colleagues, as the super admin. Idempotent. */
export function runHostedAnsweringRevoke(orgId: string, duoId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgAdminChange> {
  return callDaemon(env, "POST", `/hosted/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(duoId)}/answering/revoke`, {});
}

/** duo#318: implements `duo hosted answering restore <orgId> <duoId>`: lets a member's duo answer colleagues again, as the super admin. Idempotent. */
export function runHostedAnsweringRestore(orgId: string, duoId: string, env: NodeJS.ProcessEnv = process.env): Promise<OrgAdminChange> {
  return callDaemon(env, "POST", `/hosted/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(duoId)}/answering/restore`, {});
}

/** What `duo hosted end <duoId>` answers: whether the duo was found, which Matrix accounts were just deactivated, and any Synapse trouble (never a token). */
export interface EndDuoResult {
  readonly duoId: string;
  readonly found: boolean;
  readonly deactivated: { readonly person: boolean; readonly duo: boolean };
  readonly errors: readonly string[];
}

/**
 * Implements `duo hosted end <duoId>` (#275): ends a hosted duo for good, as the super admin. Refused for
 * the root duo by the daemon; ending an already-gone duo answers `found: false` rather than failing, so
 * the command is safe to re-run.
 */
export function runHostedEnd(duoId: string, env: NodeJS.ProcessEnv = process.env): Promise<EndDuoResult> {
  return callDaemon(env, "POST", `/hosted/duos/${encodeURIComponent(duoId)}/end`, {});
}
