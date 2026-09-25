import type { PublicAnswerOutcome } from "../permissions/public-answer.js";
import { buildAnswerEvent, buildFailedAnswerEvent } from "./payload.js";
import { directQuestionFrom } from "./questions.js";
import type { WorkspaceCandidateMessage, WorkspaceQuestion, WorkspaceTransport, WorkspaceTransportFactory } from "./transport.js";
import type { WorkspaceSettings } from "./settings.js";

/** The connection phases #187's availability states will read. */
export type WorkspacePhase = "stopped" | "connecting" | "connected";

/**
 * #186 AC4: disconnection as a recorded state, not an error. `phase` is the
 * daemon's own outbound-connection state; `lastAliveAt` is when it last
 * successfully reported liveness to the homeserver (the server-side
 * presence/last-seen the asker side eventually sees); `attempts` counts
 * consecutive failed dials so an observer can tell "connecting" (fresh)
 * from "connecting" (backing off after the ninth try).
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

export interface WorkspaceServiceOptions {
  readonly settings: WorkspaceSettings;
  readonly transportFactory: WorkspaceTransportFactory;
  readonly answer: WorkspaceAnswerPipeline;
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
 * Event ids this daemon has already answered, FIFO-capped: the set only
 * needs to cover a sync-replay window after a reconnect (how far back the
 * homeserver's sync replays), so the oldest ids are evicted once the cap is
 * hit rather than growing for a daemon's whole lifetime. Durable dedupe
 * across restarts is #189's read state, not this.
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
 * dial-and-hold, reconnect with backoff, presence reporting, and the
 * question→answer loop. Everything above the transport seam — this class —
 * is transport-agnostic and fully covered by tests against a fake.
 *
 * Held-not-lost needs no queue here, and none is built (docs/workspace-
 * platform.md: Matrix gives sync/queueing as library capability). The
 * homeserver holds events for an offline duo; `connect()` resolving means
 * sync has caught up; the held events then arrive through `onMessage` and
 * are answered like any other question. The service's own obligations are
 * only to come back (backoff), stay observable (state), and not answer the
 * same event twice (in-process dedupe by event id — #189's read-state work
 * owns durable dedupe across restarts; the one exception is an answer whose
 * send failed, which is forgotten so the replay re-answers it).
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
  private answerChain: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceServiceOptions) {
    this.options = options;
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
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopPresenceRefresh();
    this.consecutiveFailures = 0;
    this.setState({ phase: "stopped", lastAliveAt: this.stateValue.lastAliveAt, attempts: 0 });
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
    // call, and a burst of held questions replaying after a reconnect must
    // not interleave drafts inside it.
    this.answerChain = this.answerChain.then(() => this.answerOne(question)).catch(() => {
      // answerOne already handles its own failures; this catch only exists
      // so the chain itself can never reject and poison the next question.
    });
  }

  private async answerOne(question: WorkspaceQuestion): Promise<void> {
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
      // delivery, deliberately, until #189's durable read state tightens it.
      this.seenEventIds.forget(question.eventId);
      this.consoleError(`sending workspace answer for ${question.eventId} failed`, error);
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
