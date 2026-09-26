/**
 * Orgs in hosted mode (docs/deploy/hosted-mode.md, "Orgs"): the unit the
 * workspace walls follow. The registry is the source of truth; nothing here
 * touches disk, so the shapes and the migration are testable on their own.
 *
 * Every duo belongs to exactly one org. A tenant carries its `orgId`; the
 * pre-hosted root duo (which is not a tenant) is placed by the registry's
 * `rootOrgId`. Invites carry the org id they admit people into.
 */

/** The org every duo made before orgs existed lands in. A fixed id, so migrating the same file twice gives the same result. */
export const DEFAULT_ORG_ID = "default";
export const DEFAULT_ORG_NAME = "Default";

/**
 * The stable duo id of the pre-hosted root duo, for the org functions that
 * take a duo id. Tenant ids are ten lowercase-alphanumeric characters, so
 * this cannot collide with one.
 */
export const ROOT_DUO_ID = "root";

export const MAX_ORG_NAME_LENGTH = 80;

/** Bump when the registry file's shape changes, and add the step to `migrateRegistryFile`. */
export const REGISTRY_VERSION = 2;

export interface HostedOrg {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** An org plus how many duos are in it, for listings. */
export interface HostedOrgSummary extends HostedOrg {
  readonly memberCount: number;
}

/** One duo in an org. `duoId` is the tenant id, or `ROOT_DUO_ID` for the pre-hosted root duo. */
export interface OrgMember {
  readonly duoId: string;
  readonly name: string;
  readonly email: string | null;
  readonly isRoot: boolean;
  readonly joinedAt: string | null;
}

export class OrgNotFoundError extends Error {
  constructor(readonly orgId: string) {
    super(`There is no org "${orgId}".`);
    this.name = "OrgNotFoundError";
  }
}

export class OrgNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgNameError";
  }
}

export class OrgNameTakenError extends Error {
  constructor(name: string) {
    super(`There is already an org named "${name}".`);
    this.name = "OrgNameTakenError";
  }
}

export class RegistryVersionError extends Error {
  constructor(found: unknown) {
    super(`hosted/registry.json is version ${String(found)}, newer than this server understands (${REGISTRY_VERSION}). Refusing to load it.`);
    this.name = "RegistryVersionError";
  }
}

/** Trims and bounds an org name; throws OrgNameError when it is unusable. */
export function normalizeOrgName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_ORG_NAME_LENGTH) {
    throw new OrgNameError(`An org name is required (at most ${MAX_ORG_NAME_LENGTH} characters).`);
  }
  return trimmed;
}
