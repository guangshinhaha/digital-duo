import { format } from "node:util";
import type { DuoConfig } from "../config.js";
import { createDuoWorkspaceService, type DuoWorkspaceInputs } from "../serve/workspace-wiring.js";
import type { WorkspaceService, WorkspacePhase } from "../workspace/service.js";
import { workspaceSettingsFrom, type WorkspaceSettings } from "../workspace/settings.js";
import type { WorkspaceTransport, WorkspaceTransportFactory } from "../workspace/transport.js";
import type { MatrixSdkLogger } from "../workspace/matrix-transport.js";
import type { HostedRegistry } from "./registry.js";

/**
 * Each hosted duo's own outbound workspace connection (docs/deploy/hosted-workspace.md §8, #236).
 *
 * A hosted duo answers in the workspace exactly as a `duo serve` daemon does: one Matrix account
 * (the duo's own, `@duo-<orgId>.<handle>:<server>`), one held sync, and the same `WorkspaceService`
 * over that duo's own store. What differs is where the credentials come from and how many there
 * are: the token is the duo's, read from the registry (`registry.duoMatrixToken`, the only reader
 * of it) and never from the environment, and there is one connection per provisioned duo in one
 * process.
 *
 * - **Lifecycle follows the registry.** `reconcile` compares each attached duo with what the
 *   registry says about its accounts: accounts appear, the connection is started; the token is
 *   re-minted (a different ciphertext), the connection restarts; the accounts go, it stops. The
 *   daemon calls it from the registry's own change hook, so no writer has to remember to.
 * - **Never on the boot path.** `reconcile` only queues. Building a duo's service (it decrypts the
 *   duo's store once) and dialing happen later, one duo at a time off a timer, so a slow or absent
 *   Synapse costs the listener and invite redemption nothing.
 * - **No stampede.** At most `maxConcurrentDials` duos are dialing at once and dials start at
 *   least `startStaggerMs` apart. That holds for every dial, not only the first: a duo's service
 *   rebuilds its client (and so a full initial sync) on each reconnect, so a Synapse restart that
 *   drops all N duos sends N reconnects through the same slots. A slot is given back when a duo
 *   connects, fails that attempt, is revoked, or has held it for `dialSlotMaxMs`. The service's own
 *   backoff, with a per-duo jitter on its delays, spaces a duo's attempts.
 * - **Failures heal.** A duo whose service cannot be built (a store that will not open, a full disk)
 *   is retried after a capped, jittered backoff. A duo Synapse refuses (`M_UNKNOWN_TOKEN`: the
 *   database was reset or restored from before the mint) is given a fresh token through `remint`,
 *   after a backoff and at most `maxRemints` times until it connects; the new token is a registry
 *   write, which restarts the connection like any re-mint.
 * - **Isolated.** Each duo has its own service, transport, backoff, read state and log context.
 *   All work on one duo is serialized on that duo's own chain, so one duo's hang or failure
 *   waits on nothing but itself.
 * - **Logs name the duo, never the token.** Every line carries the duo id, and the duo's token
 *   (and anything shaped like a Matrix access token) is replaced before a line leaves.
 */

