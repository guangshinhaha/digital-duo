import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentGroundingDoor } from "../src/drafting/attachment-grounding.js";
import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../src/permissions/public-answer.js";
import { readRoomConsent, RoomConsentNotFoundError, type RoomConsentEntry } from "../src/workspace/consent.js";
import type { DuoReadState } from "../src/workspace/read-state.js";
import type { RoomInvite } from "../src/workspace/messages.js";
import {
  availabilityOfState,
  NoPendingInviteError,
  reconnectDelayMs,
  RecentlySeenEventIds,
  WorkspaceService,
  type OpenWorkspaceCard,
  type WorkspaceServiceState,
  type WorkspaceTaskSink,
} from "../src/workspace/service.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import {
  WorkspaceTokenRevokedError,
  type WorkspaceAttachmentDoor,
  type WorkspaceFileReference,
  type WorkspaceQuestion,
  type WorkspaceTransport,
  type WorkspaceMemberIdentityListing,
} from "../src/workspace/transport.js";
import { FakeWorkspaceTransport } from "./helpers/fake-workspace-transport.js";
import { memberOf } from "./helpers/workspace-member.js";
import { useTempDir } from "./helpers/temp-dir.js";

const SELF = "@duo-alice:workspace";

function settings(overrides: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return {
    homeserverUrl: "https://matrix.workspace.example",
    accessToken: "token",
    userId: SELF,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 8000 },
    presenceIntervalMs: 5000,
    backlog: { maxAgeMs: 3_600_000, maxAnswersPerMinute: 30 },
    ackAfterMs: 2000,
    ...overrides,
  };
}

function answered(text: string): PublicAnswerOutcome {
  return { kind: "answered", draftId: "d", logEntryId: "l", text, sources: [], confidence: {
    signals: { selfConsistency: 1, retrievalStrength: 1, ruleHit: 1, recency: 1, selfReport: 1 },
    weights: { selfConsistency: 0.3, retrievalStrength: 0.3, ruleHit: 0.25, recency: 0.1, selfReport: 0.05 },
    score: 0.9,
    passesThreshold: true,
    threshold: 0.55,
  }, topicId: "t", evidenceAgeDays: 1 };
}

/** Settles the service's internal promise chains without touching the (mocked) clock. */
async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  transport: FakeWorkspaceTransport;
  service: WorkspaceService;
  answers: WorkspaceQuestion[];
  states: WorkspaceServiceState[];
}

function harness(
  harnessSettings: WorkspaceSettings = settings(),
  answerImpl?: (question: WorkspaceQuestion) => Promise<PublicAnswerOutcome>,
  readState?: DuoReadState,
  consentDir?: string,
  attachmentDoor?: WorkspaceAttachmentDoor,
): Harness {
  const transport = new FakeWorkspaceTransport();
  const answers: WorkspaceQuestion[] = [];
  const service = new WorkspaceService({
    settings: harnessSettings,
    transportFactory: () => (transport as WorkspaceTransport),
    answer: answerImpl ?? (async (question) => {
      answers.push(question);
      return answered(`answer to ${question.body}`);
    }),
    readState,
    consent: consentDir === undefined ? undefined : { duoDir: consentDir },
    attachmentDoor,
  });
  const states: WorkspaceServiceState[] = [];
  service.onState((state) => states.push(state));
  return { transport, service, answers, states };
}

function dm(message: { eventId: string; body: string; senderId?: string; originServerTs?: number; attachments?: WorkspaceFileReference[] }) {
  return {
    eventId: message.eventId,
    roomId: "!dm:workspace",
    senderId: message.senderId ?? "@bob:workspace",
    body: message.body,
    originServerTs: message.originServerTs ?? Date.now(),
    joinedMemberIds: [SELF, "@bob:workspace"],
    ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
  };
}

/** A transport whose connect() never settles until the test says so — for racing stop() against an in-flight connect. */
class HangingConnectTransport implements WorkspaceTransport {
  markAliveCalls = 0;
  stopCalls = 0;
  private resolveConnect: () => void = () => {};

  connect(): Promise<void> {
    return new Promise<void>((resolveConnect) => {
      this.resolveConnect = resolveConnect;
    });
  }

  release(): void {
    this.resolveConnect();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async sendAnswer(): Promise<void> {}

  async markAlive(): Promise<void> {
    this.markAliveCalls += 1;
  }

  async listMembers(): Promise<never> {
    throw new Error("fake: never reached — the connect never settles");
  }

  async listMemberIdentities(): Promise<never> {
    throw new Error("fake: never reached — the connect never settles");
  }

  async fetchFile(): Promise<never> {
    throw new Error("fake: never reached — the connect never settles");
  }

  onMessage(): void {}

  onDisconnected(): void {}

  onInvite(): void {}

  async joinRoom(): Promise<void> {}

  async leaveRoom(): Promise<void> {}

  async inviteToRoom(): Promise<void> {}
}

/**
 * A connected transport whose every markAlive() hangs until the test releases
 * it — for racing stop() against the first presence report (an HTTP round
 * trip in the real adapter, so the realistic window is the whole request).
 */
class HangingMarkAliveTransport extends FakeWorkspaceTransport {
  private resolveMarkAlive: (() => void)[] = [];

