import type { WorkspaceMember, WorkspaceMemberListing, WorkspacePresence } from "./transport.js";

/**
 * #187: the workspace directory, composed — not stored. Every fact arrives
 * from the homeserver over the transport seam (`listMembers`); this module's
 * whole job is to derive the one thing the homeserver does not state
 * outright — whose duo is whose — and to put presence into the availability
 * vocabulary `docs/workspace/asleep-duo.md` §6 fixes:
 *
 * - **A duo's availability is the state of its daemon's outbound
 *   connection**: `online` while live, `offline` with a last-seen time
 *   otherwise. Server-side, that is exactly the duo user's presence — fed by
 *   the daemon's own `markAlive` (#186), so what the directory reads for a
 *   duo IS its connection state as the message router knows it.
 * - **It says nothing about the owner's presence.** A person's availability
 *   and their duo's are two separate fields on one entry, neither implying
 *   the other: a person can be online while their duo is asleep, and a duo
 *   can be online while its owner is away.
 *
 * **Attribution is derived, not registered.** The platform decision
 * (`docs/workspace-platform.md` §6) already fixes a duo's Matrix user id as
 * `@duo-<owner-localpart>:<server>` beside the owner's `@<owner-localpart>`:
 * the duo's identity is structural, so the owner↔duo linkage needs no second
 * registry, no mapping file, and no synchronization — `duoUserIdFor` and its
 * inverse are pure string derivations over that convention, and the mapping
 * is a function from duo ids to their one owner (two owners cannot contest
 * one duo); an owner may hold a personal duo and up to five desk duos
 * (`@duo-<owner>.<desk>`). The cost of deriving instead of
 * registering is that the `duo-` localpart namespace is reserved by the
 * convention: a person whose localpart starts with `duo-` is
 * indistinguishable from a duo and the directory says so by exclusion — on a
 * homeserver run per the platform record, that namespace is not people's.
 */

/** The localpart prefix that marks a Matrix user as a duo (`docs/workspace-platform.md` §6). */
export const DUO_LOCALPART_PREFIX = "duo-";

/** The shaped id this module derives over: `@localpart:server` with both parts non-empty. */
const USER_ID_PATTERN = /^@([^:]+):(.+)$/;
/** The looser form asker lookup keys extract from: `@localpart:` with any (even empty) tail. */
const LOCALPART_PATTERN = /^@([^:]+):/;

/**
 * The localpart of a Matrix user id — `@alice:workspace` → `alice`, the
 * natural key against `duo/directory.json`'s hand-maintained ids. Anything
 * that isn't `@local:domain` shaped is returned unchanged so it simply
 * fails to resolve (the safe default), rather than crashing the ask.
 *
 * Two grammars on purpose: this one is deliberately looser than
 * `USER_ID_PATTERN` (`@alice:` still yields `alice` exactly as #219
 * shipped it — a degradation, never a behavior change), while the strict
 * pattern governs duo-convention derivation, where a serverless id has no
 * convention to derive. This module is the workspace's user-id grammar
 * owner: the adapter and the asker mapping import from here rather than
 * re-deriving it.
 */
export function localpartOf(userId: string): string {
  const match = LOCALPART_PATTERN.exec(userId);
  return match ? match[1]! : userId;
}

/** Whether a Matrix user id is duo-shaped under the platform record's convention (`@duo-…:…`). */
export function isDuoUserId(userId: string): boolean {
  return duoOwnerUserIdOf(userId) !== null;
}

/**
 * The duo user id the convention assigns a person: `@alice:workspace` →
 * `@duo-alice:workspace`. Null when the id isn't `@local:server` shaped
 * (nothing to derive from; the caller treats it as "no duo addable").
 */
export function duoUserIdFor(personUserId: string): string | null {
  const match = USER_ID_PATTERN.exec(personUserId);
  return match ? `@${DUO_LOCALPART_PREFIX}${match[1]}:${match[2]}` : null;
}

