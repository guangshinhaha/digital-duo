import type { HostedOrgSummary, OrgMember } from "./orgs.js";
import { hostedSettingsFrom } from "./server.js";

/**
 * Asks the running hosted daemon on this machine to do an admin job. The
 * CLI goes through the daemon rather than writing the registry itself, so
 * the daemon stays the registry's only writer.
 */
async function callDaemon<T>(env: NodeJS.ProcessEnv, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const settings = hostedSettingsFrom(env);
  const port = env.PORT || "7717";
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
export function runHostedOrgMembers(orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<Array<OrgMember & { isAdmin: boolean }>> {
  return callDaemon(env, "GET", `/hosted/orgs/${encodeURIComponent(orgId)}/members`);
}
