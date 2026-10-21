import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../permissions/public-answer.js";
import {
  forgetAlwaysAllowed,
  forgetRoomDecision,
  readAlwaysAllowed,
  readRoomConsent,
  recordAlwaysAllowed,
  recordRoomDecision,
  roomDecisionFor,
  RoomConsentNotFoundError,
  type AlwaysAllowEntry,
  type RoomConsentEntry,
  type RoomConsentStatus,
} from "./consent.js";
import { buildCardEdit, buildCardEvent, type DuoCardV1Input } from "./cards.js";
import { duoOwnerUserIdOf, workspaceDirectoryFrom, type WorkspaceAvailability, type WorkspaceDirectoryEntry } from "./directory.js";
import type { RoomInvite } from "./messages.js";
import { buildAnswerEvent, buildAttachmentRefusalEvent, buildFailedAnswerEvent } from "./payload.js";
import { answerableQuestionFrom, type RoomDecisionLookup } from "./questions.js";
import { AnswerRateWindow, isStaleEvent, type DuoReadState } from "./read-state.js";
import type {
  AnswerEventContent,
  WorkspaceAttachmentDoor,
  WorkspaceCandidateMessage,
  WorkspaceMemberIdentity,
  WorkspaceQuestion,
  WorkspaceTransport,
  WorkspaceTransportFactory,
} from "./transport.js";
import { WorkspaceTokenRevokedError } from "./transport.js";
import type { WorkspaceSettings } from "./settings.js";

/**
 * The connection phases #187's availability states read. `revoked` is
 * terminal: the homeserver rejected the access token (`M_UNKNOWN_TOKEN`,
 * carried as `WorkspaceTokenRevokedError`), no retry can fix a dead
 * credential, and the service stops dialing until an explicit `start()` —
 * the re-pairing that fixes it happens on the owner's machine, in the
 * environment the token came from, not in this loop.
 */
export type WorkspacePhase = "stopped" | "connecting" | "connected" | "revoked";

/**
 * #186 AC4: disconnection as a recorded state, not an error. `phase` is the
 * daemon's own outbound-connection state; `lastAliveAt` is when it last
 * successfully reported liveness to the homeserver (the server-side
 * presence/last-seen the asker side eventually sees); `attempts` counts
 * consecutive failed dials so an observer can tell "connecting" (fresh)
 * from "connecting" (backing off after the ninth try). The terminal phases
 * (`stopped`, `revoked`) reset it to 0 — once dialing has ended for good,
 * there is no streak left to describe, and an explicit later `start()`
 * begins a fresh one.
 */
export interface WorkspaceServiceState {
  readonly phase: WorkspacePhase;
  /** ISO-8601 instant of the most recent state change — a phase transition or a `lastAliveAt` refresh. */
  readonly since: string;
  readonly lastAliveAt: string | null;
  readonly attempts: number;
}

/** The answering pipeline, injected — in production the exact `answerPublicly` call `POST /ask` makes (no second path; see commands/serve.ts). */
export type WorkspaceAnswerPipeline = (question: WorkspaceQuestion) => Promise<PublicAnswerOutcome>;

/**
 * W-S4-5: one question's decided fate as `answerOrRefuse`/the pipeline-
 * failure catch branch produce it — the `m.text` content every question
 * sends regardless (unchanged), plus exactly the card-relevant facts
 * `resolveOutcomeCard` needs. See `answerOrRefuse`'s own doc comment for
 * what each optional field means and why it is safe to carry.
 */
interface AnswerDecision {
  readonly content: AnswerEventContent;
  readonly outcomeKind?: PublicAnswerOutcome["kind"];
  readonly passedOnDraftId?: string;
  readonly pipelineFailed?: boolean;
}

/**
 * The service's own connection state → #187's availability, asleep-duo.md §6
 * exactly: `online` iff the outbound connection is live (phase `connected`);
 * otherwise offline with `lastAliveAt` — the most recent liveness the
 * homeserver accepted — as the last-seen time (null when it never got one).
 * Exported (and the only spelling — the service keeps no `availability()`
 * twin) because the duo's own availability is a directory-shaped fact: the
 * same `WorkspaceAvailability` `directory.ts` composes for everyone else,
 * read here off the one connection this process holds, over `state()` /
 * `onState()`.
 */
export function availabilityOfState(state: WorkspaceServiceState): WorkspaceAvailability {
  return { online: state.phase === "connected", lastSeenAt: state.phase === "connected" ? null : state.lastAliveAt };
}

export interface WorkspaceServiceOptions {
  readonly settings: WorkspaceSettings;
  readonly transportFactory: WorkspaceTransportFactory;
  readonly answer: WorkspaceAnswerPipeline;
  /**
   * #189: the duo's durable read state — which events previous processes
   * already handled. Injected (`runServe` wires the encrypted-store
   * implementation; this module cannot import the store, by the pinned
   * boundary scan). Absent means no durable dedupe: in-process only, the
   * pre-#189 behavior, which is what every test of the seam-level
   * semantics runs with.
   */
  readonly readState?: DuoReadState;
  /**
   * #192: the room-consent surface. Present means this service holds
   * invitations for the owner's decision, gates shared-room questions on
   * `duo/room-consent.json`, and carries allow/refuse/withdrawal out over
   * the seam. Absent is the pre-#192 behavior exactly: direct rooms only,
   * and invitations (if an adapter delivers them at all) are not this
   * daemon's work.
   */
  readonly consent?: WorkspaceConsentOptions;
  /**
   * #190: the attachment grounding door — injected, like `answer` and
   * `readState`, because the pinned import boundary (test/workspace-
   * payload.test.ts) keeps this module off the ingest/permissions modules
   * the door reads markings with. `runServe` wires
   * `attachmentGroundingDoor(parseClassificationCeiling(...))`; absent
   * means attachment questions are answered text-only with an owner-side
   * log, which is what a caller that never opted into grounding wants and
   * what the seam-level tests run with.
   */
  readonly attachmentDoor?: WorkspaceAttachmentDoor;
  /**
   * W-S4-4/W-S4-5: the task and card store, injected like `readState` and
   * `attachmentDoor` because the pinned import boundary keeps this module
   * off `src/tasks/store.ts` (and now `src/tasks/` generally — see the
   * boundary scan's own comment). Present means the ack timer and the
   * outcome branches (W-S4-5) create and update tasks and send/edit
   * `duo.card` events; absent means card/task behavior is skipped
   * entirely, byte-identical to pre-S4 behavior — the same "feature
   * absent" degradation `readState`/`consent`/`attachmentDoor` already
   * take when their own option is omitted.
   */
  readonly taskSink?: WorkspaceTaskSink;
  /**
   * #236: where this service's own log lines go. Absent is the `duo serve` behavior exactly
   * (`console.error("workspace: <what>:", <message>)`). A hosted daemon runs one service per duo
   * in one process, so it passes a logger that names the duo (and scrubs the duo's token);
   * the line handed over is the same text, one string.
   */
  readonly log?: (line: string) => void;
  /**
   * #236: what to tell the operator when the homeserver refuses the token for good. Absent is the
   * single-owner remedy (the owner re-pairs on their own machine); a hosted duo has no owner's
   * machine, so the hosted daemon passes what actually fixes it there.
   */
  readonly revokedRemedy?: string;
}

/** Where the consent record lives — the owner's `duo/` directory (consent.ts states why a file and not the store). */
export interface WorkspaceConsentOptions {
  readonly duoDir: string;
  /**
   * guangshinhaha/duo#315: what a declined invitation tells the colleague —
   * the leave's `reason`, in the daemon's fixed words (the wiring composes
   * it with the owner's name). Absent is the bare, silent rejection.
   */
  readonly declineNotice?: string;
}

/**
 * W-S4-4: the one open task card for a room — what the service needs to
 * decide "send a brand-new card" versus "edit the one already out there"
 * (W-S4-5: at most one task card per task, ever, even across an
 * ack-then-outcome race). Carries exactly the fields an edit needs:
 * the card's own event id (so `editCard` can target it) and its current
 * rev (so the next edit bumps it by exactly one, per cards.md §4).
 */
