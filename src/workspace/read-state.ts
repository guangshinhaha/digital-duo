/**
 * #189: the daemon's durable read state and its backlog policy — the #219
 * successor notes' deferred work. #186 shipped dedupe as an in-process
 * FIFO-capped set, so a restart re-answered events still inside the sync
 * window; the send-failure forget was deliberately at-least-once. This
 * module makes "which events has this duo already handled" survive
 * restarts, and states the two policies that keep a wake-up replay from
 * turning into a flood of stale or simultaneous answers:
 *
 * - **Backlog age policy** (`DUO_WORKSPACE_BACKLOG_MAX_AGE_MS`, default
 *   1h): a question event whose homeserver timestamp is older than the
 *   window is marked read and never answered. A duo waking after a night
 *   asleep must not reply to yesterday's messages — the asker moved on;
 *   the zombie answer is worse than the silence. The event time is the
 *   homeserver's (`origin_server_ts`), the comparison the daemon clock's:
 *   modest clock skew is absorbed by the default's headroom.
 * - **Answer rate bound** (`DUO_WORKSPACE_MAX_ANSWERS_PER_MINUTE`,
 *   default 30, a sliding 60s window counted at send time): the answering
 *   pipeline is a scarce resource — an LLM draft and a store decrypt per
 *   question — so a burst (a sync replay of everything the homeserver held,
 *   or a live flood) may only enqueue this many per rolling minute.
 *   Excess events are suppressed for the process and logged owner-side,
 *   never queued — and deliberately NOT durably marked: the bound is a
 *   statement about this process's capacity, not a verdict on the event,
 *   so a flooding sender cannot permanently silence fresh questions that
 *   merely arrived behind the flood; a restart replays those against a
 *   fresh window. The default sits above the pipeline's natural serialized
 *   throughput, so steady-state conversation never meets it — only floods
 *   do.
 *
 * Both knobs default sanely and are configuration precisely so #188 (the
 * asleep-duo decision record) can retune hold/backlog behavior without a
 * code change — the same stance #186's reconnect/presence knobs took.
 *
 * ## Durability semantics: still at-least-once, now across restarts
 *
 * The durable row is written **after** a successful send; an age-skipped
 * event is marked too (though the store's retention — the same window —
 * makes that mark a no-op row, because re-deciding an over-window event
 * always lands on the same skip); a rate-skipped event is never marked
 * (above). A crash mid-draft therefore leaves the event unrecorded, and
 * the post-restart sync replay re-answers it — the same at-least-once
 * recovery a send failure gets (#186's stance, preserved). The cost is
 * symmetric: a crash between a successful send and its recording can
 * double-answer once. Durable suppression of answered work and
 * never-lose-a-question could not both be had; losing questions is the
 * intolerable side, so at-least-once it is.
 *
 * ## Persistence arrives by injection
 *
 * `DuoReadState` is defined here but implemented outside `src/workspace/`:
 * the pinned import scan (test/workspace-payload.test.ts) forbids this
 * directory from reaching into the store modules, exactly as it does the
 * answer pipeline — so the encrypted-store implementation lives in
 * `src/serve/workspace-read-state.ts` and `runServe` wires it in. Tests
 * use `InMemoryDuoReadState` or their own fake.
 */

/**
 * The duo's own durable record of which workspace events it has handled —
 * its private read position, per conversation, surviving restarts in the
 * encrypted personal store. "Handled" means the event reached a verdict
 * this daemon stands behind across restarts: an answered question above
 * all, and an age-skipped one by policy (read-state.ts's semantics section
 * states which skips record and which deliberately do not). This is
 * deliberately not a message store (docs/workspace-platform.md §1): it
 * holds event ids and their homeserver timestamps, nothing readable.
 */
export interface DuoReadState {
  /** True when this daemon has already handled the event, in this or a previous process. */
  hasRead(eventId: string): boolean;
  /**
   * Records a handled event. Implementations prune rows older than the
   * retention they were constructed with (the backlog age window): beyond
   * that window the age policy — not this table — is the protection, so
   * durable memory spans exactly the window it needs and no further.
   */
  markRead(roomId: string, eventId: string, originServerTs: number): void;
}

/** An in-memory `DuoReadState` — tests, and any wiring with no store behind it. */
export class InMemoryDuoReadState implements DuoReadState {
  private readonly events = new Set<string>();

  hasRead(eventId: string): boolean {
    return this.events.has(eventId);
  }

  markRead(_roomId: string, eventId: string, _originServerTs: number): void {
    this.events.add(eventId);
  }
}

/** The backlog policy knobs as the service consumes them (validated in settings.ts, defaulted in config.ts). */
export interface WorkspaceBacklogPolicy {
  readonly maxAgeMs: number;
  readonly maxAnswersPerMinute: number;
}

/** The rate bound's window — a rolling minute is the stated semantic, so it is a constant, not a knob. */
export const ANSWER_RATE_WINDOW_MS = 60_000;

/**
 * The backlog age policy: is this event older than the window at `now`?
 * Pure, so the boundary is testable without a clock rig — both timestamps
 * are epoch milliseconds.
 */
export function isStaleEvent(originServerTs: number, now: number, maxAgeMs: number): boolean {
  return originServerTs < now - maxAgeMs;
}

/**
 * The answer rate bound: a sliding 60-second window over send timestamps.
 * `allows(now)` counts the window and never mutates; `record(now)` adds a
 * send — callers record only when an answer actually went out, so the
 * bound measures pipeline load, not intentions.
 */
export class AnswerRateWindow {
  private readonly sentAt: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  allows(now: number): boolean {
    return this.recent(now).length < this.maxPerMinute;
  }

  record(now: number): void {
    this.sentAt.push(now);
  }

  private recent(now: number): number[] {
    while (this.sentAt.length > 0 && this.sentAt[0]! <= now - ANSWER_RATE_WINDOW_MS) {
      this.sentAt.shift();
    }
    return this.sentAt;
  }
}