export interface DuoWorkspaceConnectionsOptions {
  readonly registry: HostedRegistry;
  /** Timing knobs and the backlog policy (`DUO_WORKSPACE_RECONNECT_*`, `_PRESENCE_INTERVAL_MS`, `_BACKLOG_*`) come from here; its homeserver trio is ignored. */
  readonly config: DuoConfig;
  /** `DUO_WORKSPACE_PRIVATE_URL`: Synapse as the daemon reaches it. https, or http on `*.railway.internal`. */
  readonly homeserverUrl: string;
  /** How a duo's transport is built. Default: the matrix-js-sdk adapter, imported on first use. */
  readonly transportFactory?: WorkspaceTransportFactory;
  /** At most this many duos in their first dial at once. Default 5. */
  readonly maxConcurrentDials?: number;
  /** Least time between two duos starting to dial. Default 500 ms. */
  readonly startStaggerMs?: number;
  /** A duo holds its dial slot for at most this long, so a hung first dial cannot hold the gate. Default 30 s. */
  readonly dialSlotMaxMs?: number;
  /** One line per event (default: stderr). Carries duo ids, never tokens. */
  readonly log?: (line: string) => void;
  /**
   * How much of matrix-js-sdk's own logging reaches the console, when the default transport is used.
   * Default `silent`: the SDK's logger is process-wide, prints two lines per duo per sync round at its
   * default level, and its lines cannot name a duo. Every duo's state and failures are logged here
   * instead, by duo id; what the SDK is let to say is prefixed with the duo's Matrix id. Raise it (`DUO_HOSTED_WORKSPACE_SDK_LOG`) to debug a real homeserver.
   */
  readonly sdkLogLevel?: SdkLogLevel;
  /**
   * Mints a duo a fresh token (`MatrixProvisioner.remintToken`) and stores it in the registry, where
   * the connection notices it. Called on its own, with a backoff, for a duo whose token Synapse
   * refused. Absent: a refused duo stays stopped until an admin re-mints it. It resolves with a
   * status (`reminted` is success) and never throws for a Synapse problem.
   */
  readonly remint?: (duoId: string) => Promise<{ readonly status: string; readonly error?: string }>;
  /** First wait before retrying a duo that failed to build, or before a re-mint; doubles per failure. Default one minute. */
  readonly recoveryBaseMs?: number;
  /** The wait never grows past this (before the per-duo jitter of up to 1.5x). Default thirty minutes. */
  readonly recoveryMaxMs?: number;
  /** A duo is re-minted at most this many times until one of its tokens connects; then it waits for an admin. Default 5. */
  readonly maxRemints?: number;
}

export type SdkLogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";
export const SDK_LOG_LEVELS: readonly SdkLogLevel[] = ["silent", "error", "warn", "info", "debug", "trace"];

export const DEFAULT_MAX_CONCURRENT_DIALS = 5;
export const DEFAULT_START_STAGGER_MS = 500;
export const DEFAULT_DIAL_SLOT_MAX_MS = 30_000;
export const DEFAULT_RECOVERY_BASE_MS = 60_000;
export const DEFAULT_RECOVERY_MAX_MS = 30 * 60_000;
export const DEFAULT_MAX_REMINTS = 5;

/** What an admin may see of one duo's connection: ids and phase, never a token. */
export interface DuoConnectionState {
  readonly duoId: string;
  readonly userId: string | undefined;
  /** `queued` waiting for a dial slot, `failed` could not be built (its store would not open), `none` no accounts yet, else the service's own phase. */
  readonly phase: WorkspacePhase | "queued" | "failed" | "none";
  readonly attempts: number;
}

interface Running {
  readonly fingerprint: string;
  readonly service: WorkspaceService;
  /** Gives back whatever dial slot the duo holds now (first dial or reconnect). Idempotent. */
  readonly releaseSlot: () => void;
}

/** Someone waiting for a dial slot: a duo's first dial, or a running service's reconnect. */
interface Waiter {
  readonly entry: Entry;
  /** False once the wait no longer matters (the duo was torn down or replaced); the pump skips it. */
  alive(): boolean;
  /** Hands over the slot, with the function that gives it back. */
  grant(release: () => void): void;
  /** The wait is abandoned. */
  cancel(): void;
}

interface Entry {
  readonly duoId: string;
  readonly duo: DuoWorkspaceInputs;
  /** What the registry said last time `settle` looked: the accounts' fingerprint, or undefined for no accounts. */
  wanted: string | undefined;
  running: Running | undefined;
  /** Set while the duo waits in the dial queue; cleared when it is dispatched or torn down. */
  queued: boolean;
  failed: boolean;
  /** Consecutive builds that failed; sets the retry backoff. Zero once a service is built. */
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Re-mints tried since a token last connected; capped by `maxRemints`. */
  remints: number;
  remintTimer: ReturnType<typeof setTimeout> | undefined;
  remintGaveUp: boolean;
  /** Everything that changes this duo's connection runs here, one after another. */
  chain: Promise<void>;
}

/** A duo's accounts as a change detector: a re-minted token has a different ciphertext (random IV), a different account another id. Not secret, and not the token. */
function fingerprintOf(accounts: { duoUserId: string; duoTokenCipher: string }): string {
  return `${accounts.duoUserId}|${accounts.duoTokenCipher}`;
}