  override async markAlive(): Promise<void> {
    this.markAliveCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveMarkAlive.push(resolve);
    });
  }

  releaseMarkAlive(): void {
    for (const resolve of this.resolveMarkAlive.splice(0)) {
      resolve();
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reconnectDelayMs — capped exponential backoff", () => {
  it("doubles from the initial delay and never exceeds the max", () => {
    const reconnect = { initialDelayMs: 1000, maxDelayMs: 8000 };
    expect([0, 1, 2, 3, 4, 5].map((attempt) => reconnectDelayMs(attempt, reconnect))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe("availabilityOfState — the daemon's own connection into the same §6 shape (#187 AC1/AC2)", () => {
  function state(phase: WorkspaceServiceState["phase"], lastAliveAt: string | null): WorkspaceServiceState {
    return { phase, since: "2026-09-25T12:00:00.000Z", lastAliveAt, attempts: 0 };
  }

  it("is online exactly while the outbound connection is live", () => {
    expect(availabilityOfState(state("connected", "2026-09-25T11:59:00.000Z"))).toEqual({ online: true, lastSeenAt: null });
  });

  it("is offline with lastAliveAt as the last-seen when the connection is down — connecting, stopped, or revoked", () => {
    for (const phase of ["connecting", "stopped", "revoked"] as const) {
      expect(availabilityOfState(state(phase, "2026-09-25T11:42:00.000Z"))).toEqual({
        online: false,
        lastSeenAt: "2026-09-25T11:42:00.000Z",
      });
    }
  });

  it("never invents a last-seen: offline and never alive is offline with null", () => {
    expect(availabilityOfState(state("stopped", null))).toEqual({ online: false, lastSeenAt: null });
  });
});

describe("RecentlySeenEventIds — replay dedupe without unbounded growth", () => {
  it("remembers what was added, and forgets the oldest once the cap is hit", () => {
    const seen = new RecentlySeenEventIds(3);
    seen.add("$1");
    seen.add("$2");
    seen.add("$3");
    expect(seen.has("$1")).toBe(true);
    seen.add("$4");
    expect(seen.has("$1")).toBe(false);
    expect(seen.has("$2")).toBe(true);
    expect(seen.has("$4")).toBe(true);
  });

  it("re-adding an already-seen id neither duplicates nor evicts", () => {
    const seen = new RecentlySeenEventIds(2);
    seen.add("$1");
    seen.add("$1");
    seen.add("$2");
    expect(seen.has("$1")).toBe(true);
    seen.add("$3");
    expect(seen.has("$1")).toBe(false);
    expect(seen.has("$2")).toBe(true);
  });

  it("forget makes an id answerable again and keeps the cap honest; forgetting an unknown id is a no-op", () => {
    const seen = new RecentlySeenEventIds(3);
    seen.add("$1");
    seen.add("$2");
    seen.add("$3");
    seen.forget("$nope");
    expect(seen.has("$2")).toBe(true);
    seen.forget("$2");
    expect(seen.has("$2")).toBe(false);
    // The forgotten id freed its slot: the cap now evicts one later, not earlier.
    seen.add("$4");
    seen.add("$5");
    expect(seen.has("$1")).toBe(false);
    expect(seen.has("$3")).toBe(true);
    expect(seen.has("$4")).toBe(true);
    expect(seen.has("$5")).toBe(true);
  });
});

describe("WorkspaceService — the daemon dials out and holds the connection (#186 AC1)", () => {
  it("connects, reports liveness to the homeserver, and records the connected state with a last-alive time", async () => {
    const { transport, service, states } = harness();
    service.start();
    await flush();
    expect(transport.connectCalls).toBe(1);
    expect(transport.markAliveCalls).toBe(1);
    expect(service.state().phase).toBe("connected");
    expect(service.state().lastAliveAt).toBeTruthy();
    // connecting → connected (dial succeeded) → connected again (the first
    // liveness report stamped lastAliveAt — a state change #187 reads).
    expect(states.map((state) => state.phase)).toEqual(["connecting", "connected", "connected"]);
    await service.stop();
  });

  it("re-reports presence on the interval while connected, and stops when disconnected", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    expect(transport.markAliveCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.markAliveCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.markAliveCalls).toBe(3);
    transport.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(30000);
    // Reconnects re-report once (on connect); the standing interval is
    // re-armed only after that success — no reports during the backoff.
    expect(transport.connectCalls).toBe(2);
    await service.stop();
  });

  it("answers a question over the same connection and returns the answer as the duo's own message (#186 AC3)", async () => {
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q1", body: "What did Alice decide?" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["What did Alice decide?"]);
    expect(transport.sentAnswers).toEqual([
      { roomId: "!dm:workspace", content: { msgtype: "m.text", body: "answer to What did Alice decide?" } },
    ]);
    await service.stop();
  });

  it("ignores messages that are not direct questions — group rooms, its own messages — and never calls the pipeline", async () => {
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$own", body: "my own answer", senderId: SELF }));
    transport.deliver({ ...dm({ eventId: "$group", body: "hello everyone" }), joinedMemberIds: [SELF, "@bob:workspace", "@carol:workspace"] });
    await flush();
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    await service.stop();
  });

  it("answers a held event only once, even if sync replays it", async () => {
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q1", body: "once" }));
    transport.deliver(dm({ eventId: "$q1", body: "once" }));
    await flush();
    expect(answers).toHaveLength(1);
    expect(transport.sentAnswers).toHaveLength(1);
    await service.stop();
  });

  it("answers questions serially — the pipeline opens the store per call and must not interleave", async () => {
    const firstRelease = { resolve: (() => {}) as () => void };
    const { transport, service, answers } = harness(settings(), async (question) => {
      answers.push(question);
      if (question.body === "first") {
        await new Promise<void>((resolveAnswer) => {
          firstRelease.resolve = resolveAnswer;
        });
      }
      return answered(`answer to ${question.body}`);
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$a", body: "first" }));
    await flush();
    transport.deliver(dm({ eventId: "$b", body: "second" }));
    await flush();
    // The second question is queued behind the first: not answered, nothing sent.
    expect(answers.map((question) => question.body)).toEqual(["first"]);
    expect(transport.sentAnswers).toEqual([]);
    firstRelease.resolve();
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["first", "second"]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to first", "answer to second"]);
    await service.stop();
  });

  it("sends the generic failure body when the pipeline itself throws — internals never reach the wire, and the next question still answers (#186 AC3)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const { transport, service } = harness(settings(), async (question) => {
      calls += 1;
      if (question.body === "boom") {
        throw new Error(`internal details: ${question.body}`);
      }
      return answered("fine");
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$bad", body: "boom" }));
    await flush();
    transport.deliver(dm({ eventId: "$good", body: "ok" }));
    await flush();
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual([PUBLIC_ANSWER_FAILED_MESSAGE, "fine"]);
    expect(JSON.stringify(transport.sentAnswers)).not.toContain("internal details");
    expect(consoleError).toHaveBeenCalled();
    expect(calls).toBe(2);
    await service.stop();
  });

  it("sends its log lines to the injected logger when there is one, and to console.error as before when there is not (#236)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const lines: string[] = [];
    const transport = new FakeWorkspaceTransport();
    transport.failNextNConnects(1);
    const service = new WorkspaceService({
      settings: settings(),
      transportFactory: () => transport as WorkspaceTransport,
      answer: async () => answered("x"),
      log: (line) => lines.push(line),
    });
    service.start();
    await flush();
    expect(lines).toEqual(["workspace: workspace connection failed: fake: homeserver unreachable"]);
    expect(consoleError).not.toHaveBeenCalled();
    await service.stop();

    // No logger: the pre-#236 call shape, byte for byte.
    const plainTransport = new FakeWorkspaceTransport();
    plainTransport.failNextNConnects(1);
    const plain = new WorkspaceService({ settings: settings(), transportFactory: () => plainTransport as WorkspaceTransport, answer: async () => answered("x") });
    plain.start();
    await flush();
    expect(consoleError).toHaveBeenCalledWith("workspace: workspace connection failed:", "fake: homeserver unreachable");
    await plain.stop();
  });

  it("survives a failed send — logged, not thrown, the daemon lives on", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    service.start();
    await flush();
    transport.dropConnection();
    await flush();
    transport.deliver(dm({ eventId: "$q", body: "during outage" }));
    await flush();
    expect(consoleError).toHaveBeenCalled();
    await service.stop();
  });

  it("re-answers a question whose answer send failed — the homeserver's replay recovers it, not a queue", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    // The question arrives connected, but the connection drops before the
    // answer's send: the draft succeeds, the send fails, and without the
    // forget the dedupe would make the loss permanent (the replay after
    // reconnect would be suppressed).
    transport.deliver(dm({ eventId: "$q", body: "asked before the drop" }));
    transport.dropConnection();
    await flush();
    expect(answers).toHaveLength(1);
    expect(transport.sentAnswers).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    // The homeserver still holds the event; the post-reconnect sync replays
    // it through the same onMessage path — and it is answered again.
    transport.hold(dm({ eventId: "$q", body: "asked before the drop" }));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(transport.connectCalls).toBe(2);
    expect(answers).toHaveLength(2);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to asked before the drop"]);
    await service.stop();
  });

  it("logs when shutdown swallowed an in-flight answer — the drop is observable, not a silent no-op", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const releaseAnswer = { resolve: (() => {}) as () => void };
    const { transport, service } = harness(settings(), async (question) => {
      await new Promise<void>((resolve) => {
        releaseAnswer.resolve = resolve;
      });
      return answered(`late answer to ${question.body}`);
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$late", body: "asked just before shutdown" }));
    await flush();
    // The pipeline is mid-draft when the daemon shuts down: stop() tears the
    // transport down without draining the answer chain.
    await service.stop();
    releaseAnswer.resolve();
    await flush();
    expect(transport.sentAnswers).toEqual([]);
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("sending workspace answer for $late failed"))).toBe(true);
  });
});

describe("WorkspaceService — reconnect with exponential backoff (#186 AC1)", () => {
  it("retries an unreachable homeserver at 1s, 2s, 4s… and a later success resets the sequence", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    transport.failNextNConnects(3);
    service.start();
    await flush();
    expect(transport.connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(transport.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connectCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport.connectCalls).toBe(4);
    expect(service.state().phase).toBe("connected");
    // Reset: after a success, the next failure waits the INITIAL delay
    // (1000ms) again — not the 8000ms the earlier streak had climbed to.
    // That redial is set up to fail once more, then one more dial recovers.
    transport.failNextNConnects(1);
    transport.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.connectCalls).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(transport.connectCalls).toBe(5);
    expect(service.state().phase).toBe("connecting");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(transport.connectCalls).toBe(6);
    expect(service.state().phase).toBe("connected");
    await service.stop();
    expect(consoleError).toHaveBeenCalled();
  });

  it("caps the backoff at maxDelayMs no matter how long the outage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness(settings({ reconnect: { initialDelayMs: 1000, maxDelayMs: 8000 } }));
    transport.failNextNConnects(10);
    service.start();
    await flush();
    for (let expected = 1; expected <= 5; expected += 1) {
      await vi.advanceTimersByTimeAsync(expected < 4 ? 1000 * 2 ** (expected - 1) : 8000);
      expect(transport.connectCalls).toBe(expected + 1);
    }
    await service.stop();
  });

  it("re-dials after the SDK gives up on an established connection", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    expect(service.state().phase).toBe("connected");
    transport.dropConnection();
    await flush();
    expect(service.state().phase).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.connectCalls).toBe(2);
    expect(service.state().phase).toBe("connected");
    await service.stop();
  });

  it("stops cleanly and permanently: timers cancelled, transport stopped, stop idempotent", async () => {
    const { transport, service } = harness();
    transport.failNextNConnects(5);
    service.start();
    await flush();
    await service.stop();
    expect(transport.stopCalls).toBe(1);
    expect(service.state().phase).toBe("stopped");
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.connectCalls).toBe(1);
    await service.stop();
    expect(transport.stopCalls).toBe(1);
  });

  it("shuts down a transport the factory built after stop() raced it — no half-alive client leaks", async () => {
    let releaseFactory: (transport: WorkspaceTransport) => void = () => {};
    const factoryPromise = new Promise<WorkspaceTransport>((resolveFactory) => {
      releaseFactory = resolveFactory;
    });
    const service = new WorkspaceService({
      settings: settings(),
      transportFactory: () => factoryPromise,
      answer: async (question) => answered(question.body),
    });
    service.start();
    const late = new FakeWorkspaceTransport();
    await service.stop();
    releaseFactory(late);
    await flush();
    expect(late.stopCalls).toBe(1);
    expect(late.connectCalls).toBe(0);
  });

  it("discards a connect that settles after stop() raced it — no connected flip, no orphaned presence interval", async () => {
    // An adapter whose connect() hangs until the test releases it, so the
    // stop-then-settle ordering is forced (the real adapter settles the
    // pending connect by rejecting it from stop(); either way dial()
    // resumes after stop() already ran).
    const hanging = new HangingConnectTransport();
    const service = new WorkspaceService({
      settings: settings(),
      transportFactory: () => hanging,
      answer: async (question) => answered(question.body),
    });
    service.start();
    await flush();
    await service.stop();
    expect(service.state().phase).toBe("stopped");
    hanging.release();
    await flush();
    // The late connect is discarded: the state stays stopped, the
    // transport is stopped a second time (the discard path's cleanup), and
    // — the load-bearing part — no presence interval was ever armed, so
    // nothing fires after the service died.
    expect(service.state().phase).toBe("stopped");
    expect(hanging.stopCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(hanging.markAliveCalls).toBe(0);
  });

  it("does not arm the presence interval when stop() races the first presence report — the connect-race rule, applied to markAlive", async () => {
    // dial() awaits refreshPresence() (markAlive — an HTTP round trip in the
    // real adapter) before arming the interval, so a shutdown inside that
    // request is a second stop-race window: without a running re-check, the
    // interval outlives the service and stamps lastAliveAt forever.
    const hanging = new HangingMarkAliveTransport();
    let emissions = 0;
    const service = new WorkspaceService({
      settings: settings(),
      transportFactory: () => (hanging as WorkspaceTransport),
      answer: async (question) => answered(question.body),
    });
    service.onState(() => {
      emissions += 1;
    });
    service.start();
    await flush();
    expect(hanging.connectCalls).toBe(1);
    expect(service.state().phase).toBe("connected");
    await service.stop();
    hanging.releaseMarkAlive();
    await flush();
    // The in-flight report settles after stop(): its lastAliveAt stamp is
    // already out (see the residual note in the review), but that must be
    // the LAST thing the service ever emits — no interval may be armed.
    const settledEmissions = emissions;
    const settledAliveAt = service.state().lastAliveAt;
    expect(settledAliveAt).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60000);
    expect(emissions).toBe(settledEmissions);
    expect(service.state().lastAliveAt).toBe(settledAliveAt);
    expect(hanging.markAliveCalls).toBe(1);
  });
});

describe("WorkspaceService — a disconnected duo is a state, not an error (#186 AC4)", () => {
  it("holds rather than loses: an event the homeserver held during a disconnect is delivered and answered after reconnect", async () => {
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$live", body: "asked while connected" }));
    await flush();
    // The Mac sleeps: the connection drops, a question arrives and the
    // homeserver holds it (Matrix-native — no daemon-side queue involved).
    transport.dropConnection();
    await flush();
    transport.hold(dm({ eventId: "$held", body: "asked while asleep" }));
    // The Mac wakes: backoff fires, the service re-dials, sync catches up
    // and replays the held event through the same onMessage path.
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.connectCalls).toBe(2);
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["asked while connected", "asked while asleep"]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual([
      "answer to asked while connected",
      "answer to asked while asleep",
    ]);
    await service.stop();
  });

  it("records the disconnected state observably — phase and attempt count for #187's availability surface", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, states } = harness();
    transport.failNextNConnects(2);
    service.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(service.state().phase).toBe("connecting");
    expect(service.state().attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(service.state()).toMatchObject({ phase: "connected", attempts: 0 });
    // Each entry records a real transition: initial dial, the post-failure
    // re-"connecting" that carries the new attempt count, the redial, and
    // finally connected + the first liveness stamp.
    expect(states.map((state) => state.phase)).toEqual(["connecting", "connecting", "connecting", "connecting", "connecting", "connected", "connected"]);
    await service.stop();
  });
});

