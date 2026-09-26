import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decrypt, encrypt } from "../store/crypto.js";

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
  /** May mint invites from the app. */
  readonly isAdmin?: boolean;
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
}

interface RegistryFile {
  tenants: HostedTenant[];
  invites: HostedInvite[];
  root?: RootClaim | null;
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
function newTenantId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export class HostedRegistry {
  private data: RegistryFile;

  constructor(
    private readonly path: string,
    private readonly masterKey: string,
  ) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RegistryFile) : { tenants: [], invites: [] };
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

  tenantBySubject(identitySubject: string): HostedTenant | undefined {
    return this.data.tenants.find((tenant) => tenant.identitySubject === identitySubject);
  }

  passphraseFor(tenant: HostedTenant): string {
    return decrypt(Buffer.from(tenant.passphraseCipher, "base64"), this.masterKey).toString("utf8");
  }

  /** Mints an invite; the returned code is the only copy that will ever exist. */
  createInvite(name: string, expiresAt: string, email: string | null = null): { invite: HostedInvite; code: string } {
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
   * Records a new duo and marks its invite spent, in one write. The caller
   * has already created the duo's store under `passphrase`.
   */
  addTenant(
    inviteId: string,
    name: string,
    passphrase: string,
    id = newTenantId(),
    identity: { identitySubject?: string; email?: string; isAdmin?: boolean } = {},
  ): HostedTenant {
    const tenant: HostedTenant = {
      id,
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
    let id = newTenantId();
    while (this.data.tenants.some((tenant) => tenant.id === id)) {
      id = newTenantId();
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
