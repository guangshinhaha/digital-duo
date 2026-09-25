/**
 * #186: the outbound workspace connection's seam. Everything above this
 * interface (the service, the serve wiring, every test) is written against
 * these operations and knows nothing about `matrix-js-sdk`; the one
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
 *
 * #192 adds the room-membership operations consent is built from — `onInvite`
 * (someone else's room add reaching this account; held for the owner's
 * decision, never auto-joined), `joinRoom` and `leaveRoom` (the mechanical
 * consequences of an allow and of a refusal/withdrawal; on Matrix a leave is
 * also how an invite is rejected). The invite shape itself is the message
 * contract's own `RoomInvite` (messages.ts) — imported type-only below so the
 * seam and the contract cannot drift apart on what an invitation is.
 */
import type { RoomInvite } from "./messages.js";

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
   * #190: reads one file's bytes over the held connection, as the duo's own
   * user — Matrix authenticated media (MSC3916): the homeserver serves media
   * only to requests carrying an access token, never anonymously. The read
   * is cut at `maxBytes` on purpose: the grounding door's size limit
   * (docs/workspace/attachments.md §7) is a bound on what may ENTER the
   * daemon, so a body longer than the bound is reported (`exceededMaxBytes`)
   * rather than transferred whole and trimmed after the fact. This is the
   * only seam operation that moves file bytes, and it moves them in one
   * direction only: workspace → daemon. Nothing here can upload, republish,
   * or re-serve a member's file.
   */
  fetchFile(reference: string, options: { readonly maxBytes: number }): Promise<WorkspaceFileBody>;

  /**
   * The held outbound connection dropped and the SDK's own retries gave up.
   * The service answers this by re-dialing with backoff. Transient network
   * blips the SDK absorbs internally never reach here.
   */
  onDisconnected(handler: () => void): void;

  /**
   * #192: an invitation to this account arrived — someone else's act of
   * adding the duo to a room, live or replayed by the sync catch-up that
   * `connect()` resolves on (an invite held while the Mac slept surfaces on
   * wake, the same held-not-lost recovery a question gets). Delivered as a
   * fact, nothing more: the seam has no join-on-invite, and nothing above
   * it may build one — the duo joins only on its owner's explicit allow,
   * recorded through the consent surface (consent.ts). A repeated delivery
   * of a still-live invite (sync replays it until it is joined or left) is
   * the caller's to dedupe by room id.
   */
  onInvite(handler: (invite: RoomInvite) => void): void;

  /**
   * Joins the room — the mechanical half of the owner's allow (#192). Only
   * the consented path calls this; it is the sole join primitive in
   * `src/workspace/`, so "a duo is never conscripted into a room" is
   * structural: no other code path can put the duo in a room. Resolves when
   * the homeserver accepts the membership.
   */
  joinRoom(roomId: string): Promise<void>;

  /**
   * Leaves the room — the mechanical half of a refusal (on Matrix, leaving
   * is how an invite is rejected: the homeserver drops it and stops
   * replaying it in sync) and of a withdrawal (#192). Resolves when the
   * homeserver accepts the exit.
   */
  leaveRoom(roomId: string): Promise<void>;
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
  /**
   * #190: the file attachments riding this question — the sender's
   * contiguous run of file messages (`m.file`/`m.image`) immediately
   * preceding it in the same room (see the adapter). Absent on the
   * pre-#190 wire shape and on every text question with no preceding
   * files; the adapter only sets it when the run is non-empty.
   */
  readonly attachments?: readonly WorkspaceFileReference[];
}

/**
 * #190: one file as it rode a message — the asker-visible facts (name,
 * declared type, declared size) plus the one thing the duo's side needs:
 * the stable content reference (`mxc://…`) the homeserver issued at upload.
 * The reference is the file's address for as long as the file exists —
 * deleted files stop dereferencing (the door treats that as a recoverable
 * failure, it does not guess content), and #183 §8's contract dependency
 * is satisfied by this shape: the reference is what a draft's attachment
 * source carries as its `id`, and any member of the conversation can
 * dereference it themselves through authenticated media.
 */