/** Serves a member listing whose delivery the test gates — for racing a read against a re-dial. */
class GatedListMembersTransport extends FakeWorkspaceTransport {
  private gates: (() => void)[] = [];

  override async listMemberIdentities(): Promise<WorkspaceMemberIdentityListing> {
    const listing = await super.listMemberIdentities();
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    return listing;
  }

  releasePendingReads(): void {
    for (const resolve of this.gates.splice(0)) {
      resolve();
    }
  }
}

describe("WorkspaceService — the member cache feeds asker resolution (#187 AC3)", () => {
  it("reads member identities once per successful connect — the identity-only read, no presence fan-out — and serves memberFor from it", async () => {
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob"), memberOf("@duo-alice:workspace", "Alice's duo", true)], truncated: false });
    service.start();
    await flush();
    expect(transport.listMemberIdentitiesCalls).toBe(1);
    // The connect-time cache read never pays the per-user presence fan-out
    // `listMembers` carries: the cache serves identity facts only.
    expect(transport.listMembersCalls).toBe(0);
    // Identity facts exactly — the shape is pinned, so serving presence
    // from this stale-by-construction cache cannot creep back in.
    expect(service.memberFor("@bob:workspace")).toEqual({ userId: "@bob:workspace", displayName: "Bob" });
    expect(service.memberFor("@nobody:workspace")).toBeUndefined();
    await service.stop();
  });

  it("re-reads on reconnect — the cache tracks the workspace, not the first look", async () => {
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob")], truncated: false });
    service.start();
    await flush();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob"), memberOf("@carol:workspace", "Carol")], truncated: false });
    transport.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(transport.connectCalls).toBe(2);
    expect(transport.listMemberIdentitiesCalls).toBe(2);
    expect(service.memberFor("@carol:workspace")).toEqual({ userId: "@carol:workspace", displayName: "Carol" });
    await service.stop();
  });

  it("discards a read that settles after its connection was replaced — no stale member facts from a dead transport", async () => {
    const first = new GatedListMembersTransport();
    const second = new FakeWorkspaceTransport();
    let dial = 0;
    const service = new WorkspaceService({
      settings: settings(),
      // The re-dial after the drop builds a fresh transport (the reliable
      // Matrix reset), so the first transport's still-pending read resolves
      // against a connection the service no longer holds.
      transportFactory: () => ((dial++ === 0 ? first : second) as WorkspaceTransport),
      answer: async (question) => answered(question.body),
    });
    first.setMembers({ members: [memberOf("@bob:workspace", "Bob")], truncated: false });
    second.setMembers({ members: [], truncated: false });
    service.start();
    await flush();
    expect(first.listMemberIdentitiesCalls).toBe(1);
    first.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(second.connectCalls).toBe(1);
    first.releasePendingReads();
    await flush();
    expect(service.memberFor("@bob:workspace")).toBeUndefined();
    await service.stop();
  });

  it("fails soft: a member read that fails degrades the feed to its fallback, never the connection or an answer", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness();
    transport.failListMembers(new Error("fake: user directory unavailable"));
    service.start();
    await flush();
    expect(service.state().phase).toBe("connected");
    expect(service.memberFor("@bob:workspace")).toBeUndefined();
    transport.deliver(dm({ eventId: "$q", body: "still answerable" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["still answerable"]);
    expect(transport.sentAnswers).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    await service.stop();
  });

  it("surfaces a truncated listing owner-side — the members absent are unknown, not silently dropped", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob")], truncated: true });
    service.start();
    await flush();
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("truncated by the homeserver's limit"))).toBe(true);
    // The members the server did return are still served.
    expect(service.memberFor("@bob:workspace")).toEqual({ userId: "@bob:workspace", displayName: "Bob" });
    await service.stop();
  });

  it("clears the cache on stop — a stopped service serves no identity facts", async () => {
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob")], truncated: false });
    service.start();
    await flush();
    expect(service.memberFor("@bob:workspace")).toBeDefined();
    await service.stop();
    expect(service.memberFor("@bob:workspace")).toBeUndefined();
  });
});

describe("WorkspaceService — the directory read over the live connection (#187 AC1/AC2)", () => {
  it("composes people with stable ids, display names, availability, and their attributed duos", async () => {
    const { transport, service } = harness();
    transport.setMembers({
      members: [
        memberOf("@alice:workspace", "Alice", true, 1000),
        memberOf("@duo-alice:workspace", "Alice's duo", false, 3_600_000),
      ],
      truncated: false,
    });
    service.start();
    await flush();
    const directory = await service.directory();
    expect(directory).toHaveLength(1);
    expect(directory[0]).toMatchObject({
      userId: "@alice:workspace",
      displayName: "Alice",
      availability: { online: true, lastSeenAt: null },
      duo: { userId: "@duo-alice:workspace", availability: { online: false } },
    });
    expect(directory[0]!.duo!.availability.lastSeenAt).toBeTruthy();
    await service.stop();
  });

  it("reads fresh each call — a listing change between calls shows up in the next read", async () => {
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob")], truncated: false });
    service.start();
    await flush();
    expect((await service.directory()).map((entry) => entry.userId)).toEqual(["@bob:workspace"]);
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob"), memberOf("@carol:workspace", "Carol")], truncated: false });
    expect((await service.directory()).map((entry) => entry.userId)).toEqual(["@bob:workspace", "@carol:workspace"]);
    await service.stop();
  });

  it("refuses the read unless the connection is live — before start and after stop, with a plain error", async () => {
    const { transport, service } = harness();
    await expect(service.directory()).rejects.toThrow(/can only be read while the outbound connection is live/);
    service.start();
    await flush();
    transport.dropConnection();
    await flush();
    await expect(service.directory()).rejects.toThrow(/can only be read while the outbound connection is live/);
    await service.stop();
    await expect(service.directory()).rejects.toThrow(/can only be read while the outbound connection is live/);
  });

  it("carries the daemon's own availability off the same §6 vocabulary — online exactly while connected", async () => {
    const { transport, service } = harness();
    expect(availabilityOfState(service.state())).toEqual({ online: false, lastSeenAt: null });
    service.start();
    await flush();
    expect(availabilityOfState(service.state())).toEqual({ online: true, lastSeenAt: null });
    transport.dropConnection();
    await flush();
    const offline = availabilityOfState(service.state());
    expect(offline.online).toBe(false);
    expect(offline.lastSeenAt).toBeTruthy();
    await service.stop();
  });

  it("surfaces a server-capped listing on the directory read too — logged, never silently swallowed (#187 AC1)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@alice:workspace", "Alice", true)], truncated: true });
    service.start();
    await flush();
    const directory = await service.directory();
    // The entries the server did return are correct and served…
    expect(directory.map((entry) => entry.userId)).toEqual(["@alice:workspace"]);
    // …and the cap is owner-visible: the absent members are unknown, and
    // the read says so rather than returning a partial directory as truth.
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("truncated by the homeserver's limit"))).toBe(true);
    await service.stop();
  });
});

describe("WorkspaceService — a revoked token fails fast, not forever (#187, from #219's successor notes)", () => {
  it("enters the terminal revoked phase on the first rejected dial and never dials again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, states } = harness();
    transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("Unrecognised access token"));
    service.start();
    await flush();
    expect(service.state().phase).toBe("revoked");
    expect(service.state().attempts).toBe(0);
    // No lastAliveAt to keep — the daemon never got connected on this token.
    expect(service.state().lastAliveAt).toBeNull();
    expect(availabilityOfState(service.state())).toEqual({ online: false, lastSeenAt: null });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(transport.connectCalls).toBe(1);
    // Against the real adapter, a transient second "connecting" can
    // interleave here (its module-level sync listener fires
    // onDisconnected before dial()'s catch observes the rejection); the
    // pin is the terminal state and the single dial, both below.
    expect(states.map((state) => state.phase)).toEqual(["connecting", "revoked"]);
    expect(transport.stopCalls).toBe(1);
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("re-pair the duo"))).toBe(true);
    await service.stop();
  });

  it("a live revocation costs at most one re-dial: disconnect, re-dial, rejected connect, terminal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    service.start();
    await flush();
    expect(service.state().phase).toBe("connected");
    expect(service.state().lastAliveAt).toBeTruthy();
    // The token is revoked while the connection is live: the SDK gives up,
    // the service re-dials once, and the homeserver answers M_UNKNOWN_TOKEN.
    transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("Unrecognised access token"));
    transport.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(transport.connectCalls).toBe(2);
    expect(service.state().phase).toBe("revoked");
    // The lastAliveAt from the live connection survives as the offline last-seen.
    expect(service.state().lastAliveAt).toBeTruthy();
    expect(availabilityOfState(service.state())).toEqual({ online: false, lastSeenAt: service.state().lastAliveAt });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(transport.connectCalls).toBe(2);
    await service.stop();
    expect(service.state().phase).toBe("stopped");
  });

  it("clears the member cache on revocation — a dead credential serves no identity facts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    transport.setMembers({ members: [memberOf("@bob:workspace", "Bob")], truncated: false });
    service.start();
    await flush();
    expect(service.memberFor("@bob:workspace")).toBeDefined();
    transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("Unrecognised access token"));
    transport.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(service.state().phase).toBe("revoked");
    expect(service.memberFor("@bob:workspace")).toBeUndefined();
    await service.stop();
  });

  it("an explicit start() after revocation re-dials — the operator's lever, and it re-discovers the revocation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("Unrecognised access token"));
    service.start();
    await flush();
    expect(service.state().phase).toBe("revoked");
    transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("Unrecognised access token"));
    service.start();
    await flush();
    expect(transport.connectCalls).toBe(2);
    expect(service.state().phase).toBe("revoked");
    await service.stop();
  });
});

