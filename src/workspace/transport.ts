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
  /** User ids of the room's joined members, including the duo itself. */
  readonly joinedMemberIds: readonly string[];
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