export interface OpenWorkspaceCard {
  readonly cardId: string;
  readonly taskId: string;
  readonly eventId: string;
  readonly rev: number;
  readonly state: string;
}

/**
 * W-S4-4: the narrow interface `src/workspace/service.ts` is written
 * against for everything task/card-shaped — mirroring `DuoReadState`'s own
 * minimalism (read-state.ts): just enough for the ack timer to create a
 * Task and send its first card, and for the outcome branches to find and
 * edit that same card (W-S4-5). The implementation
 * (`src/serve/workspace-tasks.ts`) is injected the same way
 * `durableDuoReadState` is — this module never imports `src/tasks/store.ts`
 * (the boundary scan forbids it).
 */
/** W-S4-6: the ids-and-state-only fact `onTaskEvent` hands subscribers — never a draftId, never card content (cards.md §7). */
export interface WorkspaceTaskSignal {
  readonly taskId: string;
  readonly roomId: string;
  readonly state: string;
}

/** W-S4-6: the ids-only fact `onCardEvent` hands subscribers. */
export interface WorkspaceCardSignal {
  readonly cardId: string;
  readonly roomId: string;
}

export interface WorkspaceTaskSink {
  /** Creates a task in `acknowledged`, optionally with a known draftId (the passed_on path). */
  createTask(input: { readonly roomId: string; readonly questionEventId: string; readonly requester: string; readonly draftId?: string }): { readonly taskId: string };

  /**
   * Applies one state-machine event to the task's state, and/or sets its
   * draftId — the field update the passed_on path needs when a task was
   * created ack-first, with no draftId yet. The event union is spelled out
   * literally rather than imported from `src/tasks/state.ts`'s own
   * `TaskEvent` (the boundary scan forbids that import here) — a future
   * change to that union would fail typecheck at
   * `src/serve/workspace-tasks.ts`'s call into `src/tasks/store.ts`
   * (whose own `updateTaskState` takes the real `TaskEvent`), not silently
   * drift, so this copy is safe to keep literal.
   */
  updateTaskState(taskId: string, event: "start_working" | "need_decision" | "resume_working" | "complete" | "fail" | undefined, fields?: { readonly draftId?: string }): void;

  /** Records a brand-new card's row — called right after `transport.sendCard` resolves its event id. */
  createCard(input: { readonly taskId: string; readonly roomId: string; readonly eventId: string; readonly kind: string; readonly audience: string; readonly state: string; readonly requester: string }): { readonly cardId: string };

  /** Records an edit's new rev/state — called right after `transport.editCard` resolves. */
  recordCardEdit(cardId: string, fields: { readonly rev: number; readonly state: string }): void;

  /** The open (not done/failed) card for this task in this room, if one has already been sent — the W-S4-5 "send once, then only ever edit" lookup. */
  openCardFor(taskId: string, roomId: string): OpenWorkspaceCard | undefined;
}

/** Thrown when the duo's own owner can't be named from its user id — nobody to bring into the conversation. Maps to 409. */
export class NoOwnerToInviteError extends Error {
  constructor(selfUserId: string) {
    super(`The duo's user id ${JSON.stringify(selfUserId)} doesn't name an owner by the @duo-<owner> convention — there is nobody to invite`);
    this.name = "NoOwnerToInviteError";
  }
}

/**
 * #192: a held invitation — the seam's invite facts plus when this process
 * received them. Held in memory only, deliberately: the invitation itself
 * is server-side state the homeserver holds and re-delivers on every sync
 * until it is joined or left, so a restart re-populates this exactly the
 * way held questions repopulate (the platform's held-not-lost stance — no
 * daemon-side queue to lose or corrupt).
 */
export interface HeldRoomInvite extends RoomInvite {
  readonly receivedAt: string;
}

/** An allow or refuse decided on an invitation this daemon is not holding — there is nothing to decide on. Maps to 404 on the owner surface. */
export class NoPendingInviteError extends Error {
  constructor(roomId: string) {
    super(`No held invitation for room ${JSON.stringify(roomId)} — an allow or a refuse is a decision on an invitation the daemon is holding`);
    this.name = "NoPendingInviteError";
  }
}

/** guangshinhaha/duo#315: "always allow" asked of an invitation that names no inviter or isn't one-to-one — a standing yes is to a person, for direct conversations only. Maps to 400. */
export class AlwaysAllowNotApplicableError extends Error {
  constructor(roomId: string) {
    super(`The invitation to room ${JSON.stringify(roomId)} isn't a one-to-one conversation from a named person — "always allow" covers only those; allow it on its own instead`);
    this.name = "AlwaysAllowNotApplicableError";
  }
}

/**
 * Capped exponential backoff: `initial * 2^attempt`, never more than `max`.
 * Attempt 0 waits `initial` (not zero) — a homeserver that just refused a
 * connection does not want an immediate redial.
 */
export function reconnectDelayMs(attempt: number, reconnect: WorkspaceSettings["reconnect"]): number {
  const growth = Math.pow(2, Math.min(attempt, 30));
  return Math.min(reconnect.initialDelayMs * growth, reconnect.maxDelayMs);
}

/**
 * Event ids this daemon has already answered, FIFO-capped: the set covers
 * in-session duplicates and the in-flight window (a replay arriving while
 * an answer is still being drafted). Durable dedupe across restarts is the
 * injected `readState` (#189); this set alone survives only the process,
 * so the oldest ids are evicted once the cap is hit rather than growing
 * for a daemon's whole lifetime.
 */
export class RecentlySeenEventIds {
  private readonly max: number;
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(max: number) {
    this.max = max;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  add(eventId: string): void {
    if (this.seen.has(eventId)) {
      return;
    }
    this.seen.add(eventId);
    this.order.push(eventId);
    if (this.order.length > this.max) {
      this.seen.delete(this.order.shift()!);
    }
  }

  /**
   * Removes an id so a later replay of the same event is answered again.
   * Called when an answer's send failed: the question was consumed but the
   * asker got nothing, so the daemon leans on the homeserver's replay —
   * the same recovery a restart gets — instead of losing the question for
   * the rest of the process's life.
   */
  forget(eventId: string): void {
    if (!this.seen.delete(eventId)) {
      return;
    }
    this.order.splice(this.order.indexOf(eventId), 1);
  }
}

/**
 * Owns the outbound workspace connection's lifecycle for `duo serve`:
 * dial-and-hold, reconnect with backoff, presence reporting, the
 * question→answer loop, and — #187 — the workspace member cache that feeds
 * asker resolution, the `directory()` read, and the terminal revoked phase
 * a dead access token ends in. Everything above the transport seam — this
 * class — is transport-agnostic and fully covered by tests against a fake.
 *
 * Held-not-lost needs no queue here, and none is built (docs/workspace-
 * platform.md: Matrix gives sync/queueing as library capability). The
 * homeserver holds events for an offline duo; `connect()` resolving means
 * sync has caught up; the held events then arrive through `onMessage` and
 * are answered like any other question. The service's own obligations are
 * only to come back (backoff), stay observable (state), and not answer the
 * same event twice — in-process by event id, across restarts through the
 * injected durable read state (#189), with the one deliberate exception of
 * an answer whose send failed, which is forgotten so the replay re-answers
 * it. The backlog policies (age window, answer rate bound — read-state.ts)
 * bound what a wake-up replay may ask of the pipeline at all.
 */
export class WorkspaceService {
  private readonly options: WorkspaceServiceOptions;
  private transport: WorkspaceTransport | undefined;
  private running = false;
  private consecutiveFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceTimer: ReturnType<typeof setInterval> | undefined;
  private stateValue: WorkspaceServiceState;
  private readonly stateHandlers = new Set<(state: WorkspaceServiceState) => void>();
  /** W-S4-6: ids-and-state-only task signal subscribers — `createServer`'s own subscription is the one production consumer, forwarding into `DraftReadyHub.publishTask` over `/ws`. */
  private readonly taskEventHandlers = new Set<(event: WorkspaceTaskSignal) => void>();
  /** W-S4-6: the card-shaped twin of `taskEventHandlers` — ids only, forwarded into `DraftReadyHub.publishCard`. */
  private readonly cardEventHandlers = new Set<(event: WorkspaceCardSignal) => void>();
  private readonly seenEventIds = new RecentlySeenEventIds(10_000);
  private membersById = new Map<string, WorkspaceMemberIdentity>();
  private readonly answerRate: AnswerRateWindow;
  private answerChain: Promise<void> = Promise.resolve();
  /** #192: held invitations, keyed by room id — a still-live invite replays on every sync, so the room id is the dedupe. Cleared on terminate like every other live-connection fact. */
  private pendingInvitesById = new Map<string, HeldRoomInvite>();
  /**
   * #192: rooms withdrawn in THIS process — the in-flight half of
   * withdrawal's immediacy. The record flips to `withdrawn` and then, once
   * the leave lands, deletes itself (the executed-exit rule), so a record
   * read alone cannot tell "never consented" from "consent withdrawn a
   * moment ago"; this memory can, and the send-time re-check reads it so a
   * draft that was underway when the owner withdrew goes nowhere — no
   * in-flight grace. Cleared only by a fresh allow on a new invitation for
   * the room (allowInvite) — the owner's newer word — and deliberately NOT
   * on terminate: a stop/start cycle inside one process must not re-open
   * the window. Growth is bounded by the owner's own acts, not by inbound
   * data.
   */
  private readonly withdrawnRoomIds = new Set<string>();
  /** The consent gate's lookup, bound iff the consent surface is configured — undefined means the pre-#192 filter exactly. */
  private readonly roomDecisionLookup: RoomDecisionLookup | undefined;

