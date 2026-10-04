import type { MatrixPending } from "./registry.js";

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
 * The shape of an org id. It is embedded in Matrix account names
 * (`@<orgId>.<handle>:<server>`) that are split on the first dot and are
 * permanent once created, so an id is lowercase letters and digits only: no
 * `.`, no `-`. `newShortId` in registry.ts only ever generates such ids; this
 * is the registry-level rule, checked wherever an id enters it.
 */
export const ORG_ID_PATTERN = /^[a-z0-9]+$/;

/** Throws unless `id` is a valid org id (see `ORG_ID_PATTERN`). */
export function assertOrgId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ORG_ID_PATTERN.test(id)) {
    throw new Error(`Org id ${JSON.stringify(id)} must be lowercase letters and digits only.`);
  }
}

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
  /**
   * The org's Matrix Space and `#general` (#234), private rooms the service account created and stays in.
   * Absent until Synapse has made them. They are optional fields on a v2 registry, so an older build
   * reads the file and ignores them, and a file without them is simply "no space yet".
   */
  readonly spaceRoomId?: string;
  readonly generalRoomId?: string;
  /** The org name last written to the Space, so a rename is noticed and pushed (and a synced Space costs no call). */
  readonly spaceSyncedName?: string;
  /** True once `#general` is a child of the Space. */
  readonly generalLinked?: boolean;
  /**
   * True once the Space and `#general` both carry `io.element.functional_members` naming the service
   * account (#272): it created and stays in both rooms, and without this it can pollute matrix-js-sdk's
   * auto-generated room name and shows up in `#general`'s member list. An optional addition to a v2
   * registry with no version bump, like `generalLinked`: absent means not set yet, including on a room
   * made before this existed, so the backfill (`orgSpaceComplete`) picks it up on the next sweep.
   */
  readonly functionalMembersSet?: boolean;
  /** Set while the org's rooms are owed and failing; cleared when they are complete and named right. */
  readonly spacePending?: MatrixPending;
}

/** An org plus how many duos are in it, for listings. */
export interface HostedOrgSummary extends HostedOrg {
  readonly memberCount: number;
}

/**
 * Who made an org-admin change, as a stable id and never an email (an email changes, and is personal data in an audit
 * list): `SUPER_ADMIN_ACTOR` for the super admin (the server admin token or a super admin's own device), otherwise the
 * appointing duo's id. It cannot collide with a duo id, which is lowercase letters and digits only.
 */
export const SUPER_ADMIN_ACTOR = "super-admin";

/** A duo's role in its org. The super admin is not a role here: it is decided from `DUO_HOSTED_ADMIN_EMAILS`, above every org. */
export type OrgRole = "member" | "org_admin";

/** When and by whom a duo was appointed org admin (#254). Present on a tenant only while it holds the role. */
export interface OrgAdminGrant {
  readonly since: string;
  /** `SUPER_ADMIN_ACTOR` or the appointing duo's id. */
  readonly by: string;
}

/** One entry of a duo's append-only appoint/revoke history. */
export interface OrgAdminLogEntry {
  readonly at: string;
  readonly action: "grant" | "revoke";
  /** `SUPER_ADMIN_ACTOR` or the acting duo's id (the duo's own id when it stepped down). */
  readonly by: string;
}

/** Each duo keeps its latest entries only, so the registry file cannot grow without bound. */
export const ORG_ADMIN_LOG_CAP = 50;

/** One duo in an org. `duoId` is the tenant id, or `ROOT_DUO_ID` for the pre-hosted root duo. */
export interface OrgMember {
  readonly duoId: string;
  readonly name: string;
  readonly email: string | null;
  readonly isRoot: boolean;
  readonly joinedAt: string | null;
  /** `org_admin` while the duo holds the role (#254); the root duo is always a `member`. */
  readonly orgRole: OrgRole;
  /** Set with `orgRole: "org_admin"`: when and by whom. */
  readonly orgAdmin: OrgAdminGrant | null;
  /** The duo's appoint/revoke history, oldest first (bounded); empty for a duo never appointed. */
  readonly orgAdminLog: readonly OrgAdminLogEntry[];
}

export class OrgNotFoundError extends Error {
  constructor(readonly orgId: string) {
    super(`There is no org "${orgId}".`);
    this.name = "OrgNotFoundError";
  }
}

/** The duo is not a member of this org, or does not exist: one error for both, so an id from another org tells nothing. */
export class OrgMemberNotFoundError extends Error {
  constructor() {
    super("There is no such member in this org.");
    this.name = "OrgMemberNotFoundError";
  }
}

/** The pre-hosted root duo is served for the super admin and cannot hold the org admin role: appointing it and revoking it are both refused with this. */
export class RootNotAppointableError extends Error {
  constructor() {
    super("The root duo cannot hold the org admin role.");
    this.name = "RootNotAppointableError";
  }
}

/** Revoking would leave an org with no org admin; only the super admin may do that. */
export class LastOrgAdminError extends Error {
  constructor() {
    super("This is the last org admin of the org. Appoint another org admin first, or ask the super admin.");
    this.name = "LastOrgAdminError";
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

/** Control characters, and format characters (zero-width space/joiner, bidi marks, BOM), plus line and paragraph separators: they render as nothing or reorder text, so two "different" names can look identical. */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * NFKC-normalizes, trims and bounds an org name; throws OrgNameError when it
 * is unusable. Normalizing first means look-alike forms (full-width letters,
 * ligatures, an ideographic space) cannot make two names that read the same
 * count as different when the registry compares them.
 */
export function normalizeOrgName(name: unknown): string {
  const normalized = typeof name === "string" ? name.normalize("NFKC").trim() : "";
  if (normalized.length === 0 || normalized.length > MAX_ORG_NAME_LENGTH) {
    throw new OrgNameError(`An org name is required (at most ${MAX_ORG_NAME_LENGTH} characters).`);
  }
  if (UNSAFE_NAME_CHARACTERS.test(normalized)) {
    throw new OrgNameError("An org name cannot contain control or invisible characters.");
  }
  return normalized;
}