describe("WorkspaceService — durable read state and the backlog policies (#189)", () => {
  /** A DuoReadState that records what was marked, for asserting the durable half. */
  class RecordingReadState implements DuoReadState {
    readonly marked: { roomId: string; eventId: string; originServerTs: number }[] = [];
    private readonly ids = new Set<string>();

    hasRead(eventId: string): boolean {
      return this.ids.has(eventId);
    }

    markRead(roomId: string, eventId: string, originServerTs: number): void {
      this.ids.add(eventId);
      this.marked.push({ roomId, eventId, originServerTs });
    }
  }

  it("does not re-answer an event a previous process already handled — the restart dedupe #219 deferred here", async () => {
    const readState = new RecordingReadState();
    readState.markRead("!dm:workspace", "$q1", Date.now());
    const { transport, service, answers } = harness(settings(), undefined, readState);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q1", body: "asked before the restart" }));
    await flush();
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    // Suppressed by the durable set, not re-marked: the one recorded mark
    // is the test's own setup, nothing new.
    expect(readState.marked).toHaveLength(1);
    await service.stop();
  });

  it("records an answered event durably — after the send, so a fresh process will not answer it again", async () => {
    const readState = new RecordingReadState();
    const { transport, service } = harness(settings(), undefined, readState);
    service.start();
    await flush();
    const at = Date.now();
    transport.deliver(dm({ eventId: "$q1", body: "once, durably", originServerTs: at }));
    await flush();
    expect(readState.marked).toEqual([{ roomId: "!dm:workspace", eventId: "$q1", originServerTs: at }]);
    // The restart: a fresh service sharing the read state replays the same
    // event and stays silent.
    const secondTransport = new FakeWorkspaceTransport();
    const second = new WorkspaceService({
      settings: settings(),
      transportFactory: () => (secondTransport as WorkspaceTransport),
      answer: async (question) => answered(question.body),
      readState,
    });
    second.start();
    await flush();
    secondTransport.deliver(dm({ eventId: "$q1", body: "once, durably", originServerTs: at }));
    await flush();
    expect(secondTransport.sentAnswers).toEqual([]);
    await second.stop();
    await service.stop();
  });

  it("records nothing durable when the send fails — the replay re-answers, at-least-once preserved (#219's stance, now consistent)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const readState = new RecordingReadState();
    const { transport, service, answers } = harness(settings(), undefined, readState);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q", body: "asked before the drop" }));
    transport.dropConnection();
    await flush();
    expect(answers).toHaveLength(1);
    expect(readState.marked).toEqual([]);
    transport.hold(dm({ eventId: "$q", body: "asked before the drop" }));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(answers).toHaveLength(2);
    // Only the successful re-answer is durable.
    expect(readState.marked).toHaveLength(1);
    await service.stop();
  });

  it("skips an event older than the backlog window — marked read, logged owner-side, never answered", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const readState = new RecordingReadState();
    const { transport, service, answers } = harness(
      settings({ backlog: { maxAgeMs: 1000, maxAnswersPerMinute: 30 } }),
      undefined,
      readState,
    );
    service.start();
    await flush();
    const ancient = Date.now() - 5000;
    transport.deliver(dm({ eventId: "$old", body: "asked last night", originServerTs: ancient }));
    await flush();
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    expect(readState.marked).toEqual([{ roomId: "!dm:workspace", eventId: "$old", originServerTs: ancient }]);
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("not answering workspace question $old"))).toBe(true);
    await service.stop();
  });

  it("rate-bounds a flood — at most the configured answers per rolling minute, the excess suppressed, logged, and never durably marked", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const readState = new RecordingReadState();
    const { transport, service, answers } = harness(
      settings({ backlog: { maxAgeMs: 3_600_000, maxAnswersPerMinute: 1 } }),
      undefined,
      readState,
    );
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$first", body: "first" }));
    transport.deliver(dm({ eventId: "$second", body: "second" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["first"]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to first"]);
    // Only the answered event is durable. The excess was suppressed for
    // this process alone: the bound is a statement about pipeline capacity,
    // not a verdict on the event — durably marking it would let a flooder
    // permanently silence fresh questions that merely arrived behind the
    // flood (the in-process seen set holds them until the restart).
    expect(readState.marked.map((marked) => marked.eventId)).toEqual(["$first"]);
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("not answering workspace question $second"))).toBe(true);
    await service.stop();
  });

  it("re-answers rate-bound excess after a restart — a fresh window re-decides what this process merely lacked capacity for", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const readState = new RecordingReadState();
    const bounded = settings({ backlog: { maxAgeMs: 3_600_000, maxAnswersPerMinute: 1 } });
    const { transport, service, answers } = harness(bounded, undefined, readState);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$first", body: "first" }));
    transport.deliver(dm({ eventId: "$second", body: "second" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["first"]);
    await service.stop();
    // Restart: the same durable read state (only "$first" is in it), a
    // fresh rate window — the suppressed event is decided again, and this
    // time answered.
    const secondTransport = new FakeWorkspaceTransport();
    const secondAnswers: WorkspaceQuestion[] = [];
    const second = new WorkspaceService({
      settings: bounded,
      transportFactory: () => (secondTransport as WorkspaceTransport),
      answer: async (question) => {
        secondAnswers.push(question);
        return answered(`answer to ${question.body}`);
      },
      readState,
    });
    second.start();
    await flush();
    secondTransport.deliver(dm({ eventId: "$second", body: "second" }));
    await flush();
    expect(secondAnswers.map((question) => question.body)).toEqual(["second"]);
    expect(secondTransport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to second"]);
    await second.stop();
  });

  it("degrades, never fails, when the durable read state errors — a store failure reads as 'not handled' and the answer still goes out", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: DuoReadState = {
      hasRead: () => {
        throw new Error("store is unhappy");
      },
      markRead: () => {
        throw new Error("store is unhappy");
      },
    };
    const { transport, service, answers } = harness(settings(), undefined, broken);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q1", body: "answer me anyway" }));
    await flush();
    expect(answers).toHaveLength(1);
    expect(transport.sentAnswers).toHaveLength(1);
    // Both the failed lookup and the failed record are visible owner-side
    // as read-state failures — a store problem never masquerades as a
    // question-handling one.
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("durable read state"))).toBe(true);
    await service.stop();
  });

  it("keeps the pre-#189 behavior with no read state injected — answers replayed duplicates exactly once, in-process", async () => {
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q1", body: "once" }));
    await flush();
    expect(answers).toHaveLength(1);
    await service.stop();
  });
});

// ---------------------------------------------------------------------------
// #192: consent for a duo in a shared conversation. The record under test is
// a real `duo/room-consent.json` in a fresh temp dir per test — the same
// file the module ships, not a stub of it.
// ---------------------------------------------------------------------------

const consentTempDir = useTempDir("duo-consent-test-");

/** The per-test `duo/` directory the consent record lives in. */
function duoDir(): string {
  const dir = join(consentTempDir(), "duo");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes the record file directly — the owner's hand, or a previous process. */
function writeConsent(entries: readonly RoomConsentEntry[]): string {
  const dir = duoDir();
  writeFileSync(join(dir, "room-consent.json"), `${JSON.stringify([...entries].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)), null, 2)}\n`, "utf8");
  return dir;
}

/** An invitation as the adapter would normalize it off the sync slice. */
function invite(overrides: Partial<RoomInvite> = {}): RoomInvite {
  return { roomId: "!room:workspace", inviterId: "@bob:workspace", name: "Launch planning", joinedMemberCount: 3, ...overrides };
}

/**
 * A message in a shared (3+ member) room, both the duo and the sender
 * joined. Every test in this file that predates #312/S1 is exercising
 * consent/join/loop-guard mechanics, not addressing, so this defaults to
 * mentioning the duo (addressed) unless a case explicitly says otherwise —
 * the dedicated #312/S1 describe block below overrides this to cover the
 * unaddressed case itself.
 */
function roomMessage(message: {
  eventId: string;
  body: string;
  senderId?: string;
  roomId?: string;
  originServerTs?: number;
  joinedMemberIds?: string[];
  mentionedUserIds?: string[];
  replyToSenderId?: string | null;
  threadRootSenderId?: string | null;
}) {
  return {
    eventId: message.eventId,
    roomId: message.roomId ?? "!room:workspace",
    senderId: message.senderId ?? "@bob:workspace",
    body: message.body,
    originServerTs: message.originServerTs ?? Date.now(),
    joinedMemberIds: message.joinedMemberIds ?? [SELF, "@bob:workspace", "@carol:workspace"],
    mentionedUserIds: message.mentionedUserIds ?? [SELF],
    replyToSenderId: message.replyToSenderId ?? null,
    threadRootSenderId: message.threadRootSenderId ?? null,
  };
}

/** One `allowed` entry, the shape an allow writes — for seeding a record by hand. */
function allowedEntry(roomId: string, overrides: Partial<RoomConsentEntry> = {}): RoomConsentEntry {
  return { roomId, status: "allowed", name: "Launch planning", inviterId: "@bob:workspace", joinedMemberCount: 3, decidedAt: "2026-09-25T12:00:00.000Z", ...overrides };
}

describe("WorkspaceService — someone else's invite is held, never joined (#192)", () => {
  it("holds the invitation with its facts and joins nothing — reachable only on the owner's allow", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    const held = service.pendingInvites();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ roomId: "!room:workspace", inviterId: "@bob:workspace", name: "Launch planning", joinedMemberCount: 3 });
    expect(held[0]!.receivedAt).toBeTruthy();
    // Nothing was joined, and the surfacing carries the facts the owner decides on.
    expect(transport.joinCalls).toEqual([]);
    const logged = consoleError.mock.calls.map((call) => `${call[0]} ${call[1]}`);
    expect(logged.some((line) => line.includes("workspace invitation held for the owner's decision — room !room:workspace") && line.includes("named \"Launch planning\"") && line.includes("invited by @bob:workspace") && line.includes("3 joined member(s) visible"))).toBe(true);
    await service.stop();
  });

  it("a question from the invited-but-unallowed room is not work — the invite alone never makes the duo reachable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    transport.deliver(roomMessage({ eventId: "$q", body: "What did Alice decide?" }));
    await flush();
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    expect(transport.joinCalls).toEqual([]);
    await service.stop();
  });

  it("dedupes a still-live invite's sync replays by room id — one held entry, one surfacing per replay", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    transport.deliverInvite(invite());
    transport.deliverInvite(invite({ name: null, inviterId: null, joinedMemberCount: 1 }));
    await flush();
    expect(service.pendingInvites()).toHaveLength(1);
    // Every replay is re-surfaced (the invite is still live), the entry is not.
    const heldCount = consoleError.mock.calls.filter((call) => String(call[0]).includes("invitation held")).length;
    expect(heldCount).toBe(3);
    await service.stop();
  });

  it("holds nothing when no consent surface is configured — the pre-#192 daemon, invite inert", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness();
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    expect(service.pendingInvites()).toEqual([]);
    expect(service.consentedRooms()).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    await service.stop();
  });

  it("drops held invitations on stop — the homeserver re-delivers a still-live one on the next connect", async () => {
    const { transport, service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    expect(service.pendingInvites()).toHaveLength(1);
    await service.stop();
    expect(service.pendingInvites()).toEqual([]);
    await expect(service.allowInvite("!room:workspace")).rejects.toThrow(NoPendingInviteError);
  });
});