  constructor(options: WorkspaceServiceOptions) {
    this.options = options;
    this.answerRate = new AnswerRateWindow(options.settings.backlog.maxAnswersPerMinute);
    this.roomDecisionLookup = options.consent ? (roomId) => this.decisionFor(roomId) : undefined;
    this.stateValue = { phase: "stopped", since: new Date().toISOString(), lastAliveAt: null, attempts: 0 };
  }

  /** Current connection state — #187's availability surface reads this (and may subscribe via onState). */
  state(): WorkspaceServiceState {
    return this.stateValue;
  }

  onState(handler: (state: WorkspaceServiceState) => void): void {
    this.stateHandlers.add(handler);
  }

  /**
   * W-S4-6: subscribes to every task created or state-changed by the ack
   * timer / outcome branches (W-S4-5) — ids and state only (cards.md §7),
   * never the task's draftId or any card content. `createServer` is the one
   * production subscriber, forwarding each event into
   * `DraftReadyHub.publishTask` same-tick, the same shape `onDraftingStarted`
   * already uses for the sibling `draft-drafting` signal.
   */
  onTaskEvent(handler: (event: WorkspaceTaskSignal) => void): void {
    this.taskEventHandlers.add(handler);
  }

  /** W-S4-6: the card-shaped twin of `onTaskEvent` — fired on every card create/edit, ids only. */
  onCardEvent(handler: (event: WorkspaceCardSignal) => void): void {
    this.cardEventHandlers.add(handler);
  }

  private emitTaskEvent(event: WorkspaceTaskSignal): void {
    for (const handler of this.taskEventHandlers) {
      handler(event);
    }
  }

  private emitCardEvent(event: WorkspaceCardSignal): void {
    for (const handler of this.cardEventHandlers) {
      handler(event);
    }
  }

  /**
   * The workspace member record for a Matrix user id, from the listing read
   * at the last successful connect — or undefined when the sender wasn't
   * listed (or no read has succeeded yet). Identity facts only (id, display
   * name): presence is never served from this cache, because a cache read at
   * connect time is stale the moment anyone's connection changes. Callers
   * wanting availability read `directory()`.
   */
  memberFor(userId: string): WorkspaceMemberIdentity | undefined {
    return this.membersById.get(userId);
  }

  /**
   * Reads the workspace directory over the live connection (#187 AC1/AC2):
   * one fresh `listMembers` + compose, so what it returns is what the
   * homeserver says now — people with stable ids, display names, and §6
   * availability, their duos attached and attributed. Refuses with a plain
   * error when the connection is not live: a directory read is a read over
   * the held connection, not a best-effort cache serve. A server-capped
   * listing is surfaced (logged), never silently swallowed — the entries
   * returned are correct, the entries absent are unknown.
   */
  async directory(): Promise<readonly WorkspaceDirectoryEntry[]> {
    const transport = this.transport;
    if (transport === undefined || this.stateValue.phase !== "connected") {
      throw new Error("the workspace directory can only be read while the outbound connection is live");
    }
    const listing = await transport.listMembers();
    if (listing.truncated) {
      this.consoleError("the workspace directory listing was truncated by the homeserver's limit", `the server capped the listing at ${listing.members.length} members`);
    }
    return workspaceDirectoryFrom(listing);
  }

  /**
   * #192: the invitations currently held for the owner's decision — the
   * surfaced half of "a duo is never conscripted". Sorted by room id for a
   * deterministic read; in-memory only (see HeldRoomInvite for why that is
   * not a durability gap). Empty when no consent surface is configured.
   */
  pendingInvites(): readonly HeldRoomInvite[] {
    return [...this.pendingInvitesById.values()].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  }

  /** The consent record's live half: the rooms whose standing decision is `allowed`, provenance included. Empty when no consent surface is configured. */
  consentedRooms(): readonly RoomConsentEntry[] {
    const duoDir = this.options.consent?.duoDir;
    if (duoDir === undefined) {
      return [];
    }
    return readRoomConsent(duoDir).filter((entry) => entry.status === "allowed");
  }

  /**
   * The owner's explicit allow on a held invitation — the consented act.
   * Join first, record second (a crash between them leaves a joined-but-
   * unrecorded room, which the gate answers with silence — the safe
   * direction; the reverse would consent a room the daemon can never put
   * the duo in, because nothing auto-joins). A join failure records
   * nothing and leaves the invitation held and still live server-side, so
   * the owner's retry is a real retry. The record write failing after a
   * successful join propagates loudly (disk trouble should be loud): the
   * invite stays held and a retry re-joins — Matrix joins are idempotent.
   */
  async allowInvite(roomId: string, options: { readonly always?: boolean } = {}): Promise<RoomConsentEntry> {
    const invite = this.requireHeldInvite(roomId);
    const duoDir = this.requireConsentDir("allow the invitation");
    const transport = this.requireLiveTransport("allowing the invitation");
    if (options.always === true && (invite.inviterId === null || invite.direct !== true)) {
      // guangshinhaha/duo#315: a standing yes is to a PERSON for one-to-one
      // conversations — refused before anything happens when the invitation
      // names nobody or isn't one-to-one, so the owner's Allow never half-lands.
      throw new AlwaysAllowNotApplicableError(roomId);
    }
    await transport.joinRoom(roomId);
    const entry: RoomConsentEntry = {
      roomId,
      status: "allowed",
      name: invite.name,
      inviterId: invite.inviterId,
      joinedMemberCount: invite.joinedMemberCount,
      decidedAt: new Date().toISOString(),
    };
    recordRoomDecision(duoDir, entry);
    if (options.always === true && invite.inviterId !== null) {
      recordAlwaysAllowed(duoDir, invite.inviterId);
    }
    this.pendingInvitesById.delete(roomId);
    // A fresh allow is a fresh consent act — the owner's newer word. It
    // retires the in-flight memory of any earlier withdrawal for this room
    // (see withdrawnRoomIds): without this, a withdrawn-then-reallowed room
    // would stay silent for the rest of the process's life, which would make
    // withdrawal a one-way door the record's own re-allow says it is not.
    this.withdrawnRoomIds.delete(roomId);
    return entry;
  }

