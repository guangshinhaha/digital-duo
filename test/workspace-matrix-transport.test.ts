import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, RoomEvent, SyncState } from "matrix-js-sdk";
import { createMatrixTransport } from "../src/workspace/matrix-transport.js";
import type { RoomInvite } from "../src/workspace/messages.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import { WorkspaceTokenRevokedError, type WorkspaceCandidateMessage } from "../src/workspace/transport.js";

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

/** The SDK surface the adapter touches: an emitter plus the calls it makes. */
class StubMatrixClient {
  startCalls = 0;
  stopCalls = 0;
  presenceReports = 0;
  directorySearches = 0;
  presenceLookups = 0;
  /** Concurrency the fan-out actually reached — read after the call settles to pin the pace. */
  maxPresenceInFlight = 0;
  private presenceInFlight = 0;
  readonly sentMessages: { roomId: string; content: unknown }[] = [];
  /** Every authenticated media download, exactly as the adapter issued it (#190). */
  readonly authedRequests: { method: unknown; path: string; opts: Record<string, unknown> }[] = [];
  /** Bodies of every authed request, index-aligned with authedRequests (#315's leave reason rides one). */
  readonly authedBodies: unknown[] = [];
  /** What authedRequest serves the next media download — a raw body, as rawResponseBody promises. */
  mediaBody: Blob = new Blob([]);
  mediaError: Error | undefined;
  startClientError: Error | undefined;
  /** What searchUserDirectory returns for listMembers — the homeserver's user directory page. */
  directoryResults: { user_id: string; display_name?: string }[] = [];
  directoryLimited = false;
  /** Per-user presence the stub serves getPresence with; users absent from it get a rejection. */
  readonly presenceByUser = new Map<string, { presence?: string; last_active_ago?: number }>();
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

  /** The rooms the fake homeserver has accepted this account into (#192). */
  readonly joinedRooms = new Set<string>();
  readonly joinCalls: string[] = [];
  readonly leaveCalls: string[] = [];
  readonly inviteCalls: { roomId: string; userId: string }[] = [];
  leaveError: Error | undefined;

  async invite(roomId: string, userId: string): Promise<void> {
    this.inviteCalls.push({ roomId, userId });
  }

  async joinRoom(roomId: string): Promise<void> {
    this.joinCalls.push(roomId);
    this.joinedRooms.add(roomId);
  }

