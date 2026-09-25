import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../src/permissions/public-answer.js";
import { availabilityOfState, reconnectDelayMs, RecentlySeenEventIds, WorkspaceService, type WorkspaceServiceState } from "../src/workspace/service.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import { WorkspaceTokenRevokedError, type WorkspaceQuestion, type WorkspaceTransport, type WorkspaceMemberIdentityListing } from "../src/workspace/transport.js";
import { FakeWorkspaceTransport } from "./helpers/fake-workspace-transport.js";
import { memberOf } from "./helpers/workspace-member.js";

const SELF = "@duo-alice:workspace";

function settings(overrides: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return {
    homeserverUrl: "https://matrix.workspace.example",
    accessToken: "token",
    userId: SELF,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 8000 },
    presenceIntervalMs: 5000,
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

function harness(harnessSettings: WorkspaceSettings = settings(), answerImpl?: (question: WorkspaceQuestion) => Promise<PublicAnswerOutcome>): Harness {
  const transport = new FakeWorkspaceTransport();
  const answers: WorkspaceQuestion[] = [];
  const service = new WorkspaceService({
    settings: harnessSettings,
    transportFactory: () => (transport as WorkspaceTransport),
    answer: answerImpl ?? (async (question) => {
      answers.push(question);
      return answered(`answer to ${question.body}`);
    }),
  });
  const states: WorkspaceServiceState[] = [];
  service.onState((state) => states.push(state));
  return { transport, service, answers, states };
}

function dm(message: { eventId: string; body: string; senderId?: string }) {
  return {
    eventId: message.eventId,
    roomId: "!dm:workspace",
    senderId: message.senderId ?? "@bob:workspace",
    body: message.body,
    joinedMemberIds: [SELF, "@bob:workspace"],
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

  onMessage(): void {}

  onDisconnected(): void {}
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