  /**
   * The owner's explicit refusal on a held invitation. The decision is
   * recorded first (that IS the refusal), then the invitation is rejected
   * over the seam — on Matrix a leave rejects an invite, and until that
   * lands the homeserver keeps replaying the invite in sync. Once the leave
   * lands the entry is deleted (consent.ts's executed-exit rule): a
   * re-invite must arrive as a fresh decision, not be answered by a
   * standing refusal. A failed or unreachable leave leaves the entry as the
   * memory of an unfinished exit — settleRoomExits retries it on the next
   * connect.
   */
  async refuseInvite(roomId: string): Promise<void> {
    const invite = this.requireHeldInvite(roomId);
    recordRoomDecision(this.requireConsentDir("refuse the invitation"), {
      roomId,
      status: "refused",
      name: invite.name,
      inviterId: invite.inviterId,
      joinedMemberCount: invite.joinedMemberCount,
      decidedAt: new Date().toISOString(),
    });
    this.pendingInvitesById.delete(roomId);
    // guangshinhaha/duo#315: the colleague is told, politely, on the leave
    // itself — the one place a rejected invitation can carry words.
    await this.exitRoom(roomId, this.options.consent?.declineNotice);
  }

  /** guangshinhaha/duo#315: the people the owner has said always yes to. Empty when no consent surface is configured. */
  alwaysAllowed(): readonly AlwaysAllowEntry[] {
    const duoDir = this.options.consent?.duoDir;
    return duoDir === undefined ? [] : readAlwaysAllowed(duoDir);
  }

  /** guangshinhaha/duo#315: takes a standing yes back — the next invitation from that person is held for the owner again. */
  forgetAlwaysAllowed(userId: string): { removed: boolean; people: readonly AlwaysAllowEntry[] } {
    return forgetAlwaysAllowed(this.requireConsentDir("take back an always-allow"), userId);
  }

  /**
   * guangshinhaha/duo#314: brings the duo's own owner into a conversation
   * the duo is in, so they can answer — in that conversation, as
   * themselves — a question it passed to them. The invitee is fixed by the
   * id grammar (`@duo-<owner>` → `@<owner>`): there is no parameter that
   * could make the duo invite anyone else. Whether the room exists and the
   * duo may invite there is the homeserver's to say; its refusal propagates.
   */
  async inviteOwner(roomId: string): Promise<{ readonly roomId: string; readonly userId: string }> {
    const ownerUserId = duoOwnerUserIdOf(this.options.settings.userId);
    if (ownerUserId === null) {
      throw new NoOwnerToInviteError(this.options.settings.userId);
    }
    const transport = this.requireLiveTransport("inviting the owner");
    await transport.inviteToRoom(roomId, ownerUserId);
    return { roomId, userId: ownerUserId };
  }

  /**
   * guangshinhaha/duo#315: held invitations the owner already said yes to
   * by standing decision — a one-to-one conversation from a person on the
   * always-allow list — are allowed now, exactly as the owner's own tap
   * would. Runs on every connect (invitations that arrived while the
   * connection was down) and on each new invitation while connected. A
   * failure leaves the invitation held for the owner, logged — never lost.
   */
  private async allowStandingInvites(): Promise<void> {
    const duoDir = this.options.consent?.duoDir;
    if (duoDir === undefined || this.stateValue.phase !== "connected") {
      return;
    }
    let people: Set<string>;
    try {
      people = new Set(readAlwaysAllowed(duoDir).map((entry) => entry.userId));
    } catch (error) {
      this.consoleError("reading the always-allow record failed — invitations stay held for the owner", error);
      return;
    }
    for (const invite of this.pendingInvites()) {
      if (invite.direct !== true || invite.inviterId === null || !people.has(invite.inviterId)) {
        continue;
      }
      try {
        await this.allowInvite(invite.roomId);
      } catch (error) {
        this.consoleError(`allowing the invitation to room ${invite.roomId} from an always-allowed person failed (it stays held)`, error);
      }
    }
  }

  /**
   * #192 AC4: withdrawal. The record flips to `withdrawn` first — from that
   * write the gate refuses the room (vetoing even the direct-room posture),
   * so answering stops at the next question and any answer already being
   * drafted is dropped at its send-time re-check: no in-flight grace, the
   * "instantly killable" stance. The leave then follows over the seam; if
   * it cannot land now (connection down, server refusal) the `withdrawn`
   * entry is exactly what remembers the unfinished exit, and
   * settleRoomExits retries it on every successful connect. Withdrawing a
   * room with no record is an error, not a no-op: there is no consent to
   * withdraw (leaving a room the duo was never put in by consent is an
   * ordinary client-side leave, not a consent act).
   */
  async withdrawRoom(roomId: string): Promise<RoomConsentEntry> {
    const duoDir = this.requireConsentDir("withdraw");
    const existing = readRoomConsent(duoDir).find((entry) => entry.roomId === roomId);
    if (existing === undefined) {
      throw new RoomConsentNotFoundError(roomId);
    }
    const withdrawn: RoomConsentEntry = { ...existing, status: "withdrawn", decidedAt: new Date().toISOString() };
    recordRoomDecision(duoDir, withdrawn);
    // The in-flight half of "instantly killable", effective from this line —
    // ahead of the leave, which may not land until a later connect.
    this.withdrawnRoomIds.add(roomId);
    await this.exitRoom(roomId);
    return withdrawn;
  }

  /** The leave/reject half every exit shares — fail-soft on purpose (the decision is already recorded; the exit retries on connect). */
  private async exitRoom(roomId: string, reason?: string): Promise<void> {
    const transport = this.transport;
    if (transport === undefined || this.stateValue.phase !== "connected") {
      return;
    }
    try {
      await (reason === undefined ? transport.leaveRoom(roomId) : transport.leaveRoom(roomId, reason));
    } catch (error) {
      this.consoleError(
        `leaving workspace room ${roomId} failed (the decision is recorded; the leave retries on the next successful connect)`,
        error,
      );
      return;
    }
    // Executed: delete the entry so a later invitation is a fresh decision,
    // never answered by this standing one (consent.ts's executed-exit rule).
    try {
      forgetRoomDecision(this.requireConsentDir("forget the executed decision"), roomId);
    } catch (error) {
      this.consoleError(`forgetting the executed room decision for ${roomId} failed`, error);
    }
  }

  /**
   * Every successful connect settles unfinished exits: any recorded
   * `refused`/`withdrawn` room is left again — the only reconciliation the
   * consent surface does, and deliberately the only automatic room
   * operation in the service: it enforces an owner decision, it never
   * makes one. Failures log and wait for the next connect.
   */
  private async settleRoomExits(): Promise<void> {
    const duoDir = this.options.consent?.duoDir;
    if (duoDir === undefined || this.transport === undefined) {
      return;
    }
    let exits: RoomConsentEntry[];
    try {
      exits = readRoomConsent(duoDir).filter((entry) => entry.status !== "allowed");
    } catch (error) {
      this.consoleError("reading the room consent record to settle room exits failed", error);
      return;
    }
    for (const entry of exits) {
      // A refusal still owes the colleague its polite word on retry (#315); a withdrawal never carried one.
      await this.exitRoom(entry.roomId, entry.status === "refused" ? this.options.consent?.declineNotice : undefined);
    }
  }

  /**
   * The gate's one read of the record: fresh per decision, degrading to "no
   * record" (logged) rather than erroring the question — a malformed record
   * never turns an answerable question into an exception, and never invents
   * authority either. The non-null assertion is pinned by construction: this
   * is only ever reachable through `roomDecisionLookup`, which the
   * constructor binds iff consent is configured.
   */
  private decisionFor(roomId: string): RoomConsentStatus | null {
    try {
      return roomDecisionFor(readRoomConsent(this.options.consent!.duoDir), roomId);
    } catch (error) {
      this.consoleError(`reading the room consent record for room ${roomId} failed`, error);
      return null;
    }
  }

  /** The send-time half of withdrawal's immediacy: permitted means recorded-`allowed`, or no record at all (the direct-room posture — a room the owner has never spoken about is not forbidden by that silence). */
  private roomStillPermitted(roomId: string): boolean {
    const decision = this.decisionFor(roomId);
    return decision === null || decision === "allowed";
  }

  /** Both decision methods' shared refusal: nothing is decidable without a held invitation. */
  private requireHeldInvite(roomId: string): HeldRoomInvite {
    const invite = this.pendingInvitesById.get(roomId);
    if (invite === undefined) {
      throw new NoPendingInviteError(roomId);
    }
    return invite;
  }