/**
 * The owner user id a duo-shaped id points back at: `@duo-alice:workspace`
 * → `@alice:workspace`. Null for non-duo-shaped or unshapely ids — a plain
 * person (or garbage) has no owner to name.
 */
export function duoOwnerUserIdOf(duoUserId: string): string | null {
  const match = USER_ID_PATTERN.exec(duoUserId);
  if (!match || !match[1]!.startsWith(DUO_LOCALPART_PREFIX)) {
    return null;
  }
  return `@${match[1]!.slice(DUO_LOCALPART_PREFIX.length)}:${match[2]}`;
}

/** #187's availability, in exactly asleep-duo.md §6's shape. */
export interface WorkspaceAvailability {
  /** The connection is live. When this is true there is no last-seen to state — "online" is the whole fact. */
  readonly online: boolean;
  /** ISO-8601 instant the connection was last seen live — present only when offline, null when never seen. */
  readonly lastSeenAt: string | null;
}

/** A member's duo, when one exists: addressable as its own Matrix user, attributed to exactly that member. */
export interface WorkspaceDuoRef {
  readonly userId: string;
  readonly displayName: string;
  readonly availability: WorkspaceAvailability;
}

/** One person in the workspace directory (#187 AC1/AC2). */
export interface WorkspaceDirectoryEntry {
  /**
   * The stable id: the Matrix user id, the protocol's own and never
   * reassigned — the ONLY field to key on. A display name (here or on the
   * attached duo) is a profile's claim about itself, self-service and
   * spoofable; #192's consumers must label by userId and render names as
   * claims, never match by them.
   */
  readonly userId: string;
  readonly displayName: string;
  /** The person's own availability — their client's connection, a fact independent of their duo's. */
  readonly availability: WorkspaceAvailability;
  /** Their duo, when a duo-shaped user matching the convention is listed; null when they have none. */
  readonly duo: WorkspaceDuoRef | null;
}

/**
 * Server-side presence → §6 availability. `online` passes through (a live
 * connection needs no last-seen); offline turns the server's relative
 * `lastActiveAgoMs` into an absolute instant using `now` — the one clock
 * conversion in the module, injected so tests hold it still. A user the
 * server has never seen active is offline with no last-seen: stated, not
 * guessed.
 */
export function availabilityFrom(presence: WorkspacePresence, now: () => Date = () => new Date()): WorkspaceAvailability {
  if (presence.online) {
    return { online: true, lastSeenAt: null };
  }
  return {
    online: false,
    lastSeenAt: presence.lastActiveAgoMs === null ? null : new Date(now().getTime() - presence.lastActiveAgoMs).toISOString(),
  };
}

/**
 * Composes the workspace directory from a member listing: one entry per
 * person (non-duo-shaped localpart), each with the member's own availability
 * and — attached, not merged — their duo when the convention's duo user id is
 * in the listing, carrying the duo's own display name and availability.
 *
 * Duo-shaped users never appear as people, and a duo-shaped user whose owner
 * is not in the listing is attributable to no one: it is dropped rather than
 * guessed at ("attributed unambiguously to exactly one person" has no
 * honest answer for zero or two, and the convention gives exactly one or
 * zero). Order is the listing's.
 */
export function workspaceDirectoryFrom(listing: WorkspaceMemberListing, now: () => Date = () => new Date()): readonly WorkspaceDirectoryEntry[] {
  const membersById = new Map(listing.members.map((member) => [member.userId, member]));
  return listing.members
    .filter((member) => !isDuoUserId(member.userId))
    .map((person) => {
      const duoId = duoUserIdFor(person.userId);
      const duo = duoId === null ? undefined : membersById.get(duoId);
      return {
        userId: person.userId,
        displayName: person.displayName,
        availability: availabilityFrom(person.presence, now),
        duo: duo
          ? { userId: duo.userId, displayName: duo.displayName, availability: availabilityFrom(duo.presence, now) }
          : null,
      };
    });
}
