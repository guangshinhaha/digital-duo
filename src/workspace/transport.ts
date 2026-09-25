/**
 * #186: the outbound workspace connection's seam. Everything above this
 * interface (the service, the serve wiring, every test) is written against
 * these six operations and knows nothing about `matrix-js-sdk`; the one
 * implementation that does (`matrix-transport.ts`) is a thin adapter wired
 * in composition. The seam is Matrix-shaped on purpose — the platform
 * decision (docs/workspace-platform.md, MERGED) picked the protocol, so the
 * vocabulary is rooms, senders and user ids, and #189's message-store
 * contract inherits it rather than translating it.
 *
 * Direction is load-bearing: `connect` dials OUT and the connection is held.
 * Nothing in this interface — or anywhere in src/workspace/ — can listen for
 * an inbound connection (pinned by test/workspace-payload.test.ts's egress-
 * surface block, alongside the repo-wide egress scan).
 *
 * The duo's own user id is NOT seam state: it arrives in the settings both
 * sides already hold (settings.userId), and the one consumer — the direct-
 * question filter — reads it from there. An adapter that disagreed with its
 * own settings would be a bug, not a fallback.
 */
export interface WorkspaceTransport {
  /**
   * Dial out, authenticate, and resolve only once the first sync has
   * completed — i.e. when the room state the homeserver held for us,
   * including anything that arrived while we were away, has caught up. This
   * resolution point is what makes held-not-lost Matrix-native (#186 AC4):
   * the homeserver holds events for an offline user, sync replays them on
   * the next connect, and `onMessage` then delivers them exactly like live
   * ones. The daemon keeps no queue of its own to lose.
   */
  connect(): Promise<void>;

  /**
   * Reads the workspace's members from the homeserver over the held
   * connection (#187): stable ids, display names, and server-side presence
   * — the raw facts the directory is composed from (`directory.ts`). A
   * read, nothing more: nothing in this interface can create, modify, or
   * remove a workspace member (the no-provisioning principle, pinned by
   * test/workspace-payload.test.ts's scan), so a member joining the
   * workspace gets no duo from us and nobody else gets one either.
   *
   * `truncated` says the server capped the listing (`limited` in Matrix's
   * user-directory response): the members present are correct, the members
   * absent are unknown — surfaced rather than swallowed so a caller can
   * refuse to reason over a partial directory.
   */
  listMembers(): Promise<WorkspaceMemberListing>;

  /**
   * The identity-only half of the member read: same listing, no presence.
   * Presence on Matrix is one request per user (there is no bulk API), so
   * `listMembers` pays a fan-out this method skips — the asker feed's
   * connect-time refresh wants identity facts only and must not cost a
   * presence round-trip per workspace member on every reconnect.
   */
  listMemberIdentities(): Promise<WorkspaceMemberIdentityListing>;

  /** Stop the outbound connection. Idempotent; does not fire `onDisconnected`. */
  stop(): Promise<void>;

  /**
   * Posts the duo's answer as its own message (the duo's account is the
   * sender — protocol-level attribution, the decision record's §6) into the
   * room the question was asked in. The content is exactly what
   * `buildAnswerEvent` produced: nothing else in this codebase can put a
   * payload on the wire.
   */
  sendAnswer(roomId: string, content: AnswerEventContent): Promise<void>;

  /**
   * Reports liveness to the homeserver (Matrix presence/last-seen —
   * server-side state the daemon feeds, never local truth). Called on every
   * (re)connect and on an interval while connected, so "disconnected" has a
   * real timestamp the moment it stops being refreshed.
   */
  markAlive(): Promise<void>;

  /**
   * A text message arrived in a room the duo is in. Raw candidates, not
   * filtered questions — the policy for what counts as a question to THIS
   * duo (directQuestionFrom) lives in the service layer where it is tested;
   * the adapter only normalizes.
   */
  onMessage(handler: (message: WorkspaceCandidateMessage) => void): void;

  /**
   * The held outbound connection dropped and the SDK's own retries gave up.
   * The service answers this by re-dialing with backoff. Transient network
   * blips the SDK absorbs internally never reach here.
   */
  onDisconnected(handler: () => void): void;
}

/**
 * One normalized room message, before the question filter runs. Matrix
 * vocabulary (sender id, joined membership) surfaced deliberately: the
 * filter's "a direct question to the duo" judgment needs exactly these
 * facts and nothing else.
 */
