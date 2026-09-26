import type { HostedRegistry } from "./registry.js";
import { SynapseAdminError, type SynapseAdmin } from "./synapse-admin.js";

/**
 * A person's Matrix session for the signed-in app (docs/deploy/hosted-workspace.md §8, #233).
 *
 * The app has no homeserver form and no Matrix password to type: the daemon, which already knows
 * who the Google-signed-in caller is, mints an access token for THAT PERSON's own account through
 * Synapse's admin login API and hands it back with the public homeserver URL.
 *
 * Rules this module keeps, each with a test:
 *
 * - **Own account only.** The only input is a duo id the caller's device token proved; the account
 *   is the person id recorded for that duo. There is no path from a request field to a user id, and
 *   the duo's own token (`registry.duoMatrixToken`) is never read here.
 * - **Always expires.** Synapse's default is a token that never expires and the daemon cannot revoke
 *   one it did not keep, so every token gets `valid_until_ms` (`SESSION_LIFETIME_MS`). Sign-out is
 *   the client calling Matrix `/logout` with its own token; the expiry is the server-side bound.
 * - **Cheap to call.** A client loop must not mint without bound, so a token that still has at least
 *   `REUSE_MIN_REMAINING_MS` left is handed out again (kept in memory only, never written anywhere),
 *   which caps minting at one token per duo per `SESSION_LIFETIME_MS - REUSE_MIN_REMAINING_MS`
 *   (18h) plus one per daemon restart. Concurrent calls share one mint. A failed mint is
 *   remembered for `FAILURE_BACKOFF_MS`, so a Synapse that is down is asked once per backoff per
 *   duo and not once per request.
 * - **A signed-out token is not handed out again.** The daemon never learns that a client called
 *   Matrix `/logout`, so before reusing a token it asks Synapse (`whoami` as that token, a read) at
 *   most once per `VERIFY_TTL_MS`; a token Synapse no longer accepts is dropped and a new one is
 *   minted. If Synapse cannot be asked, the cached token is returned: it is probably fine, and a
 *   mint would fail too.
 * - **Nothing secret leaves by accident.** The token is in the returned session and the memory
 *   cache, nowhere else: not in a log line, an error or a thrown message.
 */

/** A minted token's life. Long enough that a client refreshes rarely, short enough that a leak is bounded (§7). */
export const SESSION_LIFETIME_MS = 24 * 3_600_000;
/** A cached token with less than this left is not handed out again; a new one is minted. Clients refresh within an hour of expiry, well inside it. */
export const REUSE_MIN_REMAINING_MS = 6 * 3_600_000;
/** After a failed mint the same duo gets the same answer for this long without another call to Synapse. */
export const FAILURE_BACKOFF_MS = 5_000;
/** A reused token is checked against Synapse at most this often, so a client that signed out and back in gets a fresh token within this window. */
export const VERIFY_TTL_MS = 5_000;

export interface WorkspaceSession {
  /** The address clients use (`DUO_WORKSPACE_PUBLIC_URL`), never the private one the daemon calls. */
  readonly homeserverUrl: string;
  /** The person's own account, `@<orgId>.<handle>:<server>`. */
  readonly userId: string;
  readonly accessToken: string;
  /** Admin-minted tokens have no device (§12); creating one is only needed for end-to-end encryption, which the POC does not use. */
  readonly deviceId: null;
  /** ISO 8601. The token stops working here; call again before it does. */
  readonly expiresAt: string;
}

export type SessionOutcome =
  | { readonly status: "ok"; readonly session: WorkspaceSession }
  /** The duo's accounts are not created yet (Synapse was down at sign-up, or provisioning is still running); the retry timer will get to it. */
  | { readonly status: "pending" }
  /** Synapse could not mint a token right now (down, slow, or refusing). Nothing in the registry is wrong. */
  | { readonly status: "unavailable" };

export interface WorkspaceSessionsOptions {
  readonly registry: HostedRegistry;
  readonly admin: Pick<SynapseAdmin, "mintToken" | "whoAmIAs">;
  /** `DUO_WORKSPACE_PUBLIC_URL`, without a trailing slash. */
  readonly publicUrl: string;
  /** One line per event: duo ids and scrubbed reasons only. Defaults to stderr. */
  readonly log?: (line: string) => void;
  /** Test seam. */
  readonly now?: () => number;
}