/** 1.0 to 1.5, fixed per duo: spreads the duos' reconnect delays so ones that failed together do not retry together. */
export function jitterFactor(duoId: string): number {
  let hash = 0;
  for (let index = 0; index < duoId.length; index += 1) {
    hash = (Math.imul(hash, 31) + duoId.charCodeAt(index)) >>> 0;
  }
  return 1 + (hash % 500) / 1000;
}

/**
 * matrix-js-sdk logs through one process-wide logger whose child loggers keep their own levels and
 * cannot be told which duo they belong to. So each duo's client is given its own logger, which drops
 * everything below `level` and hands what it keeps to `log`: the duo's own scrubbed logger, so a line
 * names the duo, has the token taken out, and goes where every other line for that duo goes.
 *
 * It covers what the client itself logs (its constructor's `logger` option, and what it passes to the
 * things it builds). matrix-js-sdk 42.4.0 still calls the process-wide logger directly from
 * `models/room.js`, `models/event.js`, `models/event-timeline-set.js` and `sync.js`; those lines cannot
 * name a duo and are neither filtered nor scrubbed by this (docs/deploy/hosted-workspace.md §8).
 */
export function sdkLoggerFor(level: SdkLogLevel, log: (line: string) => void): MatrixSdkLogger {
  const rank = SDK_LOG_LEVELS.indexOf(level);
  const emit = (method: "error" | "warn" | "info" | "debug" | "trace") => (...args: unknown[]): void => {
    if (rank > 0 && SDK_LOG_LEVELS.indexOf(method) <= rank) {
      try {
        log(`matrix sdk ${method}: ${format(...args)}`);
      } catch {
        // A logger that cannot format its arguments must not break the client that called it.
      }
    }
  };
  const logger: MatrixSdkLogger = { error: emit("error"), warn: emit("warn"), info: emit("info"), debug: emit("debug"), trace: emit("trace"), getChild: () => logger };
  return logger;
}

function matrixTransportFactory(sdkLogLevel: SdkLogLevel, log: (line: string) => void): WorkspaceTransportFactory {
  return async (settings) => {
    const { createMatrixTransport } = await import("../workspace/matrix-transport.js");
    return createMatrixTransport(settings, { sdkLogger: sdkLoggerFor(sdkLogLevel, log) });
  };
}

/** `text` with the duo's token, and anything shaped like a Matrix access token, taken out. */
function scrubToken(text: string, token: string | undefined): string {
  return (token ? text.split(token).join("[redacted]") : text).replace(/syt_[A-Za-z0-9_-]+/g, "[redacted]");
}