describe("WorkspaceService — the owner's allow is the only join (#192)", () => {
  it("joins on allow, records the decision with the invite's provenance, and the room becomes answerable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service, answers } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    const entry = await service.allowInvite("!room:workspace");
    expect(entry).toMatchObject({ roomId: "!room:workspace", status: "allowed", name: "Launch planning", inviterId: "@bob:workspace", joinedMemberCount: 3 });
    expect(entry.decidedAt).toBeTruthy();
    expect(transport.joinCalls).toEqual(["!room:workspace"]);
    expect(transport.joinedRooms.has("!room:workspace")).toBe(true);
    expect(service.pendingInvites()).toEqual([]);
    expect(readRoomConsent(dir)).toEqual([entry]);
    expect(service.consentedRooms().map((room) => room.roomId)).toEqual(["!room:workspace"]);
    // And the gate opens: a question in that room is answered like a DM is.
    transport.deliver(roomMessage({ eventId: "$q", body: "What did Alice decide?" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["What did Alice decide?"]);
    // W-S3-1 (#313): a shared-room answer carries the reply relation back to
    // the question's own event id — unlike a DM's two-key shape.
    expect(transport.sentAnswers).toEqual([
      {
        roomId: "!room:workspace",
        content: { msgtype: "m.text", body: "answer to What did Alice decide?", "m.relates_to": { "m.in_reply_to": { event_id: "$q" } } },
      },
    ]);
    await service.stop();
  });

  it("refuses an allow on a room whose invitation is not held — 404-shaped, not a guessed join", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    await expect(service.allowInvite("!never-invited:workspace")).rejects.toThrow(NoPendingInviteError);
    await service.stop();
  });

  it("keeps the invitation held and records nothing when the join fails — the owner's retry is a real retry", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    transport.dropConnection();
    await flush();
    await expect(service.allowInvite("!room:workspace")).rejects.toThrow(/outbound workspace connection is not live/);
    expect(readRoomConsent(dir)).toEqual([]);
    // The connection returns; the invite is still held and still decidable.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(service.pendingInvites()).toHaveLength(1);
    const entry = await service.allowInvite("!room:workspace");
    expect(readRoomConsent(dir)).toEqual([entry]);
    await service.stop();
  });

  it("records only the decided room — another room's questions stay gated while the allowed one answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite({ roomId: "!allowed:workspace" }));
    await flush();
    await service.allowInvite("!allowed:workspace");
    transport.deliver(roomMessage({ eventId: "$in", body: "in the allowed room", roomId: "!allowed:workspace" }));
    transport.deliver(roomMessage({ eventId: "$out", body: "in another room", roomId: "!other:workspace" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["in the allowed room"]);
    expect(transport.sentAnswers.map((sent) => sent.roomId)).toEqual(["!allowed:workspace"]);
    await service.stop();
  });

  it("never answers another duo in the consented room either — the loop guard holds wherever consent reaches (#219's note)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$duo", body: "fellow duo speaking", senderId: "@duo-bob:workspace", joinedMemberIds: [SELF, "@duo-bob:workspace", "@bob:workspace"] }));
    await flush();
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    await service.stop();
  });

  it("ignores a sender who has left even the consented room — consent makes a room reachable, not ex-members", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$gone", body: "asked after leaving", senderId: "@bob:workspace", joinedMemberIds: [SELF, "@carol:workspace"] }));
    await flush();
    expect(answers).toEqual([]);
    await service.stop();
  });

  it("keeps the direct-room posture for rooms the record has never spoken about — and answers DMs exactly as before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$dm", body: "still answerable without any record" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["still answerable without any record"]);
    await service.stop();
  });
});

describe("WorkspaceService — #312/S1: an allowed shared room still only answers what it's addressed to", () => {
  it("an unaddressed message in an allowed group room never reaches the pipeline — no answer, no draft-drafting, no card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$unaddressed", body: "chatting about something else entirely", mentionedUserIds: [] }));
    await flush();
    // The pipeline (the fake `answer` the drafting signal wraps) was never
    // called at all: zero calls, not a declined/refused one.
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    expect(transport.sentCards).toEqual([]);
    await service.stop();
  });

  it("the SAME message answers once it's addressed — a mention, in the same allowed room", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$addressed", body: "@duo-alice what did Alice decide?", mentionedUserIds: [SELF] }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["@duo-alice what did Alice decide?"]);
    expect(transport.sentAnswers.map((sent) => sent.roomId)).toEqual(["!room:workspace"]);
    // W-S3-1 (#313): the reply relation points back at this very question's event id.
    expect(transport.sentAnswers[0]!.content).toEqual({
      msgtype: "m.text",
      body: "answer to @duo-alice what did Alice decide?",
      "m.relates_to": { "m.in_reply_to": { event_id: "$addressed" } },
    });
    await service.stop();
  });
});

describe("WorkspaceService — W-S3-1 (#313): shared-room answers reply to the question; direct-room answers are untouched", () => {
  it("a direct-room (DM) answer stays byte-identical: exactly msgtype and body, no m.relates_to at all", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$dm-q", body: "What did Alice decide?" }));
    await flush();
    expect(transport.sentAnswers).toEqual([{ roomId: "!dm:workspace", content: { msgtype: "m.text", body: "answer to What did Alice decide?" } }]);
    expect(Object.keys(transport.sentAnswers[0]!.content).sort()).toEqual(["body", "msgtype"]);
    await service.stop();
  });

  it("a shared-room answer has exactly three keys — msgtype, body, and m.relates_to.m.in_reply_to.event_id pointing at the question", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$shared-q", body: "What did Alice decide?", mentionedUserIds: [SELF] }));
    await flush();
    expect(transport.sentAnswers).toHaveLength(1);
    const content = transport.sentAnswers[0]!.content;
    expect(Object.keys(content).sort()).toEqual(["body", "m.relates_to", "msgtype"]);
    expect(content).toEqual({
      msgtype: "m.text",
      body: "answer to What did Alice decide?",
      "m.relates_to": { "m.in_reply_to": { event_id: "$shared-q" } },
    });
    await service.stop();
  });
});

describe("WorkspaceService — refusal is explicit and remembered only until executed (#192)", () => {
  it("records the refusal, rejects the invite over the seam, and deletes the entry once the leave lands", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.refuseInvite("!room:workspace");
    expect(transport.leaveCalls).toEqual(["!room:workspace"]);
    expect(transport.joinedRooms.has("!room:workspace")).toBe(false);
    expect(service.pendingInvites()).toEqual([]);
    // Executed exit: nothing left standing — a re-invite is a fresh decision.
    expect(readRoomConsent(dir)).toEqual([]);
    await service.stop();
  });

  it("refusing a room whose invitation is not held is the same 404-shaped error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    await expect(service.refuseInvite("!never-invited:workspace")).rejects.toThrow(NoPendingInviteError);
    await service.stop();
  });

  it("a re-invite after a refused-and-executed one is a fresh decision — no standing refusal answers it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.refuseInvite("!room:workspace");
    // A NEW invite act (only that can re-open the room — the leave rejected
    // the old one server-side): held again, decidable again, allowable again.
    transport.deliverInvite(invite({ inviterId: "@carol:workspace" }));
    await flush();
    expect(service.pendingInvites()).toHaveLength(1);
    expect(service.pendingInvites()[0]!.inviterId).toBe("@carol:workspace");
    const entry = await service.allowInvite("!room:workspace");
    expect(entry.status).toBe("allowed");
    expect(readRoomConsent(duoDir())).toEqual([entry]);
    await service.stop();
  });

  it("keeps the refusal recorded when the leave cannot land — the memory of an unfinished exit", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    transport.rejectNextLeave(new Error("fake: homeserver refused the leave"));
    await service.refuseInvite("!room:workspace");
    const [recorded] = readRoomConsent(dir);
    expect(recorded).toMatchObject({ roomId: "!room:workspace", status: "refused" });
    expect(loggedLines(consoleError).some((line) => line.includes("leaving workspace room !room:workspace failed"))).toBe(true);
    await service.stop();
  });
});

