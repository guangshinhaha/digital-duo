import { ROOT_DUO_ID } from "./orgs.js";
import type { HostedRegistry } from "./registry.js";
import { SynapseAdminError, type SynapseAdmin } from "./synapse-admin.js";
import type { DuoWorkspaceConnections } from "./duo-workspace.js";

/**
 * Ends a hosted duo for good (#275): a super-admin-only operation, built to clean up a leftover test
 * tenant and to give an operator a real way to remove one later. It undoes what `MatrixProvisioner`
 * (matrix-accounts.ts) and `addTenant` (registry.ts) set up for a duo, in this order:
 *
 * 1. Both Matrix accounts (person, duo) are deactivated with `erase: true` — a throwaway/ended account is
 *    exactly what that is for (synapse-admin.ts). Deactivation also parts each account from every room it
 *    was in, which is how the duo disappears from its org's Space and `#general` without a separate call.
 * 2. Its live workspace connection, if any, is dropped (`DuoWorkspaceConnections.detach`) rather than left
 *    for the next registry-change sweep, so the end is visible immediately rather than racily.
 * 3. Its registry entry — token, Matrix account records, and so its place in `listOrgMembers` of its org —
 *    is removed (`HostedRegistry.removeTenant`).
 *
 * **Never throws for a Synapse problem**, matching `MatrixProvisioner`'s own rule: an account Synapse
 * refuses to deactivate (an outage, a wrong admin token) is reported in `errors` and the registry is still
 * cleaned up, because a duo that cannot be reached should not be impossible to remove from the roster. An
 * account Synapse has never heard of (404) is not an error at all — it reads as "already gone", which is
 * what makes a second call on the same duo id idempotent.
 *
 * **Refuses the root duo** (`ROOT_DUO_ID`): it is not a tenant, has no registry entry to remove, and is
 * never a disposable thing. The refusal is thrown, not reported, so the super admin never mistakes it for
 * a `found: false` no-op.
 */

export class EndDuoRootRefusedError extends Error {
  constructor() {
    super("The root duo cannot be ended.");
    this.name = "EndDuoRootRefusedError";
  }
}

/** Which of a duo's two Matrix accounts were deactivated by this call (false: already gone, never provisioned, or Synapse refused it — see `errors`). */
export interface EndDuoDeactivation {
  readonly person: boolean;
  readonly duo: boolean;
}

export interface EndDuoOutcome {
  readonly duoId: string;
  /** False when there was no such tenant to end — already ended by an earlier call, or never existed. Not an error. */
  readonly found: boolean;
  readonly deactivated: EndDuoDeactivation;
  /** One scrubbed reason per Matrix account Synapse would not deactivate (never for a 404, which is read as already gone). Empty when nothing went wrong. */
  readonly errors: readonly string[];
}

export interface EndDuoDeps {
  readonly registry: HostedRegistry;
  /** Absent when Synapse admin variables are not configured: nothing to deactivate, so only the registry entry is removed. */
  readonly admin?: Pick<SynapseAdmin, "deactivateUser">;
  /** Absent when workspace connections are not running. */
  readonly connections?: Pick<DuoWorkspaceConnections, "detach">;
  /** One line per event (ids and scrubbed reasons only). Defaults to stderr. */
  readonly log?: (line: string) => void;
}

/** Deactivates one Matrix account, reporting a 404 as "already gone" (not deactivated now, not an error) and any other Synapse trouble as a scrubbed error string. */
async function deactivate(admin: Pick<SynapseAdmin, "deactivateUser">, userId: string): Promise<{ deactivated: boolean; error?: string }> {
  try {
    await admin.deactivateUser(userId, { erase: true });
    return { deactivated: true };
  } catch (error) {
    if (error instanceof SynapseAdminError && error.status === 404) {
      return { deactivated: false };
    }
    return { deactivated: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function endDuo(duoId: string, deps: EndDuoDeps): Promise<EndDuoOutcome> {
  if (duoId === ROOT_DUO_ID) {
    throw new EndDuoRootRefusedError();
  }
  const { registry, admin, connections } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const tenant = registry.tenants().find((candidate) => candidate.id === duoId);
  if (!tenant) {
    return { duoId, found: false, deactivated: { person: false, duo: false }, errors: [] };
  }

  const errors: string[] = [];
  let personDeactivated = false;
  let duoDeactivated = false;
  if (admin && tenant.matrix) {
    const person = await deactivate(admin, tenant.matrix.personUserId);
    personDeactivated = person.deactivated;
    if (person.error) {
      errors.push(`person account: ${person.error}`);
      log(`hosted: ending duo ${duoId}: could not deactivate its person account (${person.error})`);
    }
    const duo = await deactivate(admin, tenant.matrix.duoUserId);
    duoDeactivated = duo.deactivated;
    if (duo.error) {
      errors.push(`duo account: ${duo.error}`);
      log(`hosted: ending duo ${duoId}: could not deactivate its duo account (${duo.error})`);
    }
  }

  if (connections) {
    await connections.detach(duoId);
  }

  registry.removeTenant(duoId);
  log(`hosted: ended duo ${duoId}${errors.length ? ` (${errors.length} Matrix account(s) could not be deactivated; see above)` : ""}`);
  return { duoId, found: true, deactivated: { person: personDeactivated, duo: duoDeactivated }, errors };
}