  async leave(roomId: string): Promise<void> {
    if (this.leaveError) {
      const error = this.leaveError;
      this.leaveError = undefined;
      throw error;
    }
    this.leaveCalls.push(roomId);
    this.joinedRooms.delete(roomId);
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  sendMessageEventIdSuffix = 0;

  async sendMessage(roomId: string, content: unknown): Promise<{ event_id: string }> {
    this.sentMessages.push({ roomId, content });
    this.sendMessageEventIdSuffix += 1;
    return { event_id: `$sent-${this.sendMessageEventIdSuffix}` };
  }

  async setPresence(): Promise<unknown> {
    this.presenceReports += 1;
    return {};
  }

  async searchUserDirectory(): Promise<{ results: { user_id: string; display_name?: string }[]; limited: boolean }> {
    this.directorySearches += 1;
    return { results: this.directoryResults, limited: this.directoryLimited };
  }

  /** Authenticated media download (MSC3916) — the SDK's httpApi surface the adapter rides (#190). */
  authedRequest(method: unknown, path: string, _queryParams: unknown, body: unknown, opts: Record<string, unknown>): Promise<unknown> {
    this.authedRequests.push({ method, path, opts });
    this.authedBodies.push(body);
    if (this.mediaError) {
      return Promise.reject(this.mediaError);
    }
    return Promise.resolve(this.mediaBody);
  }

  readonly http = { authedRequest: this.authedRequest.bind(this) };

  async getPresence(userId: string): Promise<{ presence?: string; last_active_ago?: number }> {
    this.presenceLookups += 1;
    this.presenceInFlight += 1;
    this.maxPresenceInFlight = Math.max(this.maxPresenceInFlight, this.presenceInFlight);
    // A real presence request takes a tick; the await is what makes the
    // fan-out's concurrency observable.
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    this.presenceInFlight -= 1;
    const status = this.presenceByUser.get(userId);
    if (!status) {
      throw new Error(`fake: no presence for ${userId}`);
    }
    return status;
  }
}

let client: StubMatrixClient;

vi.mock("matrix-js-sdk", () => ({
  // The subset of the SDK's surface the adapter destructures; the string
  // values match the real enums, and the tests emit through these same
  // mocked constants so there is no literal drift between the two sides.
  ClientEvent: { Sync: "sync" },
  RoomEvent: { Timeline: "Room.timeline", MyMembership: "Room.myMembership" },
  EventType: { RoomMessage: "m.room.message", RoomName: "m.room.name" },
  Method: { Get: "GET" },
  MsgType: { Text: "m.text", File: "m.file", Image: "m.image" },
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
    backlog: { maxAgeMs: 3_600_000, maxAnswersPerMinute: 30 },
    ackAfterMs: 2000,
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
  ts?: number;
  /** Extra content keys (url, filename, info, …) — how file messages carry their facts. */
  content?: Record<string, unknown>;
}

function timelineEvent(init: TimelineEventInit = {}) {
  return {
    getType: () => init.type ?? "m.room.message",
    getContent: () => ({ msgtype: init.msgtype ?? "m.text", body: init.body ?? "What did Alice decide?", ...init.content }),
    getSender: () => (init.senderMissing ? undefined : (init.senderId ?? "@bob:workspace")),
    getId: () => init.eventId ?? "$e1",
    getRoomId: () => init.roomId ?? "!room:workspace",
    getTs: () => init.ts ?? 1_758_000_000_000,
  };
}

/** A file message on the wire: msgtype m.file/m.image, url, optional filename and info. */
function fileTimelineEvent(init: { eventId: string; senderId?: string; url: string; filename?: string; mimetype?: string; size?: number; msgtype?: string }) {
  return timelineEvent({
    eventId: init.eventId,
    senderId: init.senderId,
    msgtype: init.msgtype ?? "m.file",
    body: init.filename ?? "file.txt",
    content: {
      url: init.url,
      ...(init.filename !== undefined ? { filename: init.filename } : {}),
      info: { ...(init.mimetype !== undefined ? { mimetype: init.mimetype } : {}), ...(init.size !== undefined ? { size: init.size } : {}) },
    },
  });
}

function room(members: readonly string[] = ["@duo-alice:workspace", "@bob:workspace"], liveEvents: readonly object[] = []) {
  return {
    roomId: "!room:workspace",
    getJoinedMembers: () => members.map((userId) => ({ userId })),
    getLiveTimeline: () => ({ getEvents: () => [...liveEvents] }),
  };
}

/**
 * A room as the SDK hands it over on `Room.myMembership === "invite"`: the
 * membership state events the stripped invite slice carries, and nothing
 * more — no joined-member roster beyond what the heroes make visible.
 */
function inviteRoom(
  init: { roomId?: string; inviterId?: string | null; name?: string | null; memberships?: string[]; inviteContent?: Record<string, unknown> } = {},
) {
  const roomId = init.roomId ?? "!invited:workspace";
  const memberships = init.memberships ?? ["invite", "join", "join"];
  const stateEvents: Record<string, { getContent: () => unknown; getSender: () => string | undefined }[]> = {};
  if (init.name !== null) {
    stateEvents["m.room.name"] = [{ getContent: () => (init.name === null ? {} : { name: init.name }), getSender: () => "@bob:workspace" }];
  }
  return {
    roomId,
    currentState: { getStateEvents: (type: string, key: string) => stateEvents[type]?.[Number(key)] ?? null },
    getMember: (userId: string) =>
      init.inviterId === null
        ? undefined
        : {
            userId,
            events: {
              member: { getSender: () => init.inviterId ?? "@bob:workspace", getContent: () => ({ membership: "invite", ...init.inviteContent }) },
            },
          },
    getMembers: () => memberships.map((membership, index) => ({ membership, userId: `@member${index}:workspace` })),
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

  it("refuses member reads after stop() — a read rides the held connection or refuses, never the torn-down client", async () => {
    client.directoryResults = [{ user_id: "@alice:workspace", display_name: "Alice" }];
    const transport = createMatrixTransport(settings());
    await transport.stop();
    await expect(transport.listMembers()).rejects.toThrow(/stopped — the member read needs the held connection/);
    await expect(transport.listMemberIdentities()).rejects.toThrow(/stopped — the member read needs the held connection/);
    expect(client.directorySearches).toBe(0);
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
  it("forwards a text room message normalized to the seam's shape, live and backlog-replayed alike — carrying the homeserver's timestamp for #189's backlog policy", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    // Backlog (replayed by the initial sync — the held-not-lost path), then live.
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$held", ts: 1_758_000_000_000 }), room(), true, false, {});
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$live", ts: 1_758_000_004_000 }), room(), false, false, {});
    expect(messages).toEqual([
      {
        eventId: "$held",
        roomId: "!room:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide?",
        originServerTs: 1_758_000_000_000,
        joinedMemberIds: ["@duo-alice:workspace", "@bob:workspace"],
      },
      {
        eventId: "$live",
        roomId: "!room:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide?",
        originServerTs: 1_758_000_004_000,
        joinedMemberIds: ["@duo-alice:workspace", "@bob:workspace"],
      },
    ]);
  });

  it("unwraps an edited message's m.new_content.body — the '* ' fallback marker never reaches a draft", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    // A person edits their question: the SDK hands the adapter the
    // replacement event, whose top-level body is the "* " fallback marker.
    client.emit(
      RoomEvent.Timeline,
      {
        ...timelineEvent({ eventId: "$edit" }),
        getContent: () => ({
          msgtype: "m.text",
          body: "* What did Alice decide about the renewal?",
          "m.new_content": { msgtype: "m.text", body: "What did Alice decide about the renewal?" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$q1" },
        }),
      },
      room(),
      false,
      false,
      {},
    );
    expect(messages).toEqual([
      {
        eventId: "$edit",
        roomId: "!room:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide about the renewal?",
        originServerTs: 1_758_000_000_000,
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
  it("sendAnswer posts exactly the built content to the question's room, as the duo's own m.text, and resolves the sent event's id (W-S4-3)", async () => {
    const transport = createMatrixTransport(settings());
    const sent = await transport.sendAnswer("!room:workspace", { msgtype: "m.text", body: "Approved on 2026-08-14." });
    expect(client.sentMessages).toEqual([
      { roomId: "!room:workspace", content: { msgtype: "m.text", body: "Approved on 2026-08-14." } },
    ]);
    expect(sent).toEqual({ eventId: "$sent-1" });
  });

  it("markAlive reports online presence to the homeserver", async () => {
    const transport = createMatrixTransport(settings());
    await transport.markAlive();
    expect(client.presenceReports).toBe(1);
  });

  it("sendCard posts exactly the builder's content, verbatim, and resolves the sent event's id (W-S4-3)", async () => {
    const transport = createMatrixTransport(settings());
    const content = {
      msgtype: "duo.card" as const,
      body: "Looking into this — I'll update this message.",
      "m.mentions": {},
      "duo.card": { v: 1 as const, rev: 1, card_id: "c_01TASK", kind: "task" as const, state: "acknowledged", requester: "@alice:workspace", title: "Checking" },
    };
    const sent = await transport.sendCard("!room:workspace", content);
    expect(client.sentMessages).toEqual([{ roomId: "!room:workspace", content }]);
    expect(sent).toEqual({ eventId: "$sent-1" });
  });

  it("editCard sends exactly the builder's edit content, verbatim, against the card's own event id", async () => {
    const transport = createMatrixTransport(settings());
    const edit = {
      msgtype: "duo.card" as const,
      body: "* Looking into this — I'll update this message.",
      "m.new_content": {
        msgtype: "duo.card" as const,
        body: "Looking into this — I'll update this message.",
        "m.mentions": {},
        "duo.card": { v: 1 as const, rev: 2, card_id: "c_01TASK", kind: "task" as const, state: "working", requester: "@alice:workspace", title: "Checking" },
      },
      "m.relates_to": { rel_type: "m.replace" as const, event_id: "$card1" },
    };
    await transport.editCard("!room:workspace", "$card1", edit);
    expect(client.sentMessages).toEqual([{ roomId: "!room:workspace", content: edit }]);
  });
});

describe("Matrix adapter — duo.card.response, a non-message custom event (W-S4-3, cards.md §2/§6)", () => {
  function cardResponseEvent(init: {
    eventId?: string;
    roomId?: string;
    senderId?: string;
    senderMissing?: boolean;
    ts?: number;
    content?: Record<string, unknown>;
  } = {}) {
    return {
      getType: () => "duo.card.response",
      getContent: () =>
        init.content ?? {
          "m.relates_to": { rel_type: "m.reference", event_id: "$card1" },
          "duo.card.response": { v: 1, card_id: "c_01TASK", action_id: "o1", values: {} },
        },
      getSender: () => (init.senderMissing ? undefined : (init.senderId ?? "@alice:workspace")),
      getId: () => init.eventId ?? "$resp1",
      getRoomId: () => init.roomId ?? "!room:workspace",
      getTs: () => init.ts ?? 1_758_000_000_000,
    };
  }

  it("delivers a live duo.card.response, parsed into the seam's shape", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    client.emit(RoomEvent.Timeline, cardResponseEvent(), room(), false, false, {});
    expect(responses).toEqual([
      {
        eventId: "$resp1",
        roomId: "!room:workspace",
        senderId: "@alice:workspace",
        cardEventId: "$card1",
        cardId: "c_01TASK",
        actionId: "o1",
        values: {},
        originServerTs: 1_758_000_000_000,
      },
    ]);
  });

  it("delivers a sync-replayed duo.card.response the same as a live one — held-not-lost applies to responses too", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    // `removed: false` either way — replayed-by-backlog events arrive with
    // the same flag live ones do (see the text-message listener above);
    // this test exists so a future adapter change that started gating on a
    // "replayed" flag that doesn't exist on this event would be caught.
    client.emit(RoomEvent.Timeline, cardResponseEvent({ eventId: "$resp2" }), room(), true, false, {});
    expect(responses).toHaveLength(1);
    expect((responses[0] as { eventId: string }).eventId).toBe("$resp2");
  });

  it("drops a response with an unknown v, never throwing", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    client.emit(
      RoomEvent.Timeline,
      cardResponseEvent({ content: { "m.relates_to": { rel_type: "m.reference", event_id: "$card1" }, "duo.card.response": { v: 2, card_id: "c1", action_id: "o1", values: {} } } }),
      room(),
      false,
      false,
      {},
    );
    expect(responses).toEqual([]);
  });

  it("drops a response missing card_id, action_id, or m.relates_to.event_id, never throwing", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    const malformed = [
      { "m.relates_to": { rel_type: "m.reference", event_id: "$card1" }, "duo.card.response": { v: 1, card_id: "", action_id: "o1", values: {} } },
      { "m.relates_to": { rel_type: "m.reference", event_id: "$card1" }, "duo.card.response": { v: 1, card_id: "c1", action_id: "", values: {} } },
      { "m.relates_to": { rel_type: "m.reference" }, "duo.card.response": { v: 1, card_id: "c1", action_id: "o1", values: {} } },
      { "duo.card.response": { v: 1, card_id: "c1", action_id: "o1", values: {} } },
      { "m.relates_to": { rel_type: "m.reference", event_id: "$card1" } },
    ];
    for (const content of malformed) {
      client.emit(RoomEvent.Timeline, cardResponseEvent({ content }), room(), false, false, {});
    }
    expect(responses).toEqual([]);
  });

  it("drops a response whose values is not a plain object, never throwing", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    client.emit(
      RoomEvent.Timeline,
      cardResponseEvent({ content: { "m.relates_to": { rel_type: "m.reference", event_id: "$card1" }, "duo.card.response": { v: 1, card_id: "c1", action_id: "o1", values: "not-an-object" } } }),
      room(),
      false,
      false,
      {},
    );
    expect(responses).toEqual([]);
  });

  it("ignores the duo's own echo — a response whose sender is this account's own user id", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    client.emit(RoomEvent.Timeline, cardResponseEvent({ senderId: "@duo-alice:workspace" }), room(), false, false, {});
    expect(responses).toEqual([]);
  });

  it("drops a response with no sender at all", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    client.emit(RoomEvent.Timeline, cardResponseEvent({ senderMissing: true }), room(), false, false, {});
    expect(responses).toEqual([]);
  });

  it("never reaches the text-message handlers — a duo.card.response is not an m.room.message", () => {
    const transport = createMatrixTransport(settings());
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));
    client.emit(RoomEvent.Timeline, cardResponseEvent(), room(), false, false, {});
    expect(messages).toEqual([]);
  });

  it("is silent after stop() — a late response delivery never reaches a handler", () => {
    const transport = createMatrixTransport(settings());
    const responses: unknown[] = [];
    transport.onCardResponse((response) => responses.push(response));
    void transport.stop();
    client.emit(RoomEvent.Timeline, cardResponseEvent(), room(), false, false, {});
    expect(responses).toEqual([]);
  });
});

