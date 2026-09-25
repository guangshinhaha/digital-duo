import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, RoomEvent, SyncState } from "matrix-js-sdk";
import { createMatrixTransport } from "../src/workspace/matrix-transport.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import type { WorkspaceCandidateMessage } from "../src/workspace/transport.js";

/**
 * Pins the adapter's contract at the seam, with matrix-js-sdk mocked into a
 * stub emitter client. The module's own design keeps this file unexecuted by
 * the service tests (they run against the fake), which is exactly why it
 * needs to exist: an SDK bump that changes SyncState semantics, an inverted
 * normalization guard, or a stop() that leaves a pending connect hung would
 * otherwise ship behind a fully green suite. The stub replays the SDK's
 * event shapes (ClientEvent.Sync / RoomEvent.Timeline argument lists) — if
 * the real SDK drifts from them, this file is where that shows up first.
 */

type Listener = (...args: unknown[]) => void;

/** The SDK surface the adapter touches: an emitter plus the five calls it makes. */
class StubMatrixClient {
  startCalls = 0;
  stopCalls = 0;
  presenceReports = 0;
  readonly sentMessages: { roomId: string; content: unknown }[] = [];
  startClientError: Error | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const forEvent = this.listeners.get(event) ?? new Set();
    forEvent.add(listener);
    this.listeners.set(event, forEvent);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeAllListeners(event: string): this {
    this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
    return true;
  }