export class DuoWorkspaceConnections {
  private readonly entries = new Map<string, Entry>();
  private queue: Waiter[] = [];
  /** A detached duo's last step, so a duo attached under the same id waits for its teardown. */
  private readonly detaching = new Map<string, Promise<void>>();
  private readonly maxConcurrentDials: number;
  private readonly startStaggerMs: number;
  private readonly dialSlotMaxMs: number;
  private readonly recoveryBaseMs: number;
  private readonly recoveryMaxMs: number;
  private readonly maxRemints: number;
  private readonly log: (line: string) => void;
  private activeDials = 0;
  private lastDispatchAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: DuoWorkspaceConnectionsOptions) {
    this.maxConcurrentDials = options.maxConcurrentDials ?? DEFAULT_MAX_CONCURRENT_DIALS;
    this.startStaggerMs = options.startStaggerMs ?? DEFAULT_START_STAGGER_MS;
    this.dialSlotMaxMs = options.dialSlotMaxMs ?? DEFAULT_DIAL_SLOT_MAX_MS;
    this.recoveryBaseMs = options.recoveryBaseMs ?? DEFAULT_RECOVERY_BASE_MS;
    this.recoveryMaxMs = options.recoveryMaxMs ?? DEFAULT_RECOVERY_MAX_MS;
    this.maxRemints = options.maxRemints ?? DEFAULT_MAX_REMINTS;
    this.log = options.log ?? ((line) => console.error(line));
    if (!Number.isInteger(this.maxConcurrentDials) || this.maxConcurrentDials < 1) {
      throw new Error(`The workspace connection dial limit must be a whole number of at least 1 (got ${JSON.stringify(this.maxConcurrentDials)}).`);
    }
    if (!Number.isFinite(this.startStaggerMs) || this.startStaggerMs < 0) {
      throw new Error(`The workspace connection stagger must be a number of milliseconds, 0 or more (got ${JSON.stringify(this.startStaggerMs)}).`);
    }
    if (!Number.isFinite(this.recoveryBaseMs) || this.recoveryBaseMs < 0 || !Number.isFinite(this.recoveryMaxMs) || this.recoveryMaxMs < this.recoveryBaseMs) {
      throw new Error("The workspace connection recovery backoff must be a base of 0 or more milliseconds and a maximum no smaller than it.");
    }
    if (!Number.isInteger(this.maxRemints) || this.maxRemints < 0) {
      throw new Error(`The workspace connection re-mint limit must be a whole number, 0 or more (got ${JSON.stringify(this.maxRemints)}).`);
    }
    // Refuse a bad timing knob or homeserver URL at boot, once, with a placeholder credential: the
    // same all-or-nothing refusal `duo serve` gives, instead of one failed connection per duo later.
    this.settingsFor("probe", "@probe:probe", "probe-not-a-token");
  }

  /** Tells the manager a mounted duo exists and what it answers from. Nothing connects until the registry says the duo has accounts. */
  attach(duoId: string, duo: DuoWorkspaceInputs): void {
    if (this.stopped || this.entries.has(duoId)) {
      return;
    }
    this.entries.set(duoId, {
      duoId,
      duo,
      wanted: undefined,
      running: undefined,
      queued: false,
      failed: false,
      failures: 0,
      retryTimer: undefined,
      remints: 0,
      remintTimer: undefined,
      remintGaveUp: false,
      // Behind the last teardown of a duo detached under this id, so two services for one duo can never overlap.
      chain: this.detaching.get(duoId) ?? Promise.resolve(),
    });
    this.reconcile();
  }

  /** The duo is gone: stop its connection. Resolves once it is stopped. */
  async detach(duoId: string): Promise<void> {
    const entry = this.entries.get(duoId);
    if (!entry) {
      return;
    }
    this.entries.delete(duoId);
    entry.wanted = undefined;
    const done = this.enqueue(entry, () => this.teardown(entry));
    this.detaching.set(duoId, done);
    try {
      await done;
    } finally {
      if (this.detaching.get(duoId) === done) {
        this.detaching.delete(duoId);
      }
    }
  }

  /**
   * Brings every attached duo's connection in line with the registry. Synchronous and cheap (one
   * registry read per duo); it only queues work. Safe to call as often as the registry changes.
   */
  reconcile(): void {
    if (this.stopped) {
      return;
    }
    for (const entry of this.entries.values()) {
      this.settle(entry);
    }
  }

  /** The duo's live service, for its owner routes (held invitations, consent), or undefined when it has none. */
  serviceFor(duoId: string): WorkspaceService | undefined {
    return this.entries.get(duoId)?.running?.service;
  }

  states(): DuoConnectionState[] {
    return [...this.entries.values()].map((entry) => {
      const state = entry.running?.service.state();
      const accounts = this.options.registry.matrixAccounts(entry.duoId);
      return {
        duoId: entry.duoId,
        userId: accounts?.duoUserId,
        phase: entry.failed ? "failed" : state ? state.phase : entry.queued ? "queued" : "none",
        attempts: state?.attempts ?? 0,
      };
    });
  }

  /** Resolves when nothing is being built, torn down or waiting for a dial slot. For tests and orderly shutdown. */
  async whenSettled(): Promise<void> {
    for (;;) {
      const chains = [...this.entries.values()].map((entry) => entry.chain);
      await Promise.all(chains);
      if (this.queue.length === 0 && this.pumpTimer === undefined && [...this.entries.values()].every((entry) => !entry.queued)) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Stops every connection, cancels the dial queue and its timers. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pumpTimer !== undefined) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    for (const waiter of this.queue.splice(0)) {
      waiter.cancel();
    }
    const entries = [...this.entries.values()];
    // In parallel, and settled not raced: one duo's stop hanging or throwing is that duo's, and the rest still stop.
    await Promise.allSettled(entries.map((entry) => this.enqueue(entry, () => this.teardown(entry))));
  }

  /** Compares one duo with the registry; on a difference, tears down what runs and queues a start if the duo still has accounts. */
  private settle(entry: Entry): void {
    const accounts = this.options.registry.matrixAccounts(entry.duoId);
    const wanted = accounts ? fingerprintOf(accounts) : undefined;
    if (wanted === entry.wanted) {
      return;
    }
    entry.wanted = wanted;
    entry.failed = false;
    entry.failures = 0;
    void this.enqueue(entry, async () => {
      try {
        await this.teardown(entry);
      } finally {
        // Even when stopping the old service threw: `wanted` is already the registry's word, and the restart must not be lost with the error.
        if (entry.wanted === wanted && wanted !== undefined && !this.stopped) {
          this.queueDial(entry);
        }
      }
    });
  }

  /** Runs `work` on the duo's own chain. Never rejects: a duo's failure is logged by name and ends there. */
  private enqueue(entry: Entry, work: () => Promise<void>): Promise<void> {
    const next = entry.chain.then(work).catch((error: unknown) => {
      this.say(entry.duoId, `workspace connection step failed (${this.describe(entry.duoId, error)})`);
    });
    entry.chain = next;
    return next;
  }

  private async teardown(entry: Entry): Promise<void> {
    entry.queued = false;
    for (const timer of [entry.retryTimer, entry.remintTimer]) {
      clearTimeout(timer);
    }
    entry.retryTimer = undefined;
    entry.remintTimer = undefined;
    const running = entry.running;
    entry.running = undefined;
    // `stop()` has cleared the service's `running` flag by the time it returns its promise, so a reconnect
    // still waiting for a slot fails quietly when it is cancelled below rather than being retried.
    const stopping = running?.service.stop();
    this.queue = this.queue.filter((waiter) => {
      if (waiter.entry !== entry) {
        return true;
      }
      waiter.cancel();
      return false;
    });
    if (!running) {
      return;
    }
    running.releaseSlot();
    await stopping;
  }

  private queueDial(entry: Entry): void {
    if (entry.queued) {
      return;
    }
    entry.queued = true;
    this.queue.push({
      entry,
      alive: () => entry.queued && this.entries.get(entry.duoId) === entry,
      cancel: () => {},
      grant: (releaseSlot) => {
        entry.queued = false;
        const fingerprint = entry.wanted;
        void this.enqueue(entry, async () => {
          try {
            await this.startService(entry, fingerprint, releaseSlot);
          } catch (error) {
            // Building the service failed (a store that will not open, a token that will not decrypt): this duo only, and not for good.
            entry.failed = true;
            entry.failures += 1;
            releaseSlot();
            this.say(entry.duoId, `workspace connection could not be started (${this.describe(entry.duoId, error)}); will try again`);
            this.scheduleRetry(entry);
          }
        });
      },
    });
    this.schedulePump(0);
  }

  /** Waits for a dial slot, for a running service's reconnect. Rejects if the duo is torn down or the daemon stops first. */
  private acquireSlot(entry: Entry): Promise<() => void> {
    if (this.stopped) {
      return Promise.reject(new Error("the workspace connections are stopping"));
    }
    return new Promise<() => void>((resolve, reject) => {
      let cancelled = false;
      this.queue.push({
        entry,
        alive: () => !cancelled,
        cancel: () => {
          cancelled = true;
          reject(new Error("the duo's workspace connection was stopped"));
        },
        grant: resolve,
      });
      this.schedulePump(0);
    });
  }

  /** How long a duo that keeps failing waits: doubling, capped, then spread by the duo's own jitter so duos that failed together do not retry together. */
  private recoveryDelayMs(duoId: string, failures: number): number {
    const capped = Math.min(this.recoveryBaseMs * 2 ** Math.min(failures - 1, 30), this.recoveryMaxMs);
    return Math.round(capped * jitterFactor(duoId));
  }

  /** A timer that never keeps the process alive: recovery is the daemon's business while it runs. */
  private later(delayMs: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    return timer;
  }

  /** A duo that failed to build is tried again after a backoff, unless its registry state changed meanwhile (`settle` then owns it). */
  private scheduleRetry(entry: Entry): void {
    if (this.stopped || entry.retryTimer !== undefined) {
      return;
    }
    entry.retryTimer = this.later(this.recoveryDelayMs(entry.duoId, entry.failures), () => {
      entry.retryTimer = undefined;
      void this.enqueue(entry, async () => {
        if (!this.stopped && entry.failed && entry.wanted !== undefined && this.entries.get(entry.duoId) === entry) {
          entry.failed = false;
          this.queueDial(entry);
        }
      });
    });
  }

  /**
   * A duo Synapse refused: ask for a new token after a backoff, at most `maxRemints` times until a token
   * connects. Each success is a registry write, so `reconcile` restarts the duo with it; each failure
   * (Synapse down) comes back here for a longer wait. The cap is what stops a token that Synapse
   * accepts to mint but refuses to sync with from minting tokens for ever.
   */
  private scheduleRemint(entry: Entry): void {
    if (!this.options.remint || this.stopped || entry.remintTimer !== undefined) {
      return;
    }
    if (entry.remints >= this.maxRemints) {
      if (!entry.remintGaveUp) {
        entry.remintGaveUp = true;
        this.say(entry.duoId, `gave up minting a new token after ${entry.remints} attempts; an admin must run \`duo hosted provision --remint ${entry.duoId}\``);
      }
      return;
    }
    const delay = this.recoveryDelayMs(entry.duoId, entry.remints + 1);
    this.say(entry.duoId, `will mint a new token in about ${Math.max(1, Math.round(delay / 1000))} s (attempt ${entry.remints + 1} of ${this.maxRemints})`);
    entry.remintTimer = this.later(delay, () => {
      entry.remintTimer = undefined;
      if (this.stopped || this.entries.get(entry.duoId) !== entry || entry.running?.service.state().phase !== "revoked") {
        return;
      }
      entry.remints += 1;
      void this.runRemint(entry);
    });
  }

  /** Off the duo's chain: a hung Synapse must not hold up that duo's teardown. The registry write it ends in is what restarts the connection. */
  private async runRemint(entry: Entry): Promise<void> {
    try {
      const outcome = await this.options.remint!(entry.duoId);
      if (outcome.status === "reminted") {
        this.say(entry.duoId, "minted a new token; reconnecting with it");
        return;
      }
      this.say(entry.duoId, `could not mint a new token (${outcome.status}${outcome.error ? `: ${this.scrubText(entry.duoId, outcome.error)}` : ""})`);
    } catch (error) {
      this.say(entry.duoId, `could not mint a new token (${this.describe(entry.duoId, error)})`);
    }
    this.scheduleRemint(entry);
  }

  private schedulePump(delayMs: number): void {
    if (this.stopped || this.pumpTimer !== undefined) {
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, delayMs);
  }

  /** Starts queued duos while a slot is free and the stagger has passed. Always driven from a timer, never inline, so it cannot run inside boot. */
  private pump(): void {
    while (!this.stopped && this.queue.length > 0 && this.activeDials < this.maxConcurrentDials) {
      const wait = this.lastDispatchAt + this.startStaggerMs - Date.now();
      if (wait > 0) {
        this.schedulePump(wait);
        return;
      }
      const waiter = this.queue.shift()!;
      if (!waiter.alive()) {
        continue;
      }
      this.lastDispatchAt = Date.now();
      this.activeDials += 1;
      let released = false;
      const slotTimer = setTimeout(() => releaseSlot(), this.dialSlotMaxMs);
      const releaseSlot = (): void => {
        if (released) {
          return;
        }
        released = true;
        clearTimeout(slotTimer);
        this.activeDials -= 1;
        this.schedulePump(0);
      };
      waiter.grant(releaseSlot);
    }
  }

  private settingsFor(duoId: string, userId: string, token: string): WorkspaceSettings {
    const { config } = this.options;
    const jitter = jitterFactor(duoId);
    return workspaceSettingsFrom({
      ...config,
      workspace: {
        ...config.workspace,
        homeserverUrl: this.options.homeserverUrl,
        accessToken: token,
        userId,
        reconnect: {
          initialDelayMs: Math.round(config.workspace.reconnect.initialDelayMs * jitter),
          maxDelayMs: Math.round(config.workspace.reconnect.maxDelayMs * jitter),
        },
      },
    })!;
  }

  private async startService(entry: Entry, fingerprint: string | undefined, releaseSlot: () => void): Promise<void> {
    const { registry } = this.options;
    const accounts = registry.matrixAccounts(entry.duoId);
    // The registry moved on while this duo waited (token re-minted, accounts gone) or the daemon is closing: start nothing, `settle` has queued what is now right.
    if (this.stopped || entry.running || !accounts || fingerprint === undefined || fingerprintOf(accounts) !== fingerprint) {
      releaseSlot();
      return;
    }
    const token = registry.duoMatrixToken(entry.duoId);
    if (token === undefined) {
      releaseSlot();
      return;
    }
    const log = (line: string): void => this.say(entry.duoId, scrubToken(line, token));

    // The slot this duo holds now: the first dial's, then one per reconnect. It ends when the attempt does.
    let held: { release: () => void; attempts: number } | undefined = { release: releaseSlot, attempts: 0 };
    const releaseHeld = (): void => {
      const current = held;
      held = undefined;
      current?.release();
    };
    const buildTransport = this.options.transportFactory ?? matrixTransportFactory(this.options.sdkLogLevel ?? "silent", log);
    let dials = 0;
    const transportFactory: WorkspaceTransportFactory = async (settings) => {
      dials += 1;
      if (dials > 1) {
        // A reconnect rebuilds the client and syncs from scratch: it goes through the same gate as a first dial.
        releaseHeld();
        const release = await this.acquireSlot(entry);
        if (entry.running?.service !== service) {
          release();
          throw new Error("the duo's workspace connection was stopped");
        }
        held = { release, attempts: service.state().attempts };
      }
      return buildTransport(settings);
    };
    const service = createDuoWorkspaceService(entry.duo, {
      settings: this.settingsFor(entry.duoId, accounts.duoUserId, token),
      transportFactory,
      log,
      revokedRemedy: this.options.remint
        ? `the daemon will mint this duo a new token, or run \`duo hosted provision --remint ${entry.duoId}\` to do it now`
        : `this duo needs a new token (\`duo hosted provision --remint ${entry.duoId}\`)`,
    });
    entry.running = { fingerprint, service, releaseSlot: releaseHeld };
    entry.failures = 0;
    let lastPhase: WorkspacePhase = "stopped";
    service.onState((state) => {
      // The transitions an operator wants, once each: the duo came up, or it dropped. Failures are logged by the service itself.
      if (state.phase === "connected" && lastPhase !== "connected") {
        log("connected to the workspace");
      } else if (state.phase === "connecting" && lastPhase === "connected") {
        log("workspace connection lost; reconnecting");
      }
      lastPhase = state.phase;
      if (state.phase === "connected") {
        // A token that works ends the count of re-mints against this duo.
        entry.remints = 0;
        entry.remintGaveUp = false;
      }
      // The attempt is over once the duo is connected, has failed (the service's backoff owns it from here), or ended.
      if (state.phase === "connected" || state.phase === "stopped" || state.phase === "revoked" || (state.phase === "connecting" && state.attempts > (held?.attempts ?? 0))) {
        releaseHeld();
      }
      if (state.phase === "revoked") {
        log("Synapse refused this duo's token; not retrying until its token is re-minted");
        if (entry.running?.service === service) {
          this.scheduleRemint(entry);
        }
      }
    });
    service.start();
  }

  /** An error as a log fragment: its class and message, with the duo's token and anything token-shaped taken out, and no longer than a line should be. */
  private describe(duoId: string, error: unknown): string {
    return this.scrubText(duoId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  private scrubText(duoId: string, text: string, token?: string): string {
    let known = token;
    if (known === undefined) {
      try {
        known = this.options.registry.duoMatrixToken(duoId);
      } catch {
        // A token that will not decrypt cannot be in the text either.
      }
    }
    const scrubbed = scrubToken(text, known);
    return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}...` : scrubbed;
  }

  private say(duoId: string, line: string): void {
    this.log(`hosted: duo ${duoId}: ${line}`);
  }
}
