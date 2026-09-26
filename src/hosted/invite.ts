import type { HostedOrgSummary, OrgMember } from "./orgs.js";
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