describe("Matrix adapter — listMembers reads the directory the platform decision says the workspace holds (#187 AC1)", () => {
  it("maps the user directory page into seam members: ids, display names, presence per user", async () => {
    client.directoryResults = [
      { user_id: "@alice:workspace", display_name: "Alice" },
      { user_id: "@duo-alice:workspace", display_name: "Alice's duo" },
    ];
    client.presenceByUser.set("@alice:workspace", { presence: "online", last_active_ago: 5000 });
    client.presenceByUser.set("@duo-alice:workspace", { presence: "offline", last_active_ago: 3_600_000 });
    const transport = createMatrixTransport(settings());
    const listing = await transport.listMembers();
    expect(listing).toEqual({
      members: [
        { userId: "@alice:workspace", displayName: "Alice", presence: { online: true, lastActiveAgoMs: 5000 } },
        { userId: "@duo-alice:workspace", displayName: "Alice's duo", presence: { online: false, lastActiveAgoMs: 3_600_000 } },
      ],
      truncated: false,
    });
    expect(client.directorySearches).toBe(1);
  });

  it("falls back to the localpart when the profile has no display name — never an empty name", async () => {
    client.directoryResults = [{ user_id: "@bob:workspace" }, { user_id: "@carol:workspace", display_name: "" }];
    client.presenceByUser.set("@bob:workspace", { presence: "offline" });
    client.presenceByUser.set("@carol:workspace", { presence: "offline" });
    const listing = await createMatrixTransport(settings()).listMembers();
    expect(listing.members.map((member) => member.displayName)).toEqual(["bob", "carol"]);
  });

  it("treats any non-online server presence as offline, and a missing last_active_ago as never seen", async () => {
    client.directoryResults = [{ user_id: "@alice:workspace", display_name: "Alice" }];
    client.presenceByUser.set("@alice:workspace", { presence: "unavailable" });
    expect((await createMatrixTransport(settings()).listMembers()).members[0]!.presence).toEqual({
      online: false,
      lastActiveAgoMs: null,
    });
  });

  it("fails soft per user: a presence the server will not state is offline-never-seen, not a failed read", async () => {
    client.directoryResults = [
      { user_id: "@alice:workspace", display_name: "Alice" },
      { user_id: "@bob:workspace", display_name: "Bob" },
    ];
    client.presenceByUser.set("@alice:workspace", { presence: "online" });
    // @bob has no presence entry — the stub rejects, like a server refusing the query.
    const listing = await createMatrixTransport(settings()).listMembers();
    expect(listing.members.map((member) => member.presence)).toEqual([
      { online: true, lastActiveAgoMs: null },
      { online: false, lastActiveAgoMs: null },
    ]);
  });

  it("carries the server's truncation signal as the listing's truncated flag", async () => {
    client.directoryResults = [{ user_id: "@alice:workspace", display_name: "Alice" }];
    client.directoryLimited = true;
    client.presenceByUser.set("@alice:workspace", { presence: "online" });
    expect((await createMatrixTransport(settings()).listMembers()).truncated).toBe(true);
  });

  it("paces the per-user presence fan-out — bounded in flight, order preserved", async () => {
    for (let i = 0; i < 25; i += 1) {
      const userId = `@user${i}:workspace`;
      client.directoryResults.push({ user_id: userId, display_name: `User ${i}` });
      client.presenceByUser.set(userId, { presence: i % 2 === 0 ? "online" : "offline", last_active_ago: 1000 });
    }
    const listing = await createMatrixTransport(settings()).listMembers();
    // The server's order survives the chunked fan-out, all 25 presences
    // were read, and the concurrency the homeserver saw stayed bounded —
    // a burst of 25 simultaneous requests is what this pins out.
    expect(listing.members.map((member) => member.userId)).toEqual(client.directoryResults.map((result) => result.user_id));
    expect(client.presenceLookups).toBe(25);
    expect(client.maxPresenceInFlight).toBeGreaterThanOrEqual(2);
    expect(client.maxPresenceInFlight).toBeLessThanOrEqual(10);
  });
});