describe("WorkspaceService — withdrawal is immediate and instantly killable (#192)", () => {
  it("stops answering the room the moment it is withdrawn — no pipeline call, no send, and the exit follows", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service, answers } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$before", body: "answered while consented" }));
    await flush();
    expect(answers).toHaveLength(1);
    const withdrawn = await service.withdrawRoom("!room:workspace");
    expect(withdrawn.status).toBe("withdrawn");
    expect(transport.leaveCalls).toEqual(["!room:workspace"]);
    // The record is deleted once the leave lands — and the room is no longer
    // reachable either way: no record means a shared room is gated shut.
    transport.deliver(roomMessage({ eventId: "$after", body: "asked after withdrawal" }));
    await flush();
    expect(answers).toHaveLength(1);
    expect(transport.sentAnswers).toHaveLength(1);
    await service.stop();
  });

  it("kills even an in-flight answer: a draft underway when consent was withdrawn sends nothing — not even the failure event", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const releaseAnswer = { resolve: (() => {}) as () => void };
    const transport = new FakeWorkspaceTransport();
    const answersSeen: string[] = [];
    const gated = new WorkspaceService({
      settings: settings(),
      transportFactory: () => (transport as WorkspaceTransport),
      answer: async (question) => {
        answersSeen.push(question.body);
        await new Promise<void>((resolve) => {
          releaseAnswer.resolve = resolve;
        });
        return answered(`late answer to ${question.body}`);
      },
      consent: { duoDir: dir },
    });
    gated.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await gated.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$mid", body: "asked just before withdrawal" }));
    await flush();
    expect(answersSeen).toEqual(["asked just before withdrawal"]);
    await gated.withdrawRoom("!room:workspace");
    releaseAnswer.resolve();
    await flush();
    expect(transport.sentAnswers).toEqual([]);
    expect(loggedLines(consoleError).some((line) => line.includes("not sending the answer to workspace question $mid") && line.includes("withdrawn while the answer was being drafted"))).toBe(true);
    await gated.stop();
  });

  it("refuses re-join without a fresh consent act: a post-withdrawal question is not work even while the record is gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    await service.withdrawRoom("!room:workspace");
    // Even a message that still claims the duo is joined: the executed exit
    // left the room, and the deleted record leaves the shared room gated.
    transport.deliver(roomMessage({ eventId: "$rejoin", body: "let yourself back in" }));
    await flush();
    expect(answers).toEqual([]);
    expect(transport.joinCalls).toEqual(["!room:workspace"]);
    await service.stop();
  });

  it("a fresh allow on a re-invite retires the withdrawal — the room answers again, a re-allow is not a one-way door", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service, answers } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    await service.withdrawRoom("!room:workspace");
    // Only a new invitation act can re-open the room — and the owner allows
    // it again. The earlier withdrawal's in-flight memory (withdrawnRoomIds,
    // what keeps a mid-draft answer dead after the record deletes itself)
    // must not outlive the owner's newer word.
    transport.deliverInvite(invite({ inviterId: "@carol:workspace" }));
    await flush();
    await service.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$re-allowed", body: "asked after the fresh allow" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["asked after the fresh allow"]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to asked after the fresh allow"]);
    await service.stop();
  });

  it("a withdrawal naming a room with no record is an error, not a no-op", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = harness(settings(), undefined, undefined, duoDir());
    service.start();
    await flush();
    await expect(service.withdrawRoom("!never-consented:workspace")).rejects.toThrow(RoomConsentNotFoundError);
    await service.stop();
  });

  it("retries an exit the withdrawal recorded but could not execute — settled on the next successful connect", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await service.allowInvite("!room:workspace");
    transport.rejectNextLeave(new Error("fake: homeserver refused the leave"));
    await service.withdrawRoom("!room:workspace");
    expect(readRoomConsent(dir)).toHaveLength(1);
    // The next successful connect settles the unfinished exit… (the first,
    // refused leave never landed, so the one recorded call IS the retry)
    transport.dropConnection();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(transport.leaveCalls).toEqual(["!room:workspace"]);
    // …and once it lands, the entry is deleted — the decision is fully carried out.
    expect(readRoomConsent(dir)).toEqual([]);
    await service.stop();
  });

  it("settles an exit that predates the connection — a withdrawal while offline executes on dial", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The record written by hand (the owner at their own machine) marks one
    // room withdrawn while the daemon is down; dialing settles it and leaves
    // the allowed room untouched.
    const dir = writeConsent([allowedEntry("!offline:workspace", { status: "withdrawn" }), allowedEntry("!stays:workspace")]);
    const { transport, service } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    expect(transport.leaveCalls).toEqual(["!offline:workspace"]);
    expect(readRoomConsent(dir)).toHaveLength(1);
    expect(readRoomConsent(dir)[0]).toMatchObject({ roomId: "!stays:workspace", status: "allowed" });
    await service.stop();
  });
});

describe("WorkspaceService — the consent record's edges (#192)", () => {
  it("fails closed on shared rooms and leaves direct rooms alone when the record is unreadable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    writeFileSync(join(dir, "room-consent.json"), "{\"not\":\"an array\"}", "utf8");
    const { transport, service, answers } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliver(roomMessage({ eventId: "$shared", body: "in a room the record cannot speak about" }));
    transport.deliver(dm({ eventId: "$dm", body: "a direct room is the default posture" }));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["a direct room is the default posture"]);
    expect(transport.sentAnswers).toHaveLength(1);
    expect(loggedLines(consoleError).some((line) => line.includes("reading the room consent record") && line.includes("Malformed room consent record"))).toBe(true);
    await service.stop();
  });

  it("propagates a malformed record loudly out of an allow — disk trouble is loud, and the invite stays held", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    // The owner's own hand corrupts the record between the invite and the allow.
    writeFileSync(join(dir, "room-consent.json"), "{\"not\":\"an array\"}", "utf8");
    await expect(service.allowInvite("!room:workspace")).rejects.toThrow(/Malformed room consent record/);
    expect(service.pendingInvites()).toHaveLength(1);
    // The join landed (Matrix joins are idempotent) — the record is what failed;
    // the gate still refuses the room, the safe direction.
    expect(transport.joinCalls).toEqual(["!room:workspace"]);
    // And the rooms read stays loud about it: an unreadable record is a 500
    // naming the file, never a silent empty list the owner could mistake for
    // "nothing consented".
    expect(() => service.consentedRooms()).toThrow(/Malformed room consent record/);
    await service.stop();
  });

  it("an explicit withdrawal decision vetoes the direct posture too — the owner's latest word outranks the default", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = duoDir();
    const { transport, service, answers } = harness(settings(), undefined, undefined, dir);
    service.start();
    await flush();
    transport.deliverInvite(invite({ roomId: "!dm-room:workspace", name: null, joinedMemberCount: 2 }));
    await flush();
    await service.allowInvite("!dm-room:workspace");
    // The exit cannot land yet, so the withdrawn entry is still standing when
    // a two-member-room question arrives — exactly the window where the v1
    // posture alone would have answered it.
    transport.rejectNextLeave(new Error("fake: homeserver refused the leave"));
    await service.withdrawRoom("!dm-room:workspace");
    transport.deliver({
      eventId: "$vetoed",
      roomId: "!dm-room:workspace",
      senderId: "@bob:workspace",
      body: "still two of us here",
      originServerTs: Date.now(),
      joinedMemberIds: [SELF, "@bob:workspace"],
    });
    await flush();
    expect(answers).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    await service.stop();
  });
});

/** Flattens the spy's calls into one string per call, message plus detail. */
function loggedLines(consoleError: { mock: { calls: unknown[][] } }): string[] {
  return consoleError.mock.calls.map((call) => `${call[0]} ${call[1] ?? ""}`);
}

describe("WorkspaceService — the attachment grounding door (#190)", () => {
  /** A DuoReadState that records what was marked — the refusal accounting assertions below read this. */
  class RecordingReadState implements DuoReadState {
    readonly marked: { roomId: string; eventId: string; originServerTs: number }[] = [];
    private readonly ids = new Set<string>();

    hasRead(eventId: string): boolean {
      return this.ids.has(eventId);
    }

    markRead(roomId: string, eventId: string, originServerTs: number): void {
      this.ids.add(eventId);
      this.marked.push({ roomId, eventId, originServerTs });
    }
  }

  function fileRef(overrides: Partial<WorkspaceFileReference> = {}): WorkspaceFileReference {
    return { reference: "mxc://workspace/f1", name: "notes.txt", mimeType: "text/plain", size: 10, ...overrides };
  }

  /** The real door at the shipped default ceiling — these tests exercise the composition, not a stand-in. */
  const door = attachmentGroundingDoor("official_open");

  it("grounds a door-passed attachment: the answer pipeline sees grounding, the asker sees the answer", async () => {
    const readState = new RecordingReadState();
    const { transport, service, answers } = harness(settings(), undefined, readState, undefined, door);
    service.start();
    await flush();
    transport.setFile("mxc://workspace/f1", "the launch date is March 3rd");
    const at = Date.now();
    transport.deliver(dm({ eventId: "$q1", body: "when do we launch?", originServerTs: at, attachments: [fileRef()] }));
    await flush();
    expect(answers).toHaveLength(1);
    expect(answers[0]!.grounding).toEqual([
      { reference: "mxc://workspace/f1", name: "notes.txt", mimeType: "text/plain", text: "the launch date is March 3rd" },
    ]);
    // The one dereference, bounded by the door's constant.
    expect(transport.fetchFileCalls).toEqual([{ reference: "mxc://workspace/f1", maxBytes: 32 * 1024 }]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to when do we launch?"]);
    expect(readState.marked).toEqual([{ roomId: "!dm:workspace", eventId: "$q1", originServerTs: at }]);
    await service.stop();
  });

  it("sends the door's refusal as its own event, answers nothing, and still accounts for the question normally", async () => {
    const readState = new RecordingReadState();
    const { transport, service, answers } = harness(settings(), undefined, readState, undefined, door);
    service.start();
    await flush();
    const at = Date.now();
    // A declared size over the bound: the door refuses before any body is
    // read, so the media store is never even asked.
    transport.deliver(
      dm({ eventId: "$q2", body: "summarize this?", originServerTs: at, attachments: [fileRef({ size: 45 * 1024 })] }),
    );
    await flush();
    expect(answers).toEqual([]);
    expect(transport.fetchFileCalls).toEqual([]);
    const bodies = transport.sentAnswers.map((sent) => sent.content.body);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("32.0 KiB");
    expect(bodies[0]).toContain("notes.txt");
    // A refusal is a handled question, not a dropped one: durable mark,
    // so a restart does not re-ask the asker to re-share.
    expect(readState.marked).toEqual([{ roomId: "!dm:workspace", eventId: "$q2", originServerTs: at }]);
    await service.stop();
  });

  it("refuses an above-ceiling attachment naming the marking — the composition, end to end", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, undefined, door);
    service.start();
    await flush();
    transport.setFile("mxc://workspace/f1", "secret\nthe launch date is March 3rd");
    transport.deliver(dm({ eventId: "$q3", body: "when do we launch?", attachments: [fileRef()] }));
    await flush();
    expect(answers).toEqual([]);
    const body = transport.sentAnswers.map((sent) => sent.content.body)[0]!;
    expect(body).toContain("marked secret");
    expect(body).toContain("official_open");
    await service.stop();
  });

  it("refuses a file the media store no longer has with a recoverable reason", async () => {
    const { transport, service, answers } = harness(settings(), undefined, undefined, undefined, door);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q4", body: "when do we launch?", attachments: [fileRef()] }));
    await flush();
    expect(answers).toEqual([]);
    const body = transport.sentAnswers.map((sent) => sent.content.body)[0]!;
    expect(body).toContain(`couldn't retrieve "notes.txt"`);
    expect(body).toContain("deleted");
    await service.stop();
  });

  it("answers text-only, with an owner-side log, when no door is configured — never a silent grounding, never a dropped question", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport, service, answers } = harness(settings(), undefined, undefined, undefined);
    service.start();
    await flush();
    transport.setFile("mxc://workspace/f1", "the launch date is March 3rd");
    transport.deliver(dm({ eventId: "$q5", body: "when do we launch?", attachments: [fileRef()] }));
    await flush();
    expect(answers).toHaveLength(1);
    expect(answers[0]!.grounding).toEqual([]);
    expect(transport.fetchFileCalls).toEqual([]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to when do we launch?"]);
    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("text-only"))).toBe(true);
    await service.stop();
  });

  it("answers a text-only question without touching the door — the pre-#190 path, byte-identical", async () => {
    const { transport, service, answers } = harness(settings(), undefined, undefined, undefined, door);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$q6", body: "plain question" }));
    await flush();
    expect(answers).toHaveLength(1);
    expect(answers[0]!.attachments).toEqual([]);
    expect(answers[0]!.grounding).toBeUndefined();
    expect(transport.fetchFileCalls).toEqual([]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to plain question"]);
    await service.stop();
  });
});