export interface WorkspaceCandidateMessage {
  readonly eventId: string;
  readonly roomId: string;
  readonly senderId: string;
  readonly body: string;
  /**
   * The homeserver's epoch-millisecond timestamp for the event
   * (`origin_server_ts`) — server time, when it was actually sent, not when
   * the daemon happened to receive it (held questions arrive late by
   * design). #189's backlog age policy reads this: an event older than the
   * configured window is marked read, never answered.
   */
  readonly originServerTs: number;
  /** User ids of the room's joined members, including the duo itself. */
  readonly joinedMemberIds: readonly string[];
}

/**
 * #187: one workspace user's presence as the homeserver knows it —
 * server-side state, never daemon-local truth. Raw on purpose: `lastActiveAgoMs`
 * stays relative (the server's clock, not ours) so the seam carries facts and
 * the composer (`directory.ts`) does the one clock conversion. Null when the
 * server has never seen the user active — a fact missing is a fact missing.
 */
export interface WorkspacePresence {
  /** Whether the user has a live connection reporting liveness ("online" server-side). */
  readonly online: boolean;
  /** How long ago, in ms, the user was last seen — null when the server has never seen them. */
  readonly lastActiveAgoMs: number | null;
}

/**
 * #187: one member of the workspace as read from the homeserver. The Matrix
 * user id is the stable id — the protocol's own, never reassigned; the display
 * name is the profile's, falling back to the localpart when none is set (the
 * adapter normalizes; the composer trusts it). People and duo users both
 * appear here; which is which, and whose duo is whose, is `directory.ts`'s
 * derivation over the `@duo-<name>` convention.
 */
export interface WorkspaceMemberIdentity {
  readonly userId: string;
  readonly displayName: string;
}

export interface WorkspaceMember extends WorkspaceMemberIdentity {
  readonly presence: WorkspacePresence;
}

/** The raw result of one member read: the members the server returned, and whether it capped the listing. */
export interface WorkspaceMemberListing {
  readonly members: readonly WorkspaceMember[];
  readonly truncated: boolean;
}

/** The identity-only member read's result — same shape, no presence facts. */
export interface WorkspaceMemberIdentityListing {
  readonly members: readonly WorkspaceMemberIdentity[];
  readonly truncated: boolean;
}

/**
 * #187 (from #219's successor notes): the homeserver rejected the duo's
 * access token — Matrix `M_UNKNOWN_TOKEN`, i.e. the token was revoked or
 * replaced, which no retry can fix. Adapters throw this (the Matrix adapter
 * recognizes the errcode on its connect-failure paths); the service answers
 * it by stopping the retry loop and recording the terminal `revoked` phase
 * rather than dialing a dead credential forever. The fix is re-pairing on
 * the owner's machine — the only place duo credentials are ever created
 * (docs/workspace-platform.md §6).
 */
export class WorkspaceTokenRevokedError extends Error {
  constructor(detail: string) {
    // `detail` is homeserver-controlled text whose only destination is the
    // owner-side console (service logs the error): control characters are
    // stripped and the length capped, so a hostile or compromised
    // homeserver can neither paint the terminal nor launder anything long
    // through this message. It cannot echo the access token — the server
    // knows it, but this string is its error text, not our credential.
    const safeDetail = detail.replace(/\p{C}/gu, "").slice(0, 300);
    super(`The workspace homeserver rejected the duo's access token (M_UNKNOWN_TOKEN): ${safeDetail}`);
    this.name = "WorkspaceTokenRevokedError";
  }
}

/** A question that passed the direct-question filter, ready for the answering pipeline. */
export interface WorkspaceQuestion {
  readonly eventId: string;
  readonly roomId: string;
  readonly senderId: string;
  readonly body: string;
  /** ISO-8601 instant the question reached the daemon (not the homeserver's event timestamp — held questions arrive late by design). */
  readonly receivedAt: string;
}

/**
 * The one outbound payload shape (#186 AC5): the answer event's content is
 * `{ msgtype: "m.text", body }` and nothing else — `body` carries the
 * asker-visible answer text exactly as `POST /ask` projects it. The type is
 * the contract; `buildAnswerEvent` (payload.ts) is its only constructor and
 * the boundary test pins that no other field can appear.
 */
export interface AnswerEventContent {
  readonly msgtype: "m.text";
  readonly body: string;
}

/**
 * Builds the transport for validated settings. Async-tolerant so the default
 * (commands/serve.ts) can lazily `import()` the matrix-js-sdk adapter — a
 * daemon with no workspace configured never loads the SDK at all — while
 * tests hand in a sync fake without wrapping it.
 */
export type WorkspaceTransportFactory = (settings: import("./settings.js").WorkspaceSettings) => WorkspaceTransport | Promise<WorkspaceTransport>;