export interface WorkspaceFileReference {
  /** The Matrix content URI (`mxc://server/mediaId`) — stable, unique per upload. */
  readonly reference: string;
  /** The filename as sent (the event's `filename`, falling back to its `body`). */
  readonly name: string;
  /**
   * The declared MIME type (`info.mimetype`). Null when the sending client
   * didn't declare one — the door refuses undeclared types rather than
   * guess. An `m.image` with no declared type reads as `"image/*"`.
   */
  readonly mimeType: string | null;
  /** The declared size in bytes (`info.size`), checked before the body is read. Null when undeclared. */
  readonly size: number | null;
}

/** The bytes `fetchFile` returned: at most `maxBytes` long, and whether the body exceeded the bound. */
export interface WorkspaceFileBody {
  readonly bytes: Uint8Array;
  readonly exceededMaxBytes: boolean;
}

/** `fetchFile` as a standalone function — the door takes this so the service can hand it the live transport. */
export type WorkspaceFileFetcher = (reference: string, options: { readonly maxBytes: number }) => Promise<WorkspaceFileBody>;

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
  /**
   * #190: the file attachments riding the question (from the candidate —
   * normalized to an empty list when none rode it). Raw references only:
   * whether any of them may ground a draft is the attachment door's
   * decision, never the question filter's.
   */
  readonly attachments: readonly WorkspaceFileReference[];
  /**
   * #190: the attachments that passed the grounding door — stripped,
   * in-memory text plus the reference it rode in on. Set by the service
   * (the door's caller) right before the answering pipeline runs, so the
   * pipeline receives provided grounding without ever touching the seam or
   * the raw bytes. Never persisted on the question: it exists for the one
   * draft call and then is gone (#183 §3 — bytes live in daemon memory for
   * exactly one draft call).
   */
  readonly grounding?: readonly WorkspaceGroundedAttachment[];
}

/**
 * #190: one attachment that passed the grounding door — the door's output,
 * consumed by the draft pipeline as provided material. `text` is decoded
 * and already marking-stripped (the door strips once, at the boundary, so
 * no downstream echo — source label, extractive quote, provider prompt —
 * can repeat a marking line it never received). It is kin to a rule hit,
 * not retrieved evidence (#183 §3): it counts as grounding for the
 * pipeline's no-evidence gate but contributes nothing to retrieval-honest
 * confidence.
 */
export interface WorkspaceGroundedAttachment {
  /** The stable file reference — becomes the attachment DraftSource's `id` verbatim (#183 §8). */
  readonly reference: string;
  readonly name: string;
  readonly mimeType: string;
  /** Decoded, marking-stripped text. In memory for the one draft call only — never written to disk. */
  readonly text: string;
}

/**
 * The door's verdict for one question's attachments: either the question
 * grounds (and the refusal never happened), or it is refused with a
 * message that names the limit it broke — the count, the type, the size in
 * KiB, or the classification marking (#190's limits AC). The refusal is
 * asker-visible text, sent as the question's answer; nothing is retained
 * on either branch.
 */
export type WorkspaceAttachmentDoorResult =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "grounded"; readonly grounding: readonly WorkspaceGroundedAttachment[] };

/**
 * #190/#183: the attachment grounding door, injected into the service the
 * way the answering pipeline is. Lives behind an interface because of the
 * pinned import boundary (test/workspace-payload.test.ts): src/workspace
 * cannot import the classification and drafting machinery the door needs,
 * so the door is built where those imports are legal
 * (src/drafting/attachment-grounding.ts) and handed in at composition
 * (commands/serve.ts). Order of checks, per docs/workspace/attachments.md
 * §6/§7 — count, type, and declared size (all decided before any body is
 * read), then the read itself cut at the bound, then the classification
 * ceiling on the decoded text, and only then grounding.
 */
export type WorkspaceAttachmentDoor = (
  attachments: readonly WorkspaceFileReference[],
  fetchFile: WorkspaceFileFetcher,
) => Promise<WorkspaceAttachmentDoorResult>;

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