describe("Matrix adapter — listMemberIdentities is the member read without the presence fan-out (#187 AC3's feed)", () => {
  it("maps the directory page to identity facts and never asks for a single presence", async () => {
    client.directoryResults = [
      { user_id: "@alice:workspace", display_name: "Alice" },
      { user_id: "@duo-alice:workspace", display_name: "Alice's duo" },
      { user_id: "@bob:workspace" },
    ];
    const listing = await createMatrixTransport(settings()).listMemberIdentities();
    expect(listing).toEqual({
      members: [
        { userId: "@alice:workspace", displayName: "Alice" },
        { userId: "@duo-alice:workspace", displayName: "Alice's duo" },
        // The localpart fallback, same as the full read.
        { userId: "@bob:workspace", displayName: "bob" },
      ],
      truncated: false,
    });
    expect(client.directorySearches).toBe(1);
    expect(client.presenceLookups).toBe(0);
  });

  it("carries the server's truncation signal exactly like the full read", async () => {
    client.directoryResults = [{ user_id: "@alice:workspace", display_name: "Alice" }];
    client.directoryLimited = true;
    expect((await createMatrixTransport(settings()).listMemberIdentities()).truncated).toBe(true);
  });
});

describe("Matrix adapter — a rejected token is a distinct, terminal-shaped error (#187, M_UNKNOWN_TOKEN)", () => {  function matrixTokenError(): Error & { errcode: string } {
    const error = new Error("Invalid access token passed.") as Error & { errcode: string };
    error.errcode = "M_UNKNOWN_TOKEN";
    return error;
  }

  it("rejects connect() with WorkspaceTokenRevokedError when sync fails with M_UNKNOWN_TOKEN", async () => {
    const transport = createMatrixTransport(settings());
    const connecting = transport.connect();
    client.emit(ClientEvent.Sync, SyncState.Error, "Syncing", { error: matrixTokenError() });
    await expect(connecting).rejects.toBeInstanceOf(WorkspaceTokenRevokedError);
    await expect(connecting).rejects.toThrow(/M_UNKNOWN_TOKEN.*Invalid access token passed\./s);
  });

  it("rejects connect() with WorkspaceTokenRevokedError when startClient itself fails with M_UNKNOWN_TOKEN", async () => {
    client.startClientError = matrixTokenError();
    await expect(createMatrixTransport(settings()).connect()).rejects.toBeInstanceOf(WorkspaceTokenRevokedError);
  });

  it("keeps every other sync failure a plain error — only a dead credential is terminal", async () => {
    const transport = createMatrixTransport(settings());
    const connecting = transport.connect();
    const notAToken = new Error("synapse is down") as Error & { errcode?: string };
    notAToken.errcode = "M_LIMIT_EXCEEDED";
    client.emit(ClientEvent.Sync, SyncState.Error, "Syncing", { error: notAToken });
    await expect(connecting).rejects.not.toBeInstanceOf(WorkspaceTokenRevokedError);
    await expect(connecting).rejects.toThrow(/workspace sync failed: synapse is down/);
  });
});