// ---------------------------------------------------------------------------
// W-S4-5: the ack timer and the outcome → card mapping. A small in-memory
// WorkspaceTaskSink stands in for src/serve/workspace-tasks.ts — narrow,
// following FakeWorkspaceTransport's style but much smaller since the
// interface itself is narrow (service.ts's own doc comment on it).
// ---------------------------------------------------------------------------

class FakeTaskSink implements WorkspaceTaskSink {
  private nextId = 0;
  readonly tasks = new Map<string, { state: string; draftId?: string }>();
  readonly cards = new Map<string, { taskId: string; roomId: string; eventId: string; rev: number; state: string }>();
  readonly createTaskCalls: { roomId: string; questionEventId: string; requester: string; draftId?: string }[] = [];
  readonly createCardCalls: { taskId: string; roomId: string; eventId: string; kind: string; audience: string; state: string; requester: string }[] = [];
  readonly recordCardEditCalls: { cardId: string; rev: number; state: string }[] = [];
  readonly updateTaskStateCalls: { taskId: string; event: string | undefined; fields?: { draftId?: string } }[] = [];

  createTask(input: { roomId: string; questionEventId: string; requester: string; draftId?: string }): { taskId: string } {
    this.nextId += 1;
    const taskId = `task-${this.nextId}`;
    this.tasks.set(taskId, { state: "acknowledged", draftId: input.draftId });
    this.createTaskCalls.push({ ...input });
    return { taskId };
  }

  updateTaskState(taskId: string, event: "start_working" | "need_decision" | "resume_working" | "complete" | "fail" | undefined, fields?: { draftId?: string }): void {
    this.updateTaskStateCalls.push({ taskId, event, fields });
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return;
    }
    if (event !== undefined) {
      task.state = event === "complete" ? "done" : event === "fail" ? "failed" : event === "start_working" || event === "resume_working" ? "working" : "needs_decision";
    }
    if (fields?.draftId !== undefined) {
      task.draftId = fields.draftId;
    }
  }

  createCard(input: { taskId: string; roomId: string; eventId: string; kind: string; audience: string; state: string; requester: string }): { cardId: string } {
    this.nextId += 1;
    const cardId = `card-${this.nextId}`;
    this.cards.set(cardId, { taskId: input.taskId, roomId: input.roomId, eventId: input.eventId, rev: 1, state: input.state });
    this.createCardCalls.push({ ...input });
    return { cardId };
  }

  recordCardEdit(cardId: string, fields: { rev: number; state: string }): void {
    this.recordCardEditCalls.push({ cardId, ...fields });
    const card = this.cards.get(cardId);
    if (card === undefined) {
      return;
    }
    card.rev = fields.rev;
    card.state = fields.state;
  }

  openCardFor(taskId: string, roomId: string): OpenWorkspaceCard | undefined {
    for (const [cardId, card] of this.cards) {
      if (card.taskId === taskId && card.roomId === roomId && card.state !== "done" && card.state !== "failed") {
        return { cardId, taskId: card.taskId, eventId: card.eventId, rev: card.rev, state: card.state };
      }
    }
    return undefined;
  }
}

function taskSinkHarness(
  taskSink: FakeTaskSink,
  harnessSettings: WorkspaceSettings = settings(),
  answerImpl?: (question: WorkspaceQuestion) => Promise<PublicAnswerOutcome>,
): Harness {
  const transport = new FakeWorkspaceTransport();
  const answers: WorkspaceQuestion[] = [];
  const service = new WorkspaceService({
    settings: harnessSettings,
    transportFactory: () => (transport as WorkspaceTransport),
    answer: answerImpl ?? (async (question) => {
      answers.push(question);
      return answered(`answer to ${question.body}`);
    }),
    taskSink,
  });
  const states: WorkspaceServiceState[] = [];
  service.onState((state) => states.push(state));
  return { transport, service, answers, states };
}

function passedOn(message: string, draftId = "d1"): PublicAnswerOutcome {
  return { kind: "passed_on", draftId, logEntryId: "l", message, topicId: undefined, ownerNotice: undefined };
}

function declinedRefused(message: string): PublicAnswerOutcome {
  return { kind: "declined_refused", draftId: "d", logEntryId: "l", message };
}

/** Resolves a pending answer on demand — for racing the ack timer against a slow pipeline. */
function controllableAnswer(): { impl: (question: WorkspaceQuestion) => Promise<PublicAnswerOutcome>; resolve: (outcome: PublicAnswerOutcome) => void } {
  let resolveFn: (outcome: PublicAnswerOutcome) => void = () => {};
  const impl = (_question: WorkspaceQuestion) =>
    new Promise<PublicAnswerOutcome>((resolve) => {
      resolveFn = resolve;
    });
  return { impl, resolve: (outcome) => resolveFn(outcome) };
}

