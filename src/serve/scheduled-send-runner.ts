import type { EditClassifier } from "../corrections/classify.js";
import { recordOutcomeAndDeliver, type ChannelAdapter } from "../drafting/delivery.js";
import { listScheduledSends, settleScheduledSend, type ScheduledSend } from "../drafting/scheduled-sends.js";

/**
 * Fires held sends (guangshinhaha/duo#261) when their time comes, through the
 * same `recordOutcomeAndDeliver` seam a Send tap uses — nothing about the
 * message the colleague receives differs from one sent there and then.
 *
 * A timer, not a poll: the store is an encrypted file decrypted whole on
 * every read (`withDatabase`), so this reads it only at start, after a
 * schedule or a cancel (`rearm`), and when the earliest held send comes due.
 * The timer is capped so a send weeks out still re-reads the store now and
 * then (a `setTimeout` past ~24.8 days overflows), and unref'd so a held send
 * never keeps a process alive on its own.
 *
 * Restart-safe by construction: the hold is a row in the store, and `start`
 * fires anything already overdue — a send that came due while the daemon was
 * down goes out the moment it is back. A crash between recording the outcome
 * and settling the row cannot double-send: on the next run the draft already
 * has its outcome, the seam refuses it (`DraftAlreadySettledError`), and the
 * row settles as `superseded` with nothing delivered again.
 */
export interface ScheduledSendRunnerDeps {
  readonly storePath: string;
  readonly passphrase: string;
  /** Read at fire time, not at construction, so an adapter registered later is the one that delivers. */
  readonly channelAdapters: () => readonly ChannelAdapter[] | undefined;
  readonly classifier?: () => EditClassifier | undefined;
  readonly now?: () => Date;
  /** Longest single wait before the store is re-read. Default one hour. */
  readonly maxWaitMs?: number;
  /** Told about each fired send, for logging. */
  readonly onFired?: (draftId: string, state: "sent" | "superseded" | "failed") => void;
}

const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const MIN_WAIT_MS = 1000;

export class ScheduledSendRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private held: ReadonlySet<string> = new Set();

  constructor(private readonly deps: ScheduledSendRunnerDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Fires anything already overdue, then waits for the next one. One store read when nothing is due. */
  start(): void {
    this.stopped = false;
    void this.runDue();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * The drafts held right now, as of the last re-read — every schedule,
   * cancel and fire re-reads, so this is current without decrypting the
   * store again on every `GET /drafts?outcome=pending`.
   */
  heldDraftIds(): ReadonlySet<string> {
    return this.held;
  }

  /** Re-reads the store for the earliest held send and waits for it — call after anything changes the schedule. */
  rearm(): void {
    if (this.stopped) {
      return;
    }
    this.arm(this.refresh());
  }

  /** Reads what is held, keeping `heldDraftIds` current; undefined when the store cannot be read (the duo was ended). */
  private refresh(): ScheduledSend[] | undefined {
    try {
      const held = listScheduledSends(this.deps.storePath, this.deps.passphrase);
      this.held = new Set(held.map((send) => send.draftId));
      return held;
    } catch {
      this.held = new Set();
      return undefined;
    }
  }

  /** Waits for the earliest of `held` (soonest first, as listed). */
  private arm(held: readonly ScheduledSend[] | undefined): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const next = held?.[0]?.sendAt;
    if (this.stopped || next === undefined) {
      return;
    }
    // Floored at a second: a row that somehow failed to settle must not spin this into a tight loop.
    const wait = Math.max(MIN_WAIT_MS, Math.min(Date.parse(next) - this.now().getTime(), this.deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue();
    }, wait);
    this.timer.unref?.();
  }

  /**
   * Fires every held send whose time has come, one at a time, then re-arms.
   * Never rejects. Overlapping calls share one run, so a send is never
   * handed to the seam twice by this process.
   */
  runDue(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    this.running = this.fireDue().then(
      (unchanged) => {
        this.running = undefined;
        // Nothing fired: the list just read is still the schedule, so no second read.
        if (unchanged) {
          this.arm(unchanged);
        } else {
          this.rearm();
        }
      },
      () => {
        this.running = undefined;
        this.rearm();
      },
    );
    return this.running;
  }

  /** Resolves with the list it read when nothing was due (so the caller need not read again), else undefined. */
  private async fireDue(): Promise<ScheduledSend[] | undefined> {
    if (this.stopped) {
      return undefined;
    }
    const held = this.refresh();
    if (held === undefined) {
      return [];
    }
    const now = this.now().getTime();
    const due = held.filter((send) => Date.parse(send.sendAt) <= now);
    if (due.length === 0) {
      return held;
    }
    for (const send of due) {
      if (this.stopped) {
        return undefined;
      }
      let state: "sent" | "superseded" | "failed" = "sent";
      let reason: string | null = null;
      try {
        await recordOutcomeAndDeliver(this.deps.storePath, this.deps.passphrase, send.draftId, send.outcome, send.sentText ?? undefined, {
          classifier: this.deps.classifier?.(),
          channelAdapters: this.deps.channelAdapters() ?? [],
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        state = name === "DraftAlreadySettledError" ? "superseded" : "failed";
        reason = error instanceof Error ? error.message : String(error);
      }
      try {
        settleScheduledSend(this.deps.storePath, this.deps.passphrase, send.draftId, state, state === "sent" ? null : reason, this.now());
      } catch {
        // The store went away mid-run; the draft's own row is the truth of what happened.
      }
      this.deps.onFired?.(send.draftId, state);
    }
    return undefined;
  }
}