describe("Matrix adapter — the invite surface: normalize, never join (#192)", () => {
  it("delivers an invite with the facts the stripped room knows: inviter from the membership event, name from state, joined count from the slice", () => {
    const transport = createMatrixTransport(settings());
    const invites: RoomInvite[] = [];
    transport.onInvite((invite) => invites.push(invite));
    client.emit(RoomEvent.MyMembership, inviteRoom({ inviterId: "@carol:workspace", name: "Launch planning", memberships: ["invite", "join", "join", "leave"] }), "invite", "leave");
    expect(invites).toEqual([
      { roomId: "!invited:workspace", inviterId: "@carol:workspace", name: "Launch planning", joinedMemberCount: 2, reason: null, direct: false },
    ]);
    // The adapter only translated: nothing joined.
    expect(client.joinCalls).toEqual([]);
  });

  it("degrades each missing fact to null instead of inventing it — no inviter event, no name state, empty slice", () => {
    const transport = createMatrixTransport(settings());
    const invites: RoomInvite[] = [];
    transport.onInvite((invite) => invites.push(invite));
    client.emit(RoomEvent.MyMembership, inviteRoom({ inviterId: null, name: null, memberships: ["invite"] }), "invite", undefined);
    expect(invites).toEqual([{ roomId: "!invited:workspace", inviterId: null, name: null, joinedMemberCount: 0, reason: null, direct: false }]);
  });

  it("carries the invite's reason as a preview and its is_direct flag — a colleague's first message to the duo (guangshinhaha/duo#315)", () => {
    const transport = createMatrixTransport(settings());
    const invites: RoomInvite[] = [];
    transport.onInvite((invite) => invites.push(invite));
    client.emit(
      RoomEvent.MyMembership,
      inviteRoom({ inviterId: "@carol:workspace", name: null, memberships: ["invite", "join"], inviteContent: { reason: "  Where is the deploy runbook?\u0007 ", is_direct: true } }),
      "invite",
      undefined,
    );
    expect(invites).toEqual([
      { roomId: "!invited:workspace", inviterId: "@carol:workspace", name: null, joinedMemberCount: 1, reason: "Where is the deploy runbook?", direct: true },
    ]);
  });

  it("ignores every membership change that is not an invite — joins, leaves, bans, knocks are not invitations", () => {
    const transport = createMatrixTransport(settings());
    const invites: RoomInvite[] = [];
    transport.onInvite((invite) => invites.push(invite));
    for (const membership of ["join", "leave", "ban", "knock"]) {
      client.emit(RoomEvent.MyMembership, inviteRoom(), membership, "invite");
    }
    expect(invites).toEqual([]);
  });

  it("is silent after stop() — a late invite delivery never reaches a handler", async () => {
    const transport = createMatrixTransport(settings());
    const invites: RoomInvite[] = [];
    transport.onInvite((invite) => invites.push(invite));
    await transport.stop();
    client.emit(RoomEvent.MyMembership, inviteRoom(), "invite", undefined);
    expect(invites).toEqual([]);
  });
});