interface Cached {
  readonly userId: string;
  readonly accessToken: string;
  readonly expiresAtMs: number;
  /** When Synapse last confirmed the token still works. */
  readonly verifiedAtMs: number;
}

export class WorkspaceSessions {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<SessionOutcome>>();
  private readonly failedUntil = new Map<string, number>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceSessionsOptions) {
    this.log = options.log ?? ((line) => console.error(line));
    this.now = options.now ?? Date.now;
  }

  /** The session for `duoId`'s person. `duoId` must come from a verified credential, never from a request field. */
  sessionFor(duoId: string): Promise<SessionOutcome> {
    const accounts = this.options.registry.matrixAccounts(duoId);
    if (!accounts) {
      return Promise.resolve({ status: "pending" });
    }
    const { personUserId, duoUserId } = accounts;
    // Belt and braces: the person's id must not be the duo's, or the service account's, or a `duo-` account's.
    if (personUserId === duoUserId || /^@(duo-|workspace-admin:)/.test(personUserId)) {
      this.log(`hosted: refusing to mint a workspace session for duo ${duoId}: its recorded person account is not a person's`);
      return Promise.resolve({ status: "unavailable" });
    }

    const now = this.now();
    const cached = this.usable(duoId, personUserId, now);
    if (cached && now - cached.verifiedAtMs <= VERIFY_TTL_MS) {
      return Promise.resolve(this.ok(cached));
    }
    if (!cached && (this.failedUntil.get(duoId) ?? 0) > now) {
      return Promise.resolve({ status: "unavailable" });
    }
    const running = this.inflight.get(duoId);
    if (running) {
      return running;
    }
    const attempt = this.resolve(duoId, personUserId, cached).finally(() => this.inflight.delete(duoId));
    this.inflight.set(duoId, attempt);
    return attempt;
  }

  /** The cached token for this person if it has enough life left to hand out again. */
  private usable(duoId: string, personUserId: string, now: number): Cached | undefined {
    const cached = this.cache.get(duoId);
    return cached && cached.userId === personUserId && cached.expiresAtMs - now >= REUSE_MIN_REMAINING_MS ? cached : undefined;
  }

  private async resolve(duoId: string, personUserId: string, cached: Cached | undefined): Promise<SessionOutcome> {
    if (cached) {
      try {
        if ((await this.options.admin.whoAmIAs(cached.accessToken)) === personUserId) {
          const verified: Cached = { ...cached, verifiedAtMs: this.now() };
          this.cache.set(duoId, verified);
          return this.ok(verified);
        }
        // Synapse no longer accepts it: the client signed out (or it was revoked). Fall through to a new one.
        this.cache.delete(duoId);
      } catch {
        // Synapse cannot be asked right now; the token is probably fine and a mint would fail as well.
        return this.ok(cached);
      }
    }
    return this.mint(duoId, personUserId);
  }

  private async mint(duoId: string, personUserId: string): Promise<SessionOutcome> {
    const expiresAtMs = this.now() + SESSION_LIFETIME_MS;
    try {
      const accessToken = await this.options.admin.mintToken(personUserId, { validUntilMs: expiresAtMs });
      const minted: Cached = { userId: personUserId, accessToken, expiresAtMs, verifiedAtMs: this.now() };
      this.cache.set(duoId, minted);
      this.failedUntil.delete(duoId);
      this.log(`hosted: minted a workspace session for duo ${duoId}`);
      return this.ok(minted);
    } catch (error) {
      this.failedUntil.set(duoId, this.now() + FAILURE_BACKOFF_MS);
      // A SynapseAdminError message is already scrubbed (status and errcode only); anything else is logged by name.
      const reason = error instanceof SynapseAdminError ? error.message : `unexpected error (${error instanceof Error ? error.name : "error"})`;
      this.log(`hosted: could not mint a workspace session for duo ${duoId}: ${reason}`);
      return { status: "unavailable" };
    }
  }

  private ok(cached: Cached): SessionOutcome {
    return {
      status: "ok",
      session: {
        homeserverUrl: this.options.publicUrl,
        userId: cached.userId,
        accessToken: cached.accessToken,
        deviceId: null,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
      },
    };
  }
}
