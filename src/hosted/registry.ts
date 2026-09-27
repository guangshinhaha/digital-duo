import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decrypt, encrypt } from "../store/crypto.js";
import {
  assertOrgId,
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

/**
 * A duo's Matrix accounts on the shared Synapse (docs/deploy/hosted-workspace.md §3, §4).
 * Written once, when provisioning succeeds; the ids are a copy of the org taken at that time.
 * The duo's access token is a credential: it lives here only as ciphertext under the master key
 * and `HostedRegistry.duoMatrixToken` is the one way to read it.
 */
export interface HostedMatrixAccounts {
  /** `@<orgId>.<handle>:<server>`. */
  readonly personUserId: string;
  /** `@duo-<orgId>.<handle>:<server>`, always `duoUserIdFor(personUserId)`. */
  readonly duoUserId: string;
  /** base64 of encrypt(duoAccessToken, masterKey), like `passphraseCipher`. Never leaves the daemon. */
  readonly duoTokenCipher: string;
  readonly provisionedAt: string;
}

/** What is safe to show an admin about a duo's accounts: no token, not even its ciphertext. */
export type HostedMatrixAccountsView = Omit<HostedMatrixAccounts, "duoTokenCipher">;

/** A duo whose accounts could not be created yet. Present only while pending; success clears it. */
export interface MatrixPending {
  readonly since: string;
  readonly attempts: number;
  readonly lastAttemptAt: string;
  /** A scrubbed reason (status and Matrix errcode, never a body or a secret). */
  readonly lastError: string;
}

/**
 * Which org rooms a duo's two accounts have been put into (#234). Written when both the person and
 * the duo are in the Space and `#general`; the ids say which rooms, so a member recorded against a
 * room that is no longer their org's is seen as not joined.
 */
export interface HostedMatrixSpaces {
  readonly spaceRoomId: string;
  readonly generalRoomId: string;
  readonly joinedAt: string;
}

export function matrixAccountsView(accounts: HostedMatrixAccounts): HostedMatrixAccountsView {
  const { duoTokenCipher: _cipher, ...view } = accounts;
  return view;
}

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
  /** Set once the duo's Matrix accounts exist (#232). Absent means not provisioned yet. */
  readonly matrix?: HostedMatrixAccounts;
  /** Set while provisioning is owed and failing, so an outage is visible and retried. */
  readonly matrixPending?: MatrixPending;
  /** Set once the person and the duo are in their org's Space and `#general` (#234). */
  readonly matrixSpaces?: HostedMatrixSpaces;
  /** Set while joining the org's rooms is owed and failing. */
  readonly spacePending?: MatrixPending;
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
  /** Present once a server has served the pre-hosted root duo: makes it a member of `rootOrgId` without depending on any server having started since. */
  rootDuo?: { name: string } | null;
  /** The root duo's Matrix accounts (handle `root`). Top level, not on `RootClaim`: the root duo needs accounts before any admin has claimed it. */
  rootMatrix?: HostedMatrixAccounts;
  rootMatrixPending?: MatrixPending;
  /** The root duo's accounts' membership of its org's rooms (#234), and why it is owed. */
  rootMatrixSpaces?: HostedMatrixSpaces;
  rootSpacePending?: MatrixPending;
}

/**
 * Brings a parsed registry file up to the current version, in memory. Lazy:
 * nothing is written until the registry next persists, so starting the
 * server never rewrites the file, and migrating the same file twice gives
 * the same result (the default org has a fixed id).
 *
 * v1 (no `version`, no orgs): a default org is created and every tenant,
 * invite and the root duo go into it, so no id, URL or pairing changes.
 *
 * The per-record defaulting runs on every load, not only for v1: a
 * pre-orgs build that is started again on a v2 file (a rollback) writes
 * tenants and invites with no `orgId`, and nothing else would repair them.
 * Existing orgs are kept, and every org id must be valid (`assertOrgId`),
 * so a hand-edited id fails loudly here rather than after accounts exist.
 */