describe("Matrix adapter — join and leave are plain membership calls (#192)", () => {
  it("joinRoom asks the client to join and leaves it at that", async () => {
    const transport = createMatrixTransport(settings());
    await transport.joinRoom("!room:workspace");
    expect(client.joinCalls).toEqual(["!room:workspace"]);
    expect(client.joinedRooms.has("!room:workspace")).toBe(true);
  });

  it("leaveRoom asks the client to leave — the same primitive a refusal's invite rejection rides", async () => {
    const transport = createMatrixTransport(settings());
    await transport.leaveRoom("!room:workspace");
    expect(client.leaveCalls).toEqual(["!room:workspace"]);
  });

  it("leaveRoom with a reason rides the spec's leave body — the polite decline a colleague sees (guangshinhaha/duo#315)", async () => {
    const transport = createMatrixTransport(settings());
    await transport.leaveRoom("!room:workspace", "Thanks for reaching out.");
    // Not the SDK's reason-less leave(): the raw spec call, with the reason as its body.
    expect(client.leaveCalls).toEqual([]);
    expect(client.authedRequests.map((request) => request.path)).toEqual(["/rooms/!room%3Aworkspace/leave"]);
    expect(client.authedBodies).toEqual([{ reason: "Thanks for reaching out." }]);
  });

  it("inviteToRoom is a plain invite of exactly the user named (guangshinhaha/duo#314)", async () => {
    const transport = createMatrixTransport(settings());
    await transport.inviteToRoom("!room:workspace", "@alice:workspace");
    expect(client.inviteCalls).toEqual([{ roomId: "!room:workspace", userId: "@alice:workspace" }]);
    expect(client.joinCalls).toEqual([]);
  });

  it("propagates the homeserver's refusal of either, unchanged — the service owns the retry story", async () => {
    client.leaveError = new Error("M_FORBIDDEN: you are not in this room");
    const transport = createMatrixTransport(settings());
    await expect(transport.leaveRoom("!room:workspace")).rejects.toThrow(/M_FORBIDDEN/);
    expect(client.leaveCalls).toEqual([]);
  });
});

