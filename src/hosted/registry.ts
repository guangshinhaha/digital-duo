import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decrypt, encrypt } from "../store/crypto.js";
import {
  DEFAULT_ORG_ID,
  DEFAULT_ORG_NAME,
  normalizeOrgName,
  OrgNameTakenError,
  OrgNotFoundError,
  REGISTRY_VERSION,
  RegistryVersionError,
  ROOT_DUO_ID,
  type HostedOrg,
  type HostedOrgSummary,
  type OrgMember,
} from "./orgs.js";

/**
 * Hosted mode's account registry (docs/deploy/hosted-mode.md): who has a
 * duo on this server, and which invites are outstanding. One JSON file,
 * owned by the one hosted process — nothing else writes it, so there is no
 * cross-process race to guard (unlike the per-duo stores, which the CLI can
 * also open).
 *
 * The server holds every duo's key — the owner's 2026-09-26 call for the
 * hosted POC. Each duo's store passphrase is kept here encrypted under
 * DUO_HOSTED_MASTER_KEY, so the registry file alone (a backup, a stolen
 * disk) opens nothing; the running process, which has the master key,
 * opens everything. That is the operator concession org mode §6 states,
 * applied to every hosted duo.
 *
 * Orgs live here too (orgs.ts): every duo belongs to exactly one, and an
 * invite names the org it admits people into. `orgOf` and `listOrgMembers`
 * are the reads later work (accounts, spaces, the org boundary) builds on.
 */

export interface HostedTenant {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** base64 of encrypt(passphrase, masterKey). */
  readonly passphraseCipher: string;
  /** The identity provider's subject this duo is bound to; absent for a duo made before sign-in existed. */
  readonly identitySubject?: string;
  readonly email?: string;
  /** Set at sign-up from the admin emails then in force; the server decides admin-ness live from the email (`DUO_HOSTED_ADMIN_EMAILS`), so this is a record, not the authority. */
  readonly isAdmin?: boolean;
  /** The one org this duo belongs to. */
  readonly orgId: string;
}

/** Who has claimed the pre-hosted root duo by signing in (an admin email's first sign-in). */
export interface RootClaim {
  readonly identitySubject: string;
  readonly email: string;
  readonly claimedAt: string;
}

export interface HostedInvite {
  readonly id: string;
  /** Who the invite is for — a label, prefilled nowhere; the joiner types their own name. */
  readonly name: string;
  /** sha256 of the invite code; the code itself is shown once and never stored. */
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly tenantId: string | null;
  /** When set, only a sign-in with this (lowercased) email may redeem the invite. */
  readonly email?: string | null;
  /** The org the person who redeems this invite joins. */
  readonly orgId: string;
}

interface RegistryFile {
  /** Absent in files written before orgs; `migrateRegistryFile` fills everything in. */
  version: number;
  orgs: HostedOrg[];
  tenants: HostedTenant[];
  invites: HostedInvite[];
  root?: RootClaim | null;
  /** The org the pre-hosted root duo (not a tenant) belongs to. */
  rootOrgId: string;
}

/**
 * Brings a parsed registry file up to the current version, in memory. Lazy:
 * nothing is written until the registry next persists, so starting the
 * server never rewrites the file, and migrating the same file twice gives
 * the same result (the default org has a fixed id).
 *
 * v1 (no `version`, no orgs): a default org is created and every tenant,
 * invite and the root duo go into it, so no id, URL or pairing changes.
 */