  /** The consent surface's own directory — every record-writing path states its precondition by calling this. */
  private requireConsentDir(what: string): string {
    const duoDir = this.options.consent?.duoDir;
    if (duoDir === undefined) {
      throw new Error(`cannot ${what}: no consent surface is configured for this workspace service`);
    }
    return duoDir;
  }

  /** The live-connection requirement a join needs — same refusal shape directory() uses. */
  private requireLiveTransport(what: string): WorkspaceTransport {
    const transport = this.transport;
    if (transport === undefined || this.stateValue.phase !== "connected") {
      throw new Error(`cannot ${what}: the outbound workspace connection is not live`);
    }
    return transport;
  }

  /**
   * Begins dialing out. Returns immediately — `duo serve` must start its
   * HTTP listener on time even when the workspace is unreachable; the
   * connect/reconnect loop owns recovery from that point on, reporting
   * through state and console.error, never by rejecting anything here.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.dial();
  }

  /** Stops the connection and cancels any pending reconnect. Idempotent. */
  async stop(): Promise<void> {
    this.running = false;
    await this.terminate("stopped");
  }

  /**
   * The one teardown every terminal end shares: cancel the pending
   * reconnect, stop the presence interval, reset the failure count, drop the
   * member cache, emit exactly one terminal state (keeping `lastAliveAt` —
   * the offline-with-last-seen story still holds), and detach + stop the
   * transport. stop() lands in "stopped"; the revoked-token path in
   * "revoked" — the state they land in is the only difference between them.
   */
  private async terminate(phase: "stopped" | "revoked"): Promise<void> {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopPresenceRefresh();
    this.consecutiveFailures = 0;
    this.membersById = new Map();
    // Held invitations live only with the connection that carries them; the
    // homeserver re-delivers any still-live invite on the next connect, so
    // nothing is lost by dropping them here (the held-not-lost stance).
    this.pendingInvitesById = new Map();
    this.setState({ phase, lastAliveAt: this.stateValue.lastAliveAt, attempts: 0 });
    const transport = this.transport;
    this.transport = undefined;
    await transport?.stop();
  }

  private async dial(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.setState({ phase: "connecting", attempts: this.consecutiveFailures });
    try {
      const transport = await this.options.transportFactory(this.options.settings);
      if (!this.running) {
        // stop() raced the factory resolving — the transport it built is
        // unusable now, but must still be shut down, not leaked.
        await transport.stop();
        return;
      }
      if (this.transport !== transport) {
        // A re-dial builds a fresh client (the reliable Matrix reset after a
        // broken connection); the old one, already dead or stuck, is stopped
        // rather than left half-syncing in the background.
        const previous = this.transport;
        this.transport = transport;
        transport.onMessage((message) => this.receive(message));
        transport.onInvite((invite) => this.receiveInvite(invite));
        transport.onDisconnected(() => this.scheduleReconnect());
        await previous?.stop();
      }
      await transport.connect();
      if (!this.running) {
        // stop() raced the connect resolving — same rule as the factory
        // race: shut the transport down, leave the state at "stopped",
        // and above all don't arm the presence interval nothing would
        // ever clear again.
        await transport.stop();
        return;
      }
    } catch (error) {
      if (!this.running) {
        // A connect still in flight when stop() ran settles here (the
        // adapter rejects it from stop()) — shutdown, not a failure.
        return;
      }
      if (error instanceof WorkspaceTokenRevokedError) {
        // Fail-fast, not fail-forever (#219's successor note): a revoked
        // token is a dead credential, and dialing it on a backoff schedule
        // is a loop that can never succeed — it would also keep hammering
        // the homeserver with auth failures it has already answered. So:
        // terminal (the shared teardown lands in "revoked", keeping
        // lastAliveAt), and say how it's fixed — re-pairing on the owner's
        // machine, the only place duo credentials are ever created. An
        // explicit later start() may re-dial and re-discover the revocation;
        // nothing automatic does.
        this.consoleError(
          `workspace access token rejected — not retrying; ${this.options.revokedRemedy ?? "re-pair the duo on the owner's machine (DUO_WORKSPACE_ACCESS_TOKEN) and restart duo serve"}`,
          error,
        );
        this.running = false;
        await this.terminate("revoked");
        return;
      }
      this.consoleError("workspace connection failed", error);
      this.scheduleReconnect();
      return;
    }
    this.consecutiveFailures = 0;
    this.setState({ phase: "connected", attempts: 0 });
    await this.refreshPresence();
    if (!this.running) {
      // stop() raced the first presence report (markAlive is an HTTP round
      // trip in the real adapter) — same rule as the connect race above:
      // don't arm a presence interval nothing would ever clear again.
      return;
    }
    this.startPresenceRefresh();
    void this.refreshMembers();
    void this.settleRoomExits();
    void this.allowStandingInvites();
  }