describe("Matrix adapter — the files a question rode with (#190's association walk)", () => {
  it("associates the asker's contiguous run of file messages immediately preceding their question, in share order", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    const question = timelineEvent({ eventId: "$q", senderId: "@bob:workspace", body: "what do these say?" });
    client.emit(
      RoomEvent.Timeline,
      question,
      room(["@duo-alice:workspace", "@bob:workspace"], [
        timelineEvent({ eventId: "$old", senderId: "@carol:workspace", body: "unrelated" }),
        fileTimelineEvent({ eventId: "$f1", url: "mxc://workspace/f1", filename: "a.txt", mimetype: "text/plain", size: 3 }),
        fileTimelineEvent({ eventId: "$f2", url: "mxc://workspace/f2", filename: "b.md", mimetype: "text/markdown" }),
        question,
      ]),
      false,
      false,
      {},
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.attachments).toEqual([
      { reference: "mxc://workspace/f1", name: "a.txt", mimeType: "text/plain", size: 3 },
      { reference: "mxc://workspace/f2", name: "b.md", mimeType: "text/markdown", size: null },
    ]);
  });

  it("reads an image association too — the adapter carries it; the door is where images are refused", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    const question = timelineEvent({ eventId: "$q", body: "look at this" });
    client.emit(
      RoomEvent.Timeline,
      question,
      room(["@duo-alice:workspace", "@bob:workspace"], [
        fileTimelineEvent({ eventId: "$img", url: "mxc://workspace/i1", msgtype: "m.image", mimetype: "image/png" }),
        question,
      ]),
      false,
      false,
      {},
    );
    expect(messages[0]!.attachments).toEqual([{ reference: "mxc://workspace/i1", name: "file.txt", mimeType: "image/png", size: null }]);
  });

  it("ends the run at anyone else's message, the asker's own text, or any other event — older files don't ground a later question", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    const question = timelineEvent({ eventId: "$q", body: "what do these say?" });
    client.emit(
      RoomEvent.Timeline,
      question,
      room(["@duo-alice:workspace", "@bob:workspace", "@carol:workspace"], [
        fileTimelineEvent({ eventId: "$stale", url: "mxc://workspace/stale", filename: "old.txt" }),
        timelineEvent({ eventId: "$chatter", senderId: "@carol:workspace", body: "meanwhile" }),
        question,
      ]),
      false,
      false,
      {},
    );
    // No attachments key at all — the pre-#190 candidate shape.
    expect(messages[0]!.attachments).toBeUndefined();
  });

  it("contributes nothing when the file run belongs to a different sender than the question", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    const question = timelineEvent({ eventId: "$q", senderId: "@bob:workspace", body: "what do these say?" });
    client.emit(
      RoomEvent.Timeline,
      question,
      room(["@duo-alice:workspace", "@bob:workspace", "@carol:workspace"], [
        fileTimelineEvent({ eventId: "$carols", senderId: "@carol:workspace", url: "mxc://workspace/c1", filename: "c.txt" }),
        question,
      ]),
      false,
      false,
      {},
    );
    expect(messages[0]!.attachments).toBeUndefined();
  });

  it("associates nothing when the question is not on the live timeline (a thread reply) or the run is empty — the honest nothing", () => {
    const transport = createMatrixTransport(settings());
    const messages: WorkspaceCandidateMessage[] = [];
    transport.onMessage((message) => messages.push(message));
    // A thread reply: the SDK hands the adapter the event, but it lives in
    // the thread's timeline, not the room's live one.
    client.emit(RoomEvent.Timeline, timelineEvent({ eventId: "$thread" }), room(), false, false, {});
    // And a plain question with no files before it.
    client.emit(
      RoomEvent.Timeline,
      timelineEvent({ eventId: "$plain" }),
      room(["@duo-alice:workspace", "@bob:workspace"], [timelineEvent({ eventId: "$older", senderId: "@bob:workspace", body: "older text" }), timelineEvent({ eventId: "$plain" })]),
      false,
      false,
      {},
    );
    expect(messages.map((message) => message.eventId)).toEqual(["$thread", "$plain"]);
    expect(messages[0]!.attachments).toBeUndefined();
    expect(messages[1]!.attachments).toBeUndefined();
    // The no-attachments message carries no attachments key at all — the
    // pre-#190 candidate shape, byte-identical.
    expect("attachments" in messages[0]!).toBe(false);
  });
});