  async startClient(): Promise<void> {
    this.startCalls += 1;
    if (this.startClientError) {
      throw this.startClientError;
    }
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  async sendMessage(roomId: string, content: unknown): Promise<unknown> {
    this.sentMessages.push({ roomId, content });
    return {};
  }

  async setPresence(): Promise<unknown> {
    this.presenceReports += 1;
    return {};
  }
}

let client: StubMatrixClient;

vi.mock("matrix-js-sdk", () => ({
  // The subset of the SDK's surface the adapter destructures; the string
  // values match the real enums, and the tests emit through these same
  // mocked constants so there is no literal drift between the two sides.
  ClientEvent: { Sync: "sync" },
  RoomEvent: { Timeline: "Room.timeline" },
  EventType: { RoomMessage: "m.room.message" },
  MsgType: { Text: "m.text" },
  SetPresence: { Online: "online" },
  SyncState: { Error: "Error", Prepared: "Prepared", Stopped: "Stopped" },
  createClient: () => client,
}));

function settings(): WorkspaceSettings {
  return {
    homeserverUrl: "https://matrix.workspace.example",
    accessToken: "token",
    userId: "@duo-alice:workspace",
    reconnect: { initialDelayMs: 1000, maxDelayMs: 8000 },
    presenceIntervalMs: 5000,
  };
}

interface TimelineEventInit {
  eventId?: string;
  roomId?: string;
  senderId?: string;
  senderMissing?: boolean;
  type?: string;
  msgtype?: unknown;
  body?: unknown;
}

function timelineEvent(init: TimelineEventInit = {}) {
  return {
    getType: () => init.type ?? "m.room.message",
    getContent: () => ({ msgtype: init.msgtype ?? "m.text", body: init.body ?? "What did Alice decide?" }),
    getSender: () => (init.senderMissing ? undefined : (init.senderId ?? "@bob:workspace")),
    getId: () => init.eventId ?? "$e1",
    getRoomId: () => init.roomId ?? "!room:workspace",
  };
}

function room(members: readonly string[] = ["@duo-alice:workspace", "@bob:workspace"]) {
  return {
    roomId: "!room:workspace",
    getJoinedMembers: () => members.map((userId) => ({ userId })),
  };
}

beforeEach(() => {
  client = new StubMatrixClient();
});

describe("Matrix adapter — connect settles exactly on the SDK's sync states", () => {
  it("resolves connect() when sync reaches Prepared, after starting the client exactly once", async () => {
    const transport = createMatrixTransport(settings());
    const connecting = transport.connect();
    // Transient states pass through without settling anything.
    client.emit(ClientEvent.Sync, "Syncing", null, undefined);
    client.emit(ClientEvent.Sync, SyncState.Prepared, "Syncing", undefined);
    await expect(connecting).resolves.toBeUndefined();
    expect(client.startCalls).toBe(1);
  });

  it("rejects connect() when sync reaches Error, carrying the SDK's error message", async () => {
    const transport = createMatrixTransport(settings());
    const connecting = transport.connect();
    client.emit(ClientEvent.Sync, SyncState.Error, "Syncing", { error: new Error("synapse is down") });
    await expect(connecting).rejects.toThrow(/workspace sync failed: synapse is down/);
  });

  it("rejects connect() when startClient itself fails", async () => {
    client.startClientError = new Error("no crypto store");
    const transport = createMatrixTransport(settings());
    await expect(transport.connect()).rejects.toThrow(/no crypto store/);
  });
});

describe("Matrix adapter — stop() is a shutdown, not a suggestion", () => {
  it("rejects a still-pending connect and stops the client", async () => {
    const transport = createMatrixTransport(settings());
    const connecting = transport.connect();
    await transport.stop();
    await expect(connecting).rejects.toThrow(/stopped before connect finished/);
    expect(client.stopCalls).toBe(1);
  });

  it("silences the sync and timeline handlers afterwards — no disconnect, no message, after stop()", async () => {
    const transport = createMatrixTransport(settings());
    const connecting = transport.connect();
    client.emit(ClientEvent.Sync, SyncState.Prepared, null, undefined);
    await expect(connecting).resolves.toBeUndefined();
    const messages: WorkspaceCandidateMessage[] = [];
    let disconnects = 0;
    transport.onMessage((message) => messages.push(message));
    transport.onDisconnected(() => {
      disconnects += 1;
    });
    await transport.stop();
    client.emit(ClientEvent.Sync, SyncState.Error, SyncState.Prepared, { error: new Error("late") });
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$late" }), room(), false, false, {});
    expect(disconnects).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe("Matrix adapter — onDisconnected fires only on the states the SDK cannot ride out", () => {
  it("fires on Error and Stopped, not on transient states", () => {
    const transport = createMatrixTransport(settings());
    let disconnects = 0;
    transport.onDisconnected(() => {
      disconnects += 1;
    });
    client.emit(ClientEvent.Sync, "Syncing", null, undefined);
    client.emit(ClientEvent.Sync, "Reconnecting", "Syncing", undefined);
    expect(disconnects).toBe(0);
    client.emit(ClientEvent.Sync, SyncState.Error, "Syncing", { error: new Error("gave up") });
    client.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Error, undefined);
    expect(disconnects).toBe(2);
  });
});

describe("Matrix adapter — timeline normalization at the seam", () => {
  it("forwards a text room message normalized to the seam's shape, live and backlog-replayed alike", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    // Backlog (replayed by the initial sync — the held-not-lost path), then live.
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$held" }), room(), true, false, {});
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$live" }), room(), false, false, {});
    expect(messages).toEqual([
      {
        eventId: "$held",
        roomId: "!room:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide?",
        joinedMemberIds: ["@duo-alice:workspace", "@bob:workspace"],
      },
      {
        eventId: "$live",
        roomId: "!room:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide?",
        joinedMemberIds: ["@duo-alice:workspace", "@bob:workspace"],
      },
    ]);
  });

  it("drops everything that is not a text room message from a sender in a room", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$enc", type: "m.room.encrypted" }), room(), false, false, {});
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$notice", msgtype: "m.notice" }), room(), false, false, {});
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$nobody" }), undefined, false, false, {});
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$nosender", senderMissing: true }), room(), false, false, {});
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$removed" }), room(), false, true, {});
    expect(messages).toEqual([]);
  });
});

describe("Matrix adapter — outbound calls", () => {
  it("sendAnswer posts exactly the built content to the question's room, as the duo's own m.text", async () => {
    const transport = createMatrixTransport(settings());
    await transport.sendAnswer("!room:workspace", { msgtype: "m.text", body: "Approved on 2026-08-14." });
    expect(client.sentMessages).toEqual([
      { roomId: "!room:workspace", content: { msgtype: "m.text", body: "Approved on 2026-08-14." } },
    ]);
  });

  it("markAlive reports online presence to the homeserver", async () => {
    const transport = createMatrixTransport(settings());
    await transport.markAlive();
    expect(client.presenceReports).toBe(1);
  });
});