export function migrateRegistryFile(raw: unknown, now = new Date().toISOString()): { data: RegistryFile; migrated: boolean } {
  const file = (raw ?? {}) as Partial<RegistryFile>;
  if (file.version !== undefined && file.version > REGISTRY_VERSION) {
    throw new RegistryVersionError(file.version);
  }
  const tenants = file.tenants ?? [];
  const oldest = tenants.map((tenant) => tenant.createdAt).sort()[0] ?? now;
  const orgs = file.orgs?.length ? file.orgs : [{ id: DEFAULT_ORG_ID, name: DEFAULT_ORG_NAME, createdAt: oldest }];
  orgs.forEach((org) => assertOrgId(org.id));
  return {
    migrated: (file.version ?? 1) < REGISTRY_VERSION,
    data: {
      ...file,
      version: REGISTRY_VERSION,
      orgs,
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
  /** True while the file on disk is still a pre-orgs (v1) one, so the first write keeps a copy of it. */
  private backupBeforeWrite: boolean;
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly path: string,
    private readonly masterKey: string,
  ) {
    const loaded = migrateRegistryFile(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
    this.data = loaded.data;
    this.backupBeforeWrite = loaded.migrated;
  }

  /**
   * Records that a pre-hosted root duo is being served, so it is a member of
   * its org. Persisted (only when it changes), so `listOrgMembers` does not
   * depend on a server having called this since the registry was loaded.
   */
  declareRootDuo(name: string): void {
    if (this.data.rootDuo?.name !== name) {
      this.commit((draft) => {
        draft.rootDuo = { name };
      });
    }
  }

  /**
   * Calls `listener` after every write that lands (never for a write that fails), so something that
   * follows the registry (a duo's workspace connection, #236) hears of a new duo, new accounts or a
   * re-minted token without every writer knowing about it. The listener runs synchronously inside the
   * write's caller, so it must be cheap and must not throw (one that does is ignored). Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
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
    return this.commit((draft) => {
      draft.root = claim;
      return claim;
    });
  }

  /** Keeps the claim's email in step with the verified sign-in of the account that holds it; writes only on change. */
  refreshRootEmail(identitySubject: string, email: string): void {
    const claim = this.data.root;
    if (claim && claim.identitySubject === identitySubject && claim.email !== email) {
      this.commit((draft) => {
        draft.root = { ...claim, email };
      });
    }
  }

  /** Keeps a duo's stored email in step with its owner's verified sign-in; writes only on change. Returns the current record. */
  refreshTenantEmail(tenantId: string, email: string): HostedTenant | undefined {
    const tenant = this.data.tenants.find((candidate) => candidate.id === tenantId);
    if (!tenant || tenant.email === email) {
      return tenant;
    }
    const updated: HostedTenant = { ...tenant, email };
    this.commit((draft) => {
      draft.tenants = draft.tenants.map((candidate) => (candidate.id === tenantId ? updated : candidate));
    });
    return updated;
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
    assertOrgId(id);
    const org: HostedOrg = { id, name: clean, createdAt: new Date().toISOString() };
    return this.commit((draft) => {
      draft.orgs.push(org);
      return org;
    });
  }

  renameOrg(orgId: string, name: string): HostedOrg {
    const existing = this.org(orgId);
    if (!existing) {
      throw new OrgNotFoundError(orgId);
    }
    const clean = normalizeOrgName(name);
    this.assertOrgNameFree(clean, orgId);
    const renamed: HostedOrg = { ...existing, name: clean };
    return this.commit((draft) => {
      draft.orgs = draft.orgs.map((org) => (org.id === orgId ? renamed : org));
      return renamed;
    });
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
    if (this.data.rootDuo && this.data.rootOrgId === orgId) {
      members.push({ duoId: ROOT_DUO_ID, name: this.data.rootDuo.name, email: this.data.root?.email ?? null, isRoot: true, joinedAt: null });
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

  /** A duo's Matrix accounts (no token); `duoId` is a tenant id or `ROOT_DUO_ID`. */
  matrixAccounts(duoId: string): HostedMatrixAccounts | undefined {
    return duoId === ROOT_DUO_ID ? this.data.rootMatrix : this.data.tenants.find((tenant) => tenant.id === duoId)?.matrix;
  }

  /** Why a duo's accounts are still owed, or undefined when it is provisioned or nothing has been tried. */
  matrixPending(duoId: string): MatrixPending | undefined {
    return duoId === ROOT_DUO_ID ? this.data.rootMatrixPending : this.data.tenants.find((tenant) => tenant.id === duoId)?.matrixPending;
  }

  /**
   * The duo's Matrix access token, decrypted. The only reader of it: for the
   * daemon's own connection for that duo (#236), never for a route response,
   * a log line or a duo's env.
   */
  duoMatrixToken(duoId: string): string | undefined {
    const accounts = this.matrixAccounts(duoId);
    return accounts && decrypt(Buffer.from(accounts.duoTokenCipher, "base64"), this.masterKey).toString("utf8");
  }

  /** Records a duo's provisioned accounts and encrypts its token in the same write; clears any pending mark. */
  setMatrixAccounts(duoId: string, ids: { personUserId: string; duoUserId: string }, duoAccessToken: string): HostedMatrixAccountsView {
    const accounts: HostedMatrixAccounts = {
      ...ids,
      duoTokenCipher: encrypt(Buffer.from(duoAccessToken, "utf8"), this.masterKey).toString("base64"),
      provisionedAt: new Date().toISOString(),
    };
    this.commit((draft) => {
      if (duoId === ROOT_DUO_ID) {
        draft.rootMatrix = accounts;
        delete draft.rootMatrixPending;
        return;
      }
      if (!draft.tenants.some((candidate) => candidate.id === duoId)) {
        throw new Error(`No duo "${duoId}" to record Matrix accounts for.`);
      }
      draft.tenants = draft.tenants.map((candidate) => {
        const { matrixPending: _cleared, ...rest } = candidate;
        return candidate.id === duoId ? { ...rest, matrix: accounts } : candidate;
      });
    });
    return matrixAccountsView(accounts);
  }

  /** Marks a duo as owed accounts and failing, keeping when it started and counting attempts. */
  recordMatrixFailure(duoId: string, reason: string): MatrixPending {
    const now = new Date().toISOString();
    const previous = this.matrixPending(duoId);
    const pending: MatrixPending = { since: previous?.since ?? now, attempts: (previous?.attempts ?? 0) + 1, lastAttemptAt: now, lastError: reason };
    this.commit((draft) => {
      if (duoId === ROOT_DUO_ID) {
        draft.rootMatrixPending = pending;
        return;
      }
      if (!draft.tenants.some((candidate) => candidate.id === duoId)) {
        throw new Error(`No duo "${duoId}" to record a provisioning failure for.`);
      }
      draft.tenants = draft.tenants.map((candidate) => (candidate.id === duoId ? { ...candidate, matrixPending: pending } : candidate));
    });
    return pending;
  }

  /** The org rooms a duo's accounts are in (#234), or undefined when they are still owed. */
  matrixSpaces(duoId: string): HostedMatrixSpaces | undefined {
    return duoId === ROOT_DUO_ID ? this.data.rootMatrixSpaces : this.data.tenants.find((tenant) => tenant.id === duoId)?.matrixSpaces;
  }

  /** Why a duo's room joins are still owed, or undefined when done or not yet tried. */
  spacePending(duoId: string): MatrixPending | undefined {
    return duoId === ROOT_DUO_ID ? this.data.rootSpacePending : this.data.tenants.find((tenant) => tenant.id === duoId)?.spacePending;
  }

  /** Records that a duo's person and duo accounts are in these rooms; clears any pending mark. */
  setMatrixSpaces(duoId: string, rooms: { spaceRoomId: string; generalRoomId: string }): HostedMatrixSpaces {
    const spaces: HostedMatrixSpaces = { ...rooms, joinedAt: new Date().toISOString() };
    this.commit((draft) => {
      if (duoId === ROOT_DUO_ID) {
        draft.rootMatrixSpaces = spaces;
        delete draft.rootSpacePending;
        return;
      }
      if (!draft.tenants.some((candidate) => candidate.id === duoId)) {
        throw new Error(`No duo "${duoId}" to record org rooms for.`);
      }
      draft.tenants = draft.tenants.map((candidate) => {
        const { spacePending: _cleared, ...rest } = candidate;
        return candidate.id === duoId ? { ...rest, matrixSpaces: spaces } : candidate;
      });
    });
    return spaces;
  }

  /** Marks a duo's room joins as owed and failing, keeping when it started and counting attempts. */
  recordSpaceFailure(duoId: string, reason: string): MatrixPending {
    const pending = this.nextPending(this.spacePending(duoId), reason);
    this.commit((draft) => {
      if (duoId === ROOT_DUO_ID) {
        draft.rootSpacePending = pending;
        return;
      }
      if (!draft.tenants.some((candidate) => candidate.id === duoId)) {
        throw new Error(`No duo "${duoId}" to record a room-join failure for.`);
      }
      draft.tenants = draft.tenants.map((candidate) => (candidate.id === duoId ? { ...candidate, spacePending: pending } : candidate));
    });
    return pending;
  }

  /**
   * Records progress on an org's Space, `#general` and their link, merging into the org in one write.
   * Progress is recorded step by step so a run that dies half way is finished, not redone: a room
   * that exists is never created twice.
   */
  updateOrgSpace(
    orgId: string,
    patch: { spaceRoomId?: string; generalRoomId?: string; spaceSyncedName?: string; generalLinked?: boolean },
  ): HostedOrg {
    return this.commit((draft) => {
      const org = draft.orgs.find((candidate) => candidate.id === orgId);
      if (!org) {
        throw new OrgNotFoundError(orgId);
      }
      const updated: HostedOrg = { ...org, ...patch };
      draft.orgs = draft.orgs.map((candidate) => (candidate.id === orgId ? updated : candidate));
      return updated;
    });
  }

  /** Clears an org's pending mark: its rooms exist, are linked and carry its current name. */
  clearOrgSpacePending(orgId: string): void {
    if (this.org(orgId)?.spacePending === undefined) {
      return;
    }
    this.commit((draft) => {
      draft.orgs = draft.orgs.map((org) => {
        const { spacePending: _cleared, ...rest } = org;
        return org.id === orgId ? rest : org;
      });
    });
  }

  /** Marks an org's rooms as owed and failing. */
  recordOrgSpaceFailure(orgId: string, reason: string): MatrixPending {
    const existing = this.org(orgId);
    if (!existing) {
      throw new OrgNotFoundError(orgId);
    }
    const pending = this.nextPending(existing.spacePending, reason);
    this.commit((draft) => {
      draft.orgs = draft.orgs.map((org) => (org.id === orgId ? { ...org, spacePending: pending } : org));
    });
    return pending;
  }

  private nextPending(previous: MatrixPending | undefined, reason: string): MatrixPending {
    const now = new Date().toISOString();
    return { since: previous?.since ?? now, attempts: (previous?.attempts ?? 0) + 1, lastAttemptAt: now, lastError: reason };
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
    this.commit((draft) => {
      draft.invites.push(invite);
    });
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
    return this.commit((draft) => {
      draft.tenants.push(tenant);
      draft.invites = draft.invites.map((invite) => (invite.id === inviteId ? { ...invite, usedAt: tenant.createdAt, tenantId: tenant.id } : invite));
      return tenant;
    });
  }

  newTenantId(): string {
    let id = newShortId(10);
    while (this.data.tenants.some((tenant) => tenant.id === id)) {
      id = newShortId(10);
    }
    return id;
  }

  /**
   * Applies a change to a copy of the registry and writes it; the copy
   * becomes the live data only once the write has succeeded. A write that
   * throws (disk full, a read-only volume) therefore leaves memory as it was,
   * matching the file, instead of showing an org or duo that a restart drops.
   */
  private commit<T>(change: (draft: RegistryFile) => T): T {
    const draft = structuredClone(this.data);
    const result = change(draft);
    this.persist(draft);
    this.data = draft;
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // A follower's trouble is never the writer's.
      }
    }
    return result;
  }

  /**
   * Write-then-rename, so a crash mid-write never leaves a truncated
   * registry. The first write after converting a v1 file keeps the original
   * beside it as `registry.json.v1.bak` (never overwriting an existing one),
   * so a bad migration has a way back.
   */
  private persist(data: RegistryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const backup = `${this.path}.v1.bak`;
    if (this.backupBeforeWrite && existsSync(this.path) && !existsSync(backup)) {
      copyFileSync(this.path, backup);
    }
    const tmp = join(dirname(this.path), `.registry-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.backupBeforeWrite = false;
  }
}