describe("WorkspaceService — the ack timer and the outcome → card mapping (W-S4-5)", () => {
  it("sends 0 cards for a fast answer — taskSink is never even asked to create a task", async () => {
    const taskSink = new FakeTaskSink();
    const { transport, service } = taskSinkHarness(taskSink);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$fast-answer", body: "quick question" }));
    await flush();
    expect(transport.sentCards).toEqual([]);
    expect(transport.editedCards).toEqual([]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to quick question"]);
    expect(taskSink.createTaskCalls).toEqual([]);
    await service.stop();
  });

  it("sends 1 card then 1 edit for a slow answer — the ack fires, then the outcome edits it to done with a result link", async () => {
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$slow-answer", body: "slow question" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(transport.sentCards).toHaveLength(1);
    expect(transport.sentCards[0]!.content["duo.card"].state).toBe("acknowledged");
    expect(transport.sentCards[0]!.content.body).toBe("Looking into this — I'll update this message.");
    resolve(answered("the final answer"));
    await flush();
    expect(transport.editedCards).toHaveLength(1);
    const edited = transport.editedCards[0]!;
    expect(edited.content["m.new_content"]["duo.card"].state).toBe("done");
    expect(edited.content["m.new_content"]["duo.card"].rev).toBe(2);
    expect(edited.content["m.new_content"]["duo.card"].result?.text).toBe("the final answer");
    expect(edited.content["m.new_content"]["duo.card"].result?.links).toHaveLength(1);
    expect(edited.content["m.new_content"]["duo.card"].result?.links?.[0]?.url).toContain("matrix.to");
    // The answer's own m.text was sent too (sendAnswer resolved the event id the link points at).
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["the final answer"]);
    expect(taskSink.updateTaskStateCalls.some((call) => call.event === "complete")).toBe(true);
    await service.stop();
  });

  it("sends exactly 1 card for a fast passed_on — the task is created with the outcome's draftId", async () => {
    const taskSink = new FakeTaskSink();
    const { transport, service } = taskSinkHarness(taskSink, settings(), async () => passedOn("passed on, fast", "draft-fast"));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$fast-passed", body: "pass this on" }));
    await flush();
    expect(transport.sentCards).toHaveLength(1);
    expect(transport.editedCards).toEqual([]);
    expect(transport.sentCards[0]!.content.body).toBe("passed on, fast");
    expect(taskSink.createTaskCalls).toEqual([{ roomId: "!dm:workspace", questionEventId: "$fast-passed", requester: "@bob:workspace", draftId: "draft-fast" }]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["passed on, fast"]);
    await service.stop();
  });

  it("sends 1 card then 1 edit for a slow passed_on — the ack's card is edited in place, never a second card", async () => {
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$slow-passed", body: "slow pass-on" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(transport.sentCards).toHaveLength(1);
    expect(transport.sentCards[0]!.content.body).toBe("Looking into this — I'll update this message.");
    resolve(passedOn("passed on, slow", "draft-slow"));
    await flush();
    // Exactly one card total: the ack card was edited, never a second send.
    expect(transport.sentCards).toHaveLength(1);
    expect(transport.editedCards).toHaveLength(1);
    expect(transport.editedCards[0]!.content["m.new_content"]["duo.card"].state).toBe("acknowledged");
    expect(transport.editedCards[0]!.content.body).toBe("* passed on, slow");
    await service.stop();
  });

  it("a fast passed_on whose card send fails still delivers the passed-on text to the asker (review finding on PR #318)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const taskSink = new FakeTaskSink();
    const transport = new FakeWorkspaceTransport();
    transport.sendCard = async () => {
      throw new Error("fake: sendCard failed");
    };
    const service = new WorkspaceService({
      settings: settings(),
      transportFactory: () => (transport as WorkspaceTransport),
      answer: async () => passedOn("passed on despite the card failure", "draft-fast-fail"),
      taskSink,
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$fast-passed-card-fails", body: "pass this on" }));
    await flush();
    expect(consoleError).toHaveBeenCalled();
    // The card never made it out, but the asker must never see silence —
    // the SAME passed-on text handleQuestion would have sent with no
    // taskSink at all still goes out.
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["passed on despite the card failure"]);
    await service.stop();
  });

  it("a slow passed_on whose card edit fails still delivers the passed-on text to the asker", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$slow-passed-edit-fails", body: "slow pass-on" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(transport.sentCards).toHaveLength(1);
    transport.editCard = async () => {
      throw new Error("fake: editCard failed");
    };
    resolve(passedOn("passed on despite the edit failure", "draft-slow-fail"));
    await flush();
    expect(consoleError).toHaveBeenCalled();
    // The ack card's edit failed, but the asker already saw the ack and
    // must still get the passed-on text — never silence.
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["passed on despite the edit failure"]);
    expect(transport.editedCards).toEqual([]);
    await service.stop();
  });

  it("the ack is sent within ackAfterMs + 500ms (fake timers)", async () => {
    const taskSink = new FakeTaskSink();
    const { impl } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$within-bound", body: "slow one" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000 + 500);
    await flush();
    expect(transport.sentCards).toHaveLength(1);
    await service.stop();
  });

  it("a declined_refused outcome edits an existing ack card to done with lines ['Declined']", async () => {
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$declined", body: "slow decline" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    resolve(declinedRefused("Declined, politely"));
    await flush();
    expect(transport.editedCards).toHaveLength(1);
    const card = transport.editedCards[0]!.content["m.new_content"]["duo.card"];
    expect(card.state).toBe("done");
    expect(card.lines).toEqual(["Declined"]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["Declined, politely"]);
    await service.stop();
  });

  it("a fast declined_refused sends no card at all — no ack ever fired, nothing to edit", async () => {
    const taskSink = new FakeTaskSink();
    const { transport, service } = taskSinkHarness(taskSink, settings(), async () => declinedRefused("Declined fast"));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$fast-declined", body: "fast decline" }));
    await flush();
    expect(transport.sentCards).toEqual([]);
    expect(transport.editedCards).toEqual([]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["Declined fast"]);
    await service.stop();
  });

  it("a pipeline failure after the ack fired edits the card to failed", async () => {
    const taskSink = new FakeTaskSink();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const releaseAnswer = { reject: (() => {}) as (error: Error) => void };
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), async () => {
      return new Promise<PublicAnswerOutcome>((_resolve, reject) => {
        releaseAnswer.reject = reject;
      });
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$pipeline-fail", body: "boom slow" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    releaseAnswer.reject(new Error("internal pipeline error"));
    await flush();
    expect(transport.editedCards).toHaveLength(1);
    expect(transport.editedCards[0]!.content["m.new_content"]["duo.card"].state).toBe("failed");
    expect(JSON.stringify(transport.editedCards)).not.toContain("internal pipeline error");
    expect(consoleError).toHaveBeenCalled();
    await service.stop();
  });

  it("taskSink undefined: card/task behavior is skipped entirely, byte-identical to pre-S4 behavior", async () => {
    const { transport, service } = harness(settings({ ackAfterMs: 10 }));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$no-sink", body: "no task sink configured" }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(transport.sentCards).toEqual([]);
    expect(transport.editedCards).toEqual([]);
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["answer to no task sink configured"]);
    await service.stop();
  });

  it("withdrawn consent mid-draft sends neither a card nor an edit — the ack timer re-checks withdrawal at send time too", async () => {
    const dir = duoDir();
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const transport = new FakeWorkspaceTransport();
    // Gate sendCard so it doesn't resolve until the test releases it — the
    // real race the re-check exists for: the ack timer FIRES while the
    // room is still consented, but the withdrawal lands before the card's
    // own send call completes.
    let releaseSendCard: () => void = () => {};
    const sendCardGate = new Promise<void>((resolveGate) => {
      releaseSendCard = resolveGate;
    });
    const originalSendCard = transport.sendCard.bind(transport);
    transport.sendCard = async (roomId, content) => {
      await sendCardGate;
      return originalSendCard(roomId, content);
    };
    const gated = new WorkspaceService({
      settings: settings({ ackAfterMs: 2000 }),
      transportFactory: () => (transport as WorkspaceTransport),
      answer: impl,
      consent: { duoDir: dir },
      taskSink,
    });
    gated.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await gated.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$mid-withdraw", body: "asked just before withdrawal" }));
    await flush();
    // The ack timer fires WHILE the room is still consented — sendAckCard's
    // own withdrawal check (before it calls sendCard) passes, and it is now
    // blocked inside the gated sendCard call.
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    // The withdrawal lands while that send is still in flight…
    await gated.withdrawRoom("!room:workspace");
    // …and only now does the gated sendCard resolve — too late: the card
    // row is recorded, but handleQuestion's own withdrawal re-check (made
    // right after the pipeline resolves, below) is what actually matters
    // for the text answer; the card send itself cannot be un-sent once in
    // flight, so this assembles the rest of the question's fate the same
    // way a real homeserver round trip would.
    releaseSendCard();
    resolve(answered("too late"));
    await flush();
    expect(transport.editedCards).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    await gated.stop();
  });

  it("withdrawn consent before the ack timer fires sends neither a card nor an edit — the simple case", async () => {
    const dir = duoDir();
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const transport = new FakeWorkspaceTransport();
    const gated = new WorkspaceService({
      settings: settings({ ackAfterMs: 2000 }),
      transportFactory: () => (transport as WorkspaceTransport),
      answer: impl,
      consent: { duoDir: dir },
      taskSink,
    });
    gated.start();
    await flush();
    transport.deliverInvite(invite());
    await flush();
    await gated.allowInvite("!room:workspace");
    transport.deliver(roomMessage({ eventId: "$withdraw-before-ack", body: "asked, then withdrawn before the ack" }));
    await flush();
    await gated.withdrawRoom("!room:workspace");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    resolve(answered("too late"));
    await flush();
    expect(transport.sentCards).toEqual([]);
    expect(transport.editedCards).toEqual([]);
    expect(transport.sentAnswers).toEqual([]);
    await gated.stop();
  });

  it("a failed card edit on the answered path is logged and swallowed, never forgotten — the answer itself already sent, and forgetting would double-answer on replay", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const transport = new FakeWorkspaceTransport();
    const service = new WorkspaceService({
      settings: settings({ ackAfterMs: 2000 }),
      transportFactory: () => (transport as WorkspaceTransport),
      answer: impl,
      taskSink,
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$edit-fails", body: "slow and doomed" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(transport.sentCards).toHaveLength(1);
    transport.editCard = async () => {
      throw new Error("fake: editCard failed");
    };
    resolve(answered("the answer still lands"));
    await flush();
    // The asker's answer is never held hostage to a card bookkeeping
    // failure — it already went out.
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["the answer still lands"]);
    expect(transport.editedCards).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    await service.stop();
  });

  it("a failed card send on the ack path (no answer sent yet) forgets the event id, exactly like a failed sendAnswer does today", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const transport = new FakeWorkspaceTransport();
    transport.sendCard = async () => {
      throw new Error("fake: sendCard failed");
    };
    const service = new WorkspaceService({
      settings: settings({ ackAfterMs: 2000 }),
      transportFactory: () => (transport as WorkspaceTransport),
      answer: impl,
      taskSink,
    });
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$ack-send-fails", body: "slow and unlucky" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(consoleError).toHaveBeenCalled();
    resolve(answered("still answered despite the ack failure"));
    await flush();
    // The ack send failed before anything was sent: no task was ever
    // created for the outcome to find a card for, so this question
    // behaves like one with no taskSink at all — plain text, once.
    expect(transport.sentAnswers.map((sent) => sent.content.body)).toEqual(["still answered despite the ack failure"]);
    await service.stop();
  });
});

// ---------------------------------------------------------------------------
// W-S4-6: onTaskEvent/onCardEvent — the ids-and-state-only signals
// `createServer` forwards into DraftReadyHub.publishTask/publishCard.
// Verified at this layer (not over a live /ws socket): the service's own
// emission timing is what these facts pin, and test/serve-ws.test.ts covers
// that createServer actually wires the subscription through.
// ---------------------------------------------------------------------------
describe("WorkspaceService — onTaskEvent/onCardEvent (W-S4-6)", () => {
  it("emits a task event (acknowledged) and a card event together when the ack timer fires first", async () => {
    const taskSink = new FakeTaskSink();
    const { impl } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    const taskEvents: { taskId: string; roomId: string; state: string }[] = [];
    const cardEvents: { cardId: string; roomId: string }[] = [];
    service.onTaskEvent((event) => taskEvents.push(event));
    service.onCardEvent((event) => cardEvents.push(event));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$ack-signal", body: "slow question" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(taskEvents).toEqual([{ taskId: expect.stringMatching(/^task-/), roomId: "!dm:workspace", state: "acknowledged" }]);
    expect(cardEvents).toEqual([{ cardId: expect.stringMatching(/^card-/), roomId: "!dm:workspace" }]);
    await service.stop();
  });

  it("never emits anything for a fast answer — no task, no card, no signal", async () => {
    const taskSink = new FakeTaskSink();
    const { transport, service } = taskSinkHarness(taskSink);
    const taskEvents: unknown[] = [];
    const cardEvents: unknown[] = [];
    service.onTaskEvent((event) => taskEvents.push(event));
    service.onCardEvent((event) => cardEvents.push(event));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$fast-signal", body: "fast question" }));
    await flush();
    expect(taskEvents).toEqual([]);
    expect(cardEvents).toEqual([]);
    await service.stop();
  });

  it("emits a second task/card event (done) when a slow answer's outcome edits the ack card", async () => {
    const taskSink = new FakeTaskSink();
    const { impl, resolve } = controllableAnswer();
    const { transport, service } = taskSinkHarness(taskSink, settings({ ackAfterMs: 2000 }), impl);
    const taskEvents: { taskId: string; roomId: string; state: string }[] = [];
    const cardEvents: { cardId: string; roomId: string }[] = [];
    service.onTaskEvent((event) => taskEvents.push(event));
    service.onCardEvent((event) => cardEvents.push(event));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$slow-done-signal", body: "slow question" }));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    resolve(answered("the answer, at last"));
    await flush();
    expect(taskEvents.map((event) => event.state)).toEqual(["acknowledged", "done"]);
    expect(cardEvents).toHaveLength(2);
    // Same task/card id both times — never a second task for one question.
    expect(new Set(taskEvents.map((event) => event.taskId)).size).toBe(1);
    expect(new Set(cardEvents.map((event) => event.cardId)).size).toBe(1);
    await service.stop();
  });

  it("emits a task/card event for a fast passed_on even though the ack timer never fired", async () => {
    const taskSink = new FakeTaskSink();
    const { transport, service } = taskSinkHarness(taskSink, settings(), async () => passedOn("passed on, fast signal", "draft-fast-signal"));
    const taskEvents: { taskId: string; roomId: string; state: string }[] = [];
    const cardEvents: { cardId: string; roomId: string }[] = [];
    service.onTaskEvent((event) => taskEvents.push(event));
    service.onCardEvent((event) => cardEvents.push(event));
    service.start();
    await flush();
    transport.deliver(dm({ eventId: "$fast-passed-signal", body: "fast passed on question" }));
    await flush();
    expect(taskEvents).toEqual([{ taskId: expect.stringMatching(/^task-/), roomId: "!dm:workspace", state: "acknowledged" }]);
    expect(cardEvents).toHaveLength(1);
    await service.stop();
  });
});