describe("Matrix adapter — fetchFile, the daemon's one file dereference (#190)", () => {
  it("issues one authenticated media download with a Range cut at the bound, and decodes the raw body", async () => {
    client.mediaBody = new Blob(["the launch date is March 3rd"], { type: "text/plain" });
    const transport = createMatrixTransport(settings());
    const body = await transport.fetchFile("mxc://workspace/abc123", { maxBytes: 32 * 1024 });
    expect(new TextDecoder().decode(body.bytes)).toBe("the launch date is March 3rd");
    expect(body.exceededMaxBytes).toBe(false);
    expect(client.authedRequests).toEqual([
      {
        method: "GET",
        path: "/_matrix/client/v1/media/download/workspace/abc123",
        opts: {
          prefix: "",
          rawResponseBody: true,
          // Inclusive Range: 0..maxBytes fetches at most maxBytes+1 bytes —
          // one past the cap is the evidence that the body exceeds it.
          headers: { Range: "bytes=0-32768" },
        },
      },
    ]);
  });

  it("flags a body that came back longer than the bound — the Range evidence the door refuses on", async () => {
    client.mediaBody = new Blob([new Uint8Array(40 * 1024)]);
    const transport = createMatrixTransport(settings());
    const body = await transport.fetchFile("mxc://workspace/big", { maxBytes: 32 * 1024 });
    expect(body.bytes.byteLength).toBeGreaterThan(32 * 1024);
    expect(body.exceededMaxBytes).toBe(true);
  });

  it("refuses a reference that is not an mxc URI, before any request is issued", async () => {
    const transport = createMatrixTransport(settings());
    await expect(transport.fetchFile("https://evil.example/f1", { maxBytes: 32 * 1024 })).rejects.toThrow(/not an mxc URI/);
    expect(client.authedRequests).toEqual([]);
  });

  it("refuses after stop() — the file read rides the held connection or refuses, like every other read", async () => {
    const transport = createMatrixTransport(settings());
    await transport.stop();
    await expect(transport.fetchFile("mxc://workspace/abc123", { maxBytes: 32 * 1024 })).rejects.toThrow(
      /stopped — the file read needs the held connection/,
    );
    expect(client.authedRequests).toEqual([]);
  });
});
