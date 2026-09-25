import type { PublicAnswerOutcome } from "../permissions/public-answer.js";
import { workspaceDirectoryFrom, type WorkspaceAvailability, type WorkspaceDirectoryEntry } from "./directory.js";
import { buildAnswerEvent, buildFailedAnswerEvent } from "./payload.js";
import { directQuestionFrom } from "./questions.js";
import { AnswerRateWindow, isStaleEvent, type DuoReadState } from "./read-state.js";
import type {
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
  private readonly seenEventIds = new RecentlySeenEventIds(10_000);
  private membersById = new Map<string, WorkspaceMemberIdentity>();
  private readonly answerRate: AnswerRateWindow;
  private answerChain: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceServiceOptions) {
    this.options = options;
    this.answerRate = new AnswerRateWindow(options.settings.backlog.maxAnswersPerMinute);
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
          "workspace access token rejected — not retrying; re-pair the duo on the owner's machine (DUO_WORKSPACE_ACCESS_TOKEN) and restart duo serve",
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
    const question = directQuestionFrom(message, this.options.settings.userId);
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
   * One question's full decided fate, on the serialized chain: dedupe
   * (durable first, then the policies), draft, send, record. The durable
   * row is written only after a successful send — a crash mid-draft leaves
   * the event unrecorded so the post-restart replay re-answers it, the same
   * at-least-once recovery a send failure gets (read-state.ts's stated
   * semantics).
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
    let content;
    try {
      content = buildAnswerEvent(await this.options.answer(question));
    } catch (error) {
      // The asker must never see internals (the /ask route's own rule) —
      // but they also must not stare at silence: send the same generic
      // failure event that route's 500 body comes from, and keep the
      // daemon alive for the next question.
      this.consoleError(`answering workspace question ${question.eventId} failed`, error);
      content = buildFailedAnswerEvent();
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
    try {
      await transport.sendAnswer(question.roomId, content);
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
    console.error(`workspace: ${what}:`, error instanceof Error ? error.message : error);
  }
}