  /**
   * Re-reads the workspace member listing into the identity cache (#187's
   * asker feed) — the identity-only read: the cache serves identity facts,
   * so paying the presence fan-out `listMembers` carries would buy nothing
   * on every connect. Fail-soft by design: a directory read failing
   * degrades the asker mapping to its parse-only fallback (and
   * `directory()` callers to an error they already have to handle), never
   * the connection and never an answer — identity resolution must not turn
   * an answerable question into an error (directory.ts's own rule). A read
   * that resolves after the transport it read from was replaced (re-dial)
   * or stopped is discarded: it describes a connection this service no
   * longer holds.
   */
  private async refreshMembers(): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) {
      return;
    }
    try {
      const listing = await transport.listMemberIdentities();
      if (this.transport !== transport) {
        return;
      }
      if (listing.truncated) {
        this.consoleError(
          "the workspace directory listing was truncated by the homeserver's limit — members beyond it are missing from the cached asker feed",
          `the server capped the listing at ${listing.members.length} members`,
        );
      }
      this.membersById = new Map(listing.members.map((member) => [member.userId, member]));
    } catch (error) {
      this.consoleError("workspace member listing failed", error);
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) {
      return;
    }
    this.stopPresenceRefresh();
    const delay = reconnectDelayMs(this.consecutiveFailures, this.options.settings.reconnect);
    this.consecutiveFailures += 1;
    this.setState({ phase: "connecting", attempts: this.consecutiveFailures });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.dial();
    }, delay);
  }

  private async refreshPresence(): Promise<void> {
    try {
      await this.transport?.markAlive();
      this.setState({ lastAliveAt: new Date().toISOString() });
    } catch (error) {
      // A failed presence report doesn't tear down a syncing connection;
      // the next interval (or the next reconnect) reports again.
      this.consoleError("workspace presence report failed", error);
    }
  }

  private startPresenceRefresh(): void {
    if (this.presenceTimer !== undefined) {
      return;
    }
    this.presenceTimer = setInterval(() => {
      void this.refreshPresence();
    }, this.options.settings.presenceIntervalMs);
  }

  private stopPresenceRefresh(): void {
    if (this.presenceTimer !== undefined) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
  }

  private receive(message: WorkspaceCandidateMessage): void {
    // #192: the consent-aware filter — direct rooms (the v1 posture) pass as
    // before, shared rooms only on the owner's recorded allow, everything
    // else not-a-question at all. This is the reachability gate, and it runs
    // here, ahead of the dedupe mark and the serialized chain, so a room the
    // owner has not consented to costs nothing — no pipeline call, no store
    // open, no draft (the refusal gate's short-circuit shape).
    const question = answerableQuestionFrom(message, this.options.settings.userId, this.roomDecisionLookup);
    if (!question || this.seenEventIds.has(question.eventId)) {
      return;
    }
    this.seenEventIds.add(question.eventId);
    // Serialized on purpose: the answering pipeline opens the store per
    // call, the durable read state does the same, and the encrypted store's
    // decrypt-to-temp-file dance is not re-entrant — a burst of held
    // questions replaying after a reconnect must not interleave any of it.
    // (That is also why every store-touching decision below lives in this
    // chain, never in receive(): a timeline event arriving mid-draft must
    // not open the store beside the pipeline's own open.)
    this.answerChain = this.answerChain.then(() => this.handleQuestion(question, message.originServerTs)).catch(() => {
      // handleQuestion already handles its own failures; this catch only
      // exists so the chain itself can never reject and poison the next
      // question.
    });
  }

  /**
   * #192: an invitation arrived. It is HELD, never acted on — the duo joins
   * by invitation the same as a person (platform record §6), and only its
   * owner's explicit allow (allowInvite) ever turns one into a join.
   * Surfaced owner-side with the facts the sync slice carried (name,
   * inviter, joined count) so the decision is made on what the inviter
   * actually did, and held in memory only: the invitation is server-side
   * state, re-delivered by sync until joined or left, so a restart or
   * reconnect repopulates this for free.
   */
  private receiveInvite(invite: RoomInvite): void {
    if (this.options.consent === undefined) {
      // No consent surface configured: the pre-#192 daemon. Nothing holds
      // or joins anything, and the invite stays server-side, inert.
      return;
    }
    this.pendingInvitesById.set(invite.roomId, { ...invite, receivedAt: new Date().toISOString() });
    const facts = [
      invite.name === null ? null : `named ${JSON.stringify(invite.name)}`,
      invite.inviterId === null ? null : `invited by ${invite.inviterId}`,
      `${invite.joinedMemberCount} joined member(s) visible`,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
    this.consoleError(
      `workspace invitation held for the owner's decision — room ${invite.roomId}`,
      new Error(`${facts}; the duo joins only on an explicit allow (see the workspace consent surface)`),
    );
    // guangshinhaha/duo#315: unless the owner already said always-yes to
    // this person — then it is allowed now, as their own tap would.
    void this.allowStandingInvites();
  }

  /**
   * One question's full decided fate, on the serialized chain: dedupe
   * (durable first, then the policies), draft, send, record. The durable
   * row is written only after a successful send — a crash mid-draft leaves
   * the event unrecorded so the post-restart replay re-answers it, the same
   * at-least-once recovery a send failure gets (read-state.ts's stated
   * semantics).
   *
   * W-S4-5: when `taskSink` is injected, an ack timer is armed right here —
   * before `answerOrRefuse` runs — for `ackAfterMs`. If it fires first, a
   * task card in `acknowledged` goes out (`sendAckCard`); whichever happens
   * second (the outcome, almost always) edits that same card if one exists,
   * or sends/edits exactly one card of its own otherwise. `taskSink`
   * undefined skips all of this — the pre-S4 behavior above, untouched.
   */
  private async handleQuestion(question: WorkspaceQuestion, originServerTs: number): Promise<void> {
    if (this.queryReadState(question)) {
      // A previous process already handled this event — the durable half of
      // the restart dedupe #219 deferred here. The in-process mark stays:
      // this process never re-enqueues it either.
      return;
    }
    const backlog = this.options.settings.backlog;
    const now = Date.now();
    if (isStaleEvent(originServerTs, now, backlog.maxAgeMs)) {
      // The backlog age policy: too old to answer, marked read instead, so
      // the asker is not answered-for yesterday. (A stale event's durable
      // mark is a no-op by the store's own retention design — the age
      // window doubles as it — because re-deciding an older-than-window
      // event always lands on this same skip; in-process, the seen set
      // already holds it.)
      this.markRead(question, originServerTs);
      this.consoleError(
        `not answering workspace question ${question.eventId}`,
        new Error(
          `the event is older than the backlog window (DUO_WORKSPACE_BACKLOG_MAX_AGE_MS=${backlog.maxAgeMs}) — marked read instead of answered`,
        ),
      );
      return;
    }
    if (!this.answerRate.allows(now)) {
      // The rate bound: a flood (sync replay or live) may not pin the
      // pipeline, and the excess is suppressed in-process and logged
      // owner-side. It is deliberately NOT durably marked: the bound is a
      // statement about this process's pipeline capacity, not a verdict on
      // the event — a flooding sender must not permanently silence fresh
      // questions that merely arrived behind the flood. A restart replays
      // them against a fresh window and answers them then; before that,
      // the in-process seen set holds them.
      this.consoleError(
        `not answering workspace question ${question.eventId}`,
        new Error(
          `the answer rate bound was reached (DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE=${backlog.maxAnswersPerMinute}) — suppressed for this process, not durably marked, so a restart re-decides it`,
        ),
      );
      return;
    }
    // W-S4-5: the ack timer. Armed only when a task sink is injected — its
    // absence is the whole feature's "off" switch (the same degradation
    // readState/consent/attachmentDoor take). `taskIdRef` is filled in by
    // whichever of the timer or the answer finishes first that decides to
    // create a Task; the other branch reads it back rather than creating a
    // second one.
    const taskSink = this.options.taskSink;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    // Set only once the timer actually fires and starts sending — awaited
    // below BEFORE resolveOutcomeCard runs, so a slow outcome that resolves
    // while the ack send is still in flight (sendCard's own round trip)
    // cannot race it: cardState.taskId must be fully set before the
    // outcome branches read it.
    let ackCardSend: Promise<void> | undefined;
    const cardState: { taskId?: string } = {};
    if (taskSink !== undefined) {
      ackTimer = setTimeout(() => {
        ackCardSend = this.sendAckCard(question, cardState);
      }, this.options.settings.ackAfterMs);
    }
    let decision: AnswerDecision;
    try {
      decision = await this.answerOrRefuse(question);
    } catch (error) {
      // The asker must never see internals (the /ask route's own rule) —
      // but they also must not stare at silence: send the same generic
      // failure event that route's 500 body comes from, and keep the
      // daemon alive for the next question.
      this.consoleError(`answering workspace question ${question.eventId} failed`, error);
      decision = { content: buildFailedAnswerEvent(), pipelineFailed: true };
    }
    if (ackTimer !== undefined) {
      clearTimeout(ackTimer);
    }
    if (ackCardSend !== undefined) {
      await ackCardSend;
    }
    if (this.roomDecisionLookup !== undefined && (this.withdrawnRoomIds.has(question.roomId) || !this.roomStillPermitted(question.roomId))) {
      // #192: withdrawal is immediate, with no in-flight grace — the draft
      // ran while the room was consented, and consent was withdrawn before
      // the send. The withdrawn-rooms memory catches the case where the
      // leave already landed and deleted the record (the executed-exit
      // rule), where a fresh read alone would read as "never consented".
      // Nothing goes out (not even the failure event above: that is an
      // asker-visible send too, and NEITHER is any card send/edit — W-S4-5
      // extends this same immediate-kill rule to cards). The event id is
      // forgotten, the send-failure stance, so a replay re-decides under
      // whatever consent holds then; the backlog age window bounds how
      // long that door stays open.
      this.seenEventIds.forget(question.eventId);
      this.consoleError(
        `not sending the answer to workspace question ${question.eventId}`,
        new Error(`consent for room ${question.roomId} was withdrawn while the answer was being drafted — the duo stops answering there at once`),
      );
      return;
    }
    // Captured after the draft, not before: a reconnect mid-draft should
    // still deliver over the fresh transport, while a stop() mid-draft
    // leaves nothing here — and that case must be logged, not silently
    // skipped by an optional chain (the dedupe already marked the question
    // seen, so it is unanswerable for the rest of this process's life).
    const transport = this.transport;
    if (transport === undefined) {
      this.consoleError(
        `sending workspace answer for ${question.eventId} failed`,
        new Error("the workspace connection stopped before the answer was sent"),
      );
      return;
    }
    let answerAlreadySent = false;
    if (taskSink !== undefined) {
      try {
        answerAlreadySent = await this.resolveOutcomeCard(question, decision, cardState);
      } catch (error) {
        this.consoleError(`sending/editing the task card for workspace question ${question.eventId} failed`, error);
        this.seenEventIds.forget(question.eventId);
        return;
      }
    }
    try {
      if (!answerAlreadySent) {
        await transport.sendAnswer(question.roomId, decision.content);
      }
    } catch (error) {
      // The send failed, not the answering: forget the event id so the
      // homeserver's post-reconnect replay re-answers the question instead
      // of the dedupe suppressing it — the asker must not stare at silence,
      // and no daemon-side retry queue exists to do it instead (the
      // homeserver's hold IS the queue, the same recovery a restart gets).
      // The re-answer re-runs the draft, and a send that landed server-side
      // but whose response was lost can double-answer — at-least-once
      // delivery, deliberately, and now consistently so: the durable row
      // is only ever written after a send that succeeded.
      this.seenEventIds.forget(question.eventId);
      this.consoleError(`sending workspace answer for ${question.eventId} failed`, error);
      return;
    }
    this.answerRate.record(Date.now());
    this.markRead(question, originServerTs);
  }

  /**
   * W-S4-5: the ack timer fired before the pipeline resolved. Creates the
   * Task (`acknowledged`, no draftId yet — the outcome may still turn out
   * to be `answered`, which never gets one) and sends its first card, with
   * the ack-timer fallback text from cards.md §5. Re-checks withdrawn
   * consent at send time (the timer fires asynchronously and can race a
   * withdrawal the same way the final send already re-checks) — a
   * withdrawn room gets neither this card nor anything else. Failures are
   * logged and swallowed: an ack that didn't make it out must never crash
   * the answer chain the real outcome still needs to finish on.
   */
  private async sendAckCard(question: WorkspaceQuestion, cardState: { taskId?: string }): Promise<void> {
    const taskSink = this.options.taskSink;
    const transport = this.transport;
    if (taskSink === undefined || transport === undefined) {
      return;
    }
    if (this.roomDecisionLookup !== undefined && (this.withdrawnRoomIds.has(question.roomId) || !this.roomStillPermitted(question.roomId))) {
      return;
    }
    try {
      const { taskId } = taskSink.createTask({ roomId: question.roomId, questionEventId: question.eventId, requester: question.senderId });
      cardState.taskId = taskId;
      this.emitTaskEvent({ taskId, roomId: question.roomId, state: "acknowledged" });
      const card: DuoCardV1Input = {
        kind: "task",
        cardId: taskId,
        taskId,
        state: "acknowledged",
        requester: question.senderId,
        title: "Looking into this",
        lines: ["Looking into this — I'll update this message."],
      };
      const event = buildCardEvent(card);
      const sent = await transport.sendCard(question.roomId, event);
      const { cardId } = taskSink.createCard({ taskId, roomId: question.roomId, eventId: sent.eventId, kind: "task", audience: "visitor", state: "acknowledged", requester: question.senderId });
      this.emitCardEvent({ cardId, roomId: question.roomId });
    } catch (error) {
      this.consoleError(`sending the ack task card for workspace question ${question.eventId} failed`, error);
    }
  }

  /**
   * W-S4-5: once the outcome has resolved (and the ack timer, if armed,
   * has been cleared), decide what the task/card side needs: create the
   * Task if the ack never fired (the fast path, or a fast `passed_on`),
   * and send or edit exactly one card — never two for one task. Re-checks
   * withdrawn consent itself is NOT needed here: `handleQuestion` already
   * refused to reach this point under withdrawal (the existing check runs
   * first), so this method only runs when the send is actually going out.
   * Returns true when it already sent the `m.text` answer itself (the
   * `answered` branch needs the answer's own sent event id before it can
   * build the `result` link, so it sends there instead of letting
   * `handleQuestion`'s own `sendAnswer` call do it) — the caller must not
   * send it a second time.
   */
  private async resolveOutcomeCard(question: WorkspaceQuestion, decision: AnswerDecision, cardState: { taskId?: string }): Promise<boolean> {
    const taskSink = this.options.taskSink;
    const transport = this.transport;
    if (taskSink === undefined || transport === undefined) {
      return false;
    }
    const outcomeKind = decision.outcomeKind;
    if (outcomeKind === "answered") {
      // A fast answer never gets a task at all (0 cards) — the common case
      // stays byte-identical in cost. A slow answer (the ack fired first)
      // edits that card to done, with a result link at the ANSWER's own
      // sent event — which means the answer must be sent from inside this
      // method, before the edit can be built at all.
      if (cardState.taskId === undefined) {
        return false;
      }
      const openCard = taskSink.openCardFor(cardState.taskId, question.roomId);
      if (openCard === undefined) {
        return false;
      }
      // The real send: once this resolves, the asker has their answer —
      // nothing below this line may ever cause it to be sent again (not a
      // forget, not a retry), because the answer itself did not fail. Any
      // THROW from here still propagates to handleQuestion's own catch
      // (forget + no further send), which is correct: the asker got
      // nothing and a replay should try again. Once this line succeeds,
      // the contract changes: a card-editing problem afterward is the
      // card's problem, never the asker's — logged and swallowed, not
      // forgotten, so a replay is never caused to double-answer just to
      // retry a card edit.
      const sentAnswer = await transport.sendAnswer(question.roomId, decision.content);
      try {
        const permalink = `https://matrix.to/#/${encodeURIComponent(question.roomId)}/${encodeURIComponent(sentAnswer.eventId)}`;
        const card: DuoCardV1Input = {
          kind: "task",
          cardId: openCard.cardId,
          taskId: cardState.taskId,
          state: "done",
          requester: question.senderId,
          title: "Done",
          result: { text: decision.content.body, links: [{ label: "Reply", url: permalink }] },
        };
        const edit = buildCardEdit(openCard.eventId, card, openCard.rev);
        await transport.editCard(question.roomId, openCard.eventId, edit);
        taskSink.recordCardEdit(openCard.cardId, { rev: edit["m.new_content"]["duo.card"].rev, state: "done" });
        taskSink.updateTaskState(cardState.taskId, "complete");
        this.emitCardEvent({ cardId: openCard.cardId, roomId: question.roomId });
        this.emitTaskEvent({ taskId: cardState.taskId, roomId: question.roomId, state: "done" });
      } catch (error) {
        this.consoleError(`editing the task card to done for workspace question ${question.eventId} failed (the answer itself already sent)`, error);
      }
      // The answer already went out above; tell handleQuestion not to send it again.
      return true;
    }
    if (outcomeKind === "passed_on") {
      // Exactly one card total for this path: create the Task now if the
      // ack never fired (fast passed_on), or reuse the one it already
      // created. Either way, send once or edit once — never both for the
      // same task.
      const passedOnText = decision.content.body;
      if (cardState.taskId === undefined) {
        // Fast passed_on: the ack never fired, so this is the FIRST card
        // for this task — unlike the `answered` branch above, the plain-
        // text passed-on message is not gated on anything the card side
        // produces (no sent-event id it needs back), so it is never worth
        // losing to a card failure. Isolate the task-create/card-send pair
        // in its own try/catch, exactly like the `answered` branch isolates
        // its card edit: a failure here is logged and swallowed, and this
        // method still returns `false`, so handleQuestion's own
        // `transport.sendAnswer` call below carries the passed-on text to
        // the asker regardless of whether the card made it out.
        try {
          const { taskId } = taskSink.createTask({
            roomId: question.roomId,
            questionEventId: question.eventId,
            requester: question.senderId,
            draftId: decision.passedOnDraftId,
          });
          cardState.taskId = taskId;
          this.emitTaskEvent({ taskId, roomId: question.roomId, state: "acknowledged" });
          const card: DuoCardV1Input = {
            kind: "task",
            cardId: taskId,
            taskId,
            state: "acknowledged",
            requester: question.senderId,
            title: "Passed on",
            lines: [passedOnText],
          };
          const sent = await transport.sendCard(question.roomId, buildCardEvent(card));
          const { cardId } = taskSink.createCard({ taskId, roomId: question.roomId, eventId: sent.eventId, kind: "task", audience: "visitor", state: "acknowledged", requester: question.senderId });
          this.emitCardEvent({ cardId, roomId: question.roomId });
        } catch (error) {
          this.consoleError(`sending the passed-on task card for workspace question ${question.eventId} failed (the passed-on text will still be sent)`, error);
        }
        return false;
      }
      // The ack already fired: edit that SAME card to carry the passed-on
      // text instead of the ack-timer text — still "acknowledged", still
      // one card. Same isolation as the fast path above: handleQuestion
      // sends `passedOnText` itself once this returns `false`, and the
      // asker already has the ack card on screen either way, so an edit
      // failure here must never block that send.
      taskSink.updateTaskState(cardState.taskId, undefined, { draftId: decision.passedOnDraftId });
      const openCard = taskSink.openCardFor(cardState.taskId, question.roomId);
      if (openCard === undefined) {
        return false;
      }
      try {
        const card: DuoCardV1Input = {
          kind: "task",
          cardId: openCard.cardId,
          taskId: cardState.taskId,
          state: "acknowledged",
          requester: question.senderId,
          title: "Passed on",
          lines: [passedOnText],
        };
        const edit = buildCardEdit(openCard.eventId, card, openCard.rev);
        await transport.editCard(question.roomId, openCard.eventId, edit);
        taskSink.recordCardEdit(openCard.cardId, { rev: edit["m.new_content"]["duo.card"].rev, state: "acknowledged" });
        this.emitCardEvent({ cardId: openCard.cardId, roomId: question.roomId });
        this.emitTaskEvent({ taskId: cardState.taskId, roomId: question.roomId, state: "acknowledged" });
      } catch (error) {
        this.consoleError(`editing the passed-on task card for workspace question ${question.eventId} failed (the passed-on text will still be sent)`, error);
      }
      return false;
    }
    // declined_refused, an attachment refusal (outcomeKind undefined, not
    // a pipeline failure), or the pipeline-failure catch branch
    // (`pipelineFailed`): if a card already exists (the ack fired), edit
    // it — "done"/"Declined" for the first two, "failed" for a genuine
    // pipeline failure — otherwise nothing card-shaped ever happened for
    // this question, and the plain text send below is the whole story,
    // exactly as pre-S4.
    if (cardState.taskId === undefined) {
      return false;
    }
    const openCard = taskSink.openCardFor(cardState.taskId, question.roomId);
    if (openCard === undefined) {
      return false;
    }
    // cards.md §5 has no fixed copy for a bare pipeline failure (only for
    // task/done and the decline path) — PUBLIC_ANSWER_FAILED_MESSAGE is the
    // asker's own m.text for this case (sent unchanged, below), so the
    // card's one line echoes that same fixed vocabulary rather than
    // inventing a second one.
    const card: DuoCardV1Input = decision.pipelineFailed === true
      ? { kind: "task", cardId: openCard.cardId, taskId: cardState.taskId, state: "failed", requester: question.senderId, title: "Failed", lines: [PUBLIC_ANSWER_FAILED_MESSAGE] }
      : { kind: "task", cardId: openCard.cardId, taskId: cardState.taskId, state: "done", requester: question.senderId, title: "Declined", lines: ["Declined"] };
    const edit = buildCardEdit(openCard.eventId, card, openCard.rev);
    await transport.editCard(question.roomId, openCard.eventId, edit);
    taskSink.recordCardEdit(openCard.cardId, { rev: edit["m.new_content"]["duo.card"].rev, state: card.state });
    taskSink.updateTaskState(cardState.taskId, decision.pipelineFailed === true ? "fail" : "complete");
    this.emitCardEvent({ cardId: openCard.cardId, roomId: question.roomId });
    this.emitTaskEvent({ taskId: cardState.taskId, roomId: question.roomId, state: card.state });
    return false;
  }

  /**
   * W-S4-5: one question's decided fate, carrying both the `m.text` content
   * `handleQuestion` always sends (unchanged, byte-identical to before S4)
   * and the card-relevant facts the ack timer/outcome branches need —
   * never more than that. `outcomeKind` is undefined for an attachment
   * refusal (#190): for card purposes a refusal behaves exactly like
   * `declined_refused` (done, "Declined"), so there is no fourth kind to
   * add here — `handleQuestion` treats `undefined` the same way.
   * `passedOnDraftId` is the ONE owner-facing-shaped field that crosses
   * this boundary, and only because it is already asker-adjacent: it is
   * the id the OWNER's existing draft-reply flow already keys on, and it
   * never itself reaches the wire — only `taskSink.createTask` (store-side)
   * and never `cards.ts`'s input type see it. `pipelineFailed` distinguishes
   * a thrown pipeline failure (card → `failed`) from every outcome that
   * resolved normally, including a declined_refused or an attachment
   * refusal (card → `done`, "Declined") — `handleQuestion`'s catch branch
   * sets it; nothing else does.
   */
  private async answerOrRefuse(question: WorkspaceQuestion): Promise<AnswerDecision> {
    // W-S3-1 (#313): a shared-room answer rides as a reply to the question
    // itself — `isDirect` is the one fact `questions.ts`'s two filters
    // already compute, so there is nothing new to derive here. A direct
    // question passes `undefined`, keeping `buildAnswerEvent`'s output the
    // pre-#313 two-key shape byte for byte.
    const replyOptions: Parameters<typeof buildAnswerEvent>[1] = question.isDirect ? undefined : { inReplyTo: question.eventId };
    if (question.attachments.length === 0) {
      const outcome = await this.options.answer(question);
      return { content: buildAnswerEvent(outcome, replyOptions), outcomeKind: outcome.kind, ...(outcome.kind === "passed_on" ? { passedOnDraftId: outcome.draftId } : {}) };
    }
    const door = this.options.attachmentDoor;
    if (door === undefined) {
      this.consoleError(
        `answering workspace question ${question.eventId} text-only`,
        new Error("no attachment grounding door is configured (DUO_CLASSIFICATION_CEILING wiring) — the question's files were not read"),
      );
      const outcome = await this.options.answer({ ...question, grounding: [] });
      return { content: buildAnswerEvent(outcome, replyOptions), outcomeKind: outcome.kind, ...(outcome.kind === "passed_on" ? { passedOnDraftId: outcome.draftId } : {}) };
    }
    // Captured before the door runs (not after): the door fetches file
    // bodies over this very transport, so it must be live now; a connection
    // that stopped mid-question throws here and degrades through
    // handleQuestion's existing failure-event path.
    const transport = this.transport;
    if (transport === undefined) {
      throw new Error("the workspace connection stopped before the attachment door could run");
    }
    const result = await door(question.attachments, (reference, options) => transport.fetchFile(reference, options));
    if (result.kind === "refused") {
      return { content: buildAttachmentRefusalEvent(result.message) };
    }
    const outcome = await this.options.answer({ ...question, grounding: result.grounding });
    return { content: buildAnswerEvent(outcome, replyOptions), outcomeKind: outcome.kind, ...(outcome.kind === "passed_on" ? { passedOnDraftId: outcome.draftId } : {}) };
  }

  /**
   * A durable read-state lookup that degrades, never fails the question: a
   * store error (disk, passphrase, corruption) is logged and reads as
   * "not handled" — the worst outcome is the at-least-once re-answer the
   * pre-#189 daemon always had, never a silently dropped question.
   */
  private queryReadState(question: WorkspaceQuestion): boolean {
    const readState = this.options.readState;
    if (readState === undefined) {
      return false;
    }
    try {
      return readState.hasRead(question.eventId);
    } catch (error) {
      this.consoleError(`checking durable read state for ${question.eventId} failed`, error);
      return false;
    }
  }

  /**
   * A durable read-state write that likewise degrades: if recording fails
   * the answer still went out; the event simply stays unrecorded, so a
   * replay may answer it again — the same at-least-once stance a crash
   * between send and record already has.
   */
  private markRead(question: WorkspaceQuestion, originServerTs: number): void {
    const readState = this.options.readState;
    if (readState === undefined) {
      return;
    }
    try {
      readState.markRead(question.roomId, question.eventId, originServerTs);
    } catch (error) {
      this.consoleError(`recording durable read state for ${question.eventId} failed`, error);
    }
  }

  private setState(patch: Partial<WorkspaceServiceState>): void {
    this.stateValue = { ...this.stateValue, ...patch, since: new Date().toISOString() };
    for (const handler of this.stateHandlers) {
      handler(this.stateValue);
    }
  }

  private consoleError(what: string, error: unknown): void {
    // The daemon runs with no logger wired (the /ask route's own
    // convention, U2 in its plan): console.error is the owner-side error
    // surface for a service that has no request to attach a reply to.
    const detail = error instanceof Error ? error.message : error;
    if (this.options.log) {
      this.options.log(`workspace: ${what}: ${String(detail)}`);
      return;
    }
    console.error(`workspace: ${what}:`, detail);
  }
}