export function migrateRegistryFile(raw: unknown, now = new Date().toISOString()): { data: RegistryFile; migrated: boolean } {
  const file = (raw ?? {}) as Partial<RegistryFile>;
  if (file.version !== undefined && file.version > REGISTRY_VERSION) {
    throw new RegistryVersionError(file.version);
  }
  if (file.version === REGISTRY_VERSION) {
    return { data: file as RegistryFile, migrated: false };
  }
  const tenants = file.tenants ?? [];
  const oldest = tenants.map((tenant) => tenant.createdAt).sort()[0] ?? now;
  return {
    migrated: true,
    data: {
      ...file,
      version: REGISTRY_VERSION,
      orgs: [{ id: DEFAULT_ORG_ID, name: DEFAULT_ORG_NAME, createdAt: oldest }],
      tenants: tenants.map((tenant) => ({ ...tenant, orgId: tenant.orgId ?? DEFAULT_ORG_ID })),
      invites: (file.invites ?? []).map((invite) => ({ ...invite, orgId: invite.orgId ?? DEFAULT_ORG_ID })),
      rootOrgId: file.rootOrgId ?? DEFAULT_ORG_ID,
    },
  };
}

export class InviteInvalidError extends Error {
  constructor() {
    super("This invite link is unknown, already used, or expired. Ask for a new one.");
    this.name = "InviteInvalidError";
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** A short, URL-safe, lowercase id — it appears in every URL the duo's owner and askers use. */
function newShortId(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export class HostedRegistry {
  private data: RegistryFile;

  constructor(
    private readonly path: string,
    private readonly masterKey: string,
  ) {
    this.data = migrateRegistryFile(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}).data;
  }

  /** Set by the server when a pre-hosted root duo is being served, so it shows up as an org member. Not persisted. */
  private rootDuoName: string | null = null;

  declareRootDuo(name: string): void {
    this.rootDuoName = name;
  }

  tenants(): readonly HostedTenant[] {
    return this.data.tenants;
  }

  invites(): readonly HostedInvite[] {
    return this.data.invites;
  }

  root(): RootClaim | null {
    return this.data.root ?? null;
  }

  claimRoot(identitySubject: string, email: string): RootClaim {
    const claim: RootClaim = { identitySubject, email, claimedAt: new Date().toISOString() };
    this.data.root = claim;
    this.persist();
    return claim;
  }

  orgs(): readonly HostedOrg[] {
    return this.data.orgs;
  }

  org(orgId: string): HostedOrg | undefined {
    return this.data.orgs.find((org) => org.id === orgId);
  }

  /** Orgs with their member counts, oldest first. */
  listOrgs(): HostedOrgSummary[] {
    return this.data.orgs.map((org) => ({ ...org, memberCount: this.listOrgMembers(org.id).length }));
  }

  /** Creates an org. Names are unique, ignoring case, so a listing is never ambiguous. */
  createOrg(name: string): HostedOrg {
    const clean = normalizeOrgName(name);
    this.assertOrgNameFree(clean);
    let id = newShortId(8);
    while (this.org(id)) {
      id = newShortId(8);
    }
    const org: HostedOrg = { id, name: clean, createdAt: new Date().toISOString() };
    this.data.orgs.push(org);
    this.persist();
    return org;
  }

  renameOrg(orgId: string, name: string): HostedOrg {
    const existing = this.org(orgId);
    if (!existing) {
      throw new OrgNotFoundError(orgId);
    }
    const clean = normalizeOrgName(name);
    this.assertOrgNameFree(clean, orgId);
    const renamed: HostedOrg = { ...existing, name: clean };
    this.data.orgs = this.data.orgs.map((org) => (org.id === orgId ? renamed : org));
    this.persist();
    return renamed;
  }

  /**
   * The org a duo belongs to: a tenant id, or `ROOT_DUO_ID` for the
   * pre-hosted root duo. Undefined for an id this registry does not know.
   */
  orgOf(duoId: string): HostedOrg | undefined {
    const orgId = duoId === ROOT_DUO_ID ? this.data.rootOrgId : this.data.tenants.find((tenant) => tenant.id === duoId)?.orgId;
    return orgId === undefined ? undefined : this.org(orgId);
  }

  /** The duos in an org. Throws OrgNotFoundError for an unknown org. */
  listOrgMembers(orgId: string): OrgMember[] {
    if (!this.org(orgId)) {
      throw new OrgNotFoundError(orgId);
    }
    const members: OrgMember[] = [];
    if (this.rootDuoName !== null && this.data.rootOrgId === orgId) {
      members.push({ duoId: ROOT_DUO_ID, name: this.rootDuoName, email: this.data.root?.email ?? null, isRoot: true, joinedAt: null });
    }
    for (const tenant of this.data.tenants) {
      if (tenant.orgId === orgId) {
        members.push({ duoId: tenant.id, name: tenant.name, email: tenant.email ?? null, isRoot: false, joinedAt: tenant.createdAt });
      }
    }
    return members;
  }

  private assertOrgNameFree(name: string, exceptOrgId?: string): void {
    const taken = this.data.orgs.some((org) => org.id !== exceptOrgId && org.name.toLowerCase() === name.toLowerCase());
    if (taken) {
      throw new OrgNameTakenError(name);
    }
  }

  tenantBySubject(identitySubject: string): HostedTenant | undefined {
    return this.data.tenants.find((tenant) => tenant.identitySubject === identitySubject);
  }

  passphraseFor(tenant: HostedTenant): string {
    return decrypt(Buffer.from(tenant.passphraseCipher, "base64"), this.masterKey).toString("utf8");
  }

  /** Mints an invite; the returned code is the only copy that will ever exist. */
  createInvite(
    name: string,
    expiresAt: string,
    email: string | null = null,
    orgId: string = DEFAULT_ORG_ID,
  ): { invite: HostedInvite; code: string } {
    if (!this.org(orgId)) {
      throw new OrgNotFoundError(orgId);
    }
    const code = randomBytes(24).toString("base64url");
    const invite: HostedInvite = {
      id: randomUUID(),
      name,
      codeHash: hashCode(code),
      createdAt: new Date().toISOString(),
      expiresAt,
      usedAt: null,
      tenantId: null,
      email,
      orgId,
    };
    this.data.invites.push(invite);
    this.persist();
    return { invite, code };
  }

  /** The invite a code redeems, if it is known, unused, and unexpired — compared in constant time. */
  findRedeemableInvite(code: string, now = Date.now()): HostedInvite {
    const candidate = Buffer.from(hashCode(code), "hex");
    const match = this.data.invites.find((invite) => timingSafeEqual(Buffer.from(invite.codeHash, "hex"), candidate));
    if (!match || match.usedAt !== null || Date.parse(match.expiresAt) <= now) {
      throw new InviteInvalidError();
    }
    return match;
  }

  /**
   * Records a new duo and marks its invite spent, in one write. The duo
   * joins the org its invite named. The caller has already created the
   * duo's store under `passphrase`.
   */
  addTenant(
    inviteId: string,
    name: string,
    passphrase: string,
    id = newShortId(10),
    identity: { identitySubject?: string; email?: string; isAdmin?: boolean } = {},
  ): HostedTenant {
    const orgId = this.data.invites.find((invite) => invite.id === inviteId)?.orgId ?? DEFAULT_ORG_ID;
    const tenant: HostedTenant = {
      id,
      orgId,
      name,
      createdAt: new Date().toISOString(),
      passphraseCipher: encrypt(Buffer.from(passphrase, "utf8"), this.masterKey).toString("base64"),
      ...identity,
    };
    this.data.tenants.push(tenant);
    this.data.invites = this.data.invites.map((invite) =>
      invite.id === inviteId ? { ...invite, usedAt: tenant.createdAt, tenantId: tenant.id } : invite,
    );
    this.persist();
    return tenant;
  }

  newTenantId(): string {
    let id = newShortId(10);
    while (this.data.tenants.some((tenant) => tenant.id === id)) {
      id = newShortId(10);
    }
    return id;
  }

  /** Write-then-rename, so a crash mid-write never leaves a truncated registry. */
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.registry-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
