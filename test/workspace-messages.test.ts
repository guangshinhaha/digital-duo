import { describe, expect, it } from "vitest";
import {
  authorFromUserId,
  compareMessages,
  conversationsFromSync,
  invitesFromSync,
  isDuoAuthor,
  messagesFromTimeline,
  pageMessages,
  readPositionsFromEphemeral,
  type Message,
  type RawMatrixEvent,
  type RawSyncInviteRoom,
  type RawSyncRoom,
  type RawSyncRooms,
} from "../src/workspace/messages.js";

/**
 * #189's contract tests, fed by fixtures shaped exactly like the JSON a
 * Synapse `/sync` returns (client-event format: type/state_key/sender/
 * event_id/origin_server_ts/content). The parsing layer is the one place
 * Matrix shapes are understood, so these fixtures are the wire reality the
 * whole contract is pinned against — when the homeserver or SDK changes a
 * shape, this file is where it shows up first, not production rendering.
 */

const ALICE = "@alice:workspace";
const DUO_ALICE = "@duo-alice:workspace";
const BOB = "@bob:workspace";
const TS = 1_758_000_000_000;

function ts(offsetMs: number): number {
  return TS + offsetMs;
}

function iso(offsetMs: number): string {
  return new Date(ts(offsetMs)).toISOString();
}

function createEvent(content: Record<string, unknown> = {}, offsetMs = 0): RawMatrixEvent {
  return { type: "m.room.create", state_key: "", sender: ALICE, event_id: `$create:${offsetMs}`, origin_server_ts: ts(offsetMs), content };
}

function memberEvent(userId: string, membership: string, offsetMs: number): RawMatrixEvent {
  return {
    type: "m.room.member",
    state_key: userId,
    sender: ALICE,
    event_id: `$member-${userId}:${offsetMs}`,
    origin_server_ts: ts(offsetMs),
    content: { membership },
  };
}

function nameEvent(name: string, offsetMs: number): RawMatrixEvent {
  return { type: "m.room.name", state_key: "", sender: ALICE, event_id: `$name:${offsetMs}`, origin_server_ts: ts(offsetMs), content: { name } };
}

function textEvent(init: { id: string; sender: string; body: string; at: number; content?: Record<string, unknown> }): RawMatrixEvent {
  return {
    type: "m.room.message",
    sender: init.sender,
    event_id: init.id,
    origin_server_ts: init.at,
    content: { msgtype: "m.text", body: init.body, ...init.content },
  };
}

describe("authorFromUserId — duo authorship is structural (record §6, #189 AC 'a duo's authorship is structural')", () => {
  it("derives the duo kind from the @duo- localpart convention, and only from it", () => {
    expect(authorFromUserId(DUO_ALICE)).toEqual({ kind: "duo", userId: DUO_ALICE });
    expect(authorFromUserId("@duo-bob:other-server")).toEqual({ kind: "duo", userId: "@duo-bob:other-server" });
    expect(authorFromUserId(ALICE)).toEqual({ kind: "person", userId: ALICE });
    expect(authorFromUserId(BOB)).toEqual({ kind: "person", userId: BOB });
    // The convention is @duo-<owner> — a bare @duo localpart is not it.
    expect(authorFromUserId("@duo:workspace")).toEqual({ kind: "person", userId: "@duo:workspace" });
    // A localpart that merely contains "duo" elsewhere is a person.
    expect(authorFromUserId("@aliceduo:workspace")).toEqual({ kind: "person", userId: "@aliceduo:workspace" });
  });

  it("serializes to exactly kind + userId — there is no third field a client could misread as the owner", () => {
    expect(JSON.stringify(authorFromUserId(DUO_ALICE))).toBe('{"kind":"duo","userId":"@duo-alice:workspace"}');
    expect(JSON.stringify(authorFromUserId(ALICE))).toBe('{"kind":"person","userId":"@alice:workspace"}');
    expect(Object.keys(authorFromUserId(DUO_ALICE)).sort()).toEqual(["kind", "userId"]);
  });

  it("cannot render a duo message as its owner even by misreading the field — the owner's user id is simply not there", () => {
    const message = messagesFromTimeline("!dm:workspace", [
      textEvent({ id: "$a1", sender: DUO_ALICE, body: "Approved on 2026-08-14.", at: ts(0) }),
    ])[0]!;
    expect(message.author.kind).toBe("duo");
    expect(isDuoAuthor(message.author)).toBe(true);
    // The duo's own id is the only identity on the message. The owner's
    // person id (@alice:workspace) appears nowhere in the serialized
    // message — rendering this as Alice's would require inventing her.
    expect(message.author.userId).toBe(DUO_ALICE);
    expect(JSON.stringify(message)).not.toContain(ALICE);
  });

  it("narrows exhaustively on the kind — a person message has no duo reading and vice versa", () => {
    const person = messagesFromTimeline("!dm:workspace", [textEvent({ id: "$p", sender: BOB, body: "hi", at: ts(0) })])[0]!;
    const duo = messagesFromTimeline("!dm:workspace", [textEvent({ id: "$d", sender: DUO_ALICE, body: "hi", at: ts(0) })])[0]!;
    expect(isDuoAuthor(person.author)).toBe(false);
    expect(isDuoAuthor(duo.author)).toBe(true);
    // The kinds are disjoint discriminators: no shape satisfies both.
    expect(person.author.kind).not.toBe(duo.author.kind);
  });
});

describe("conversationsFromSync — conversations exist as objects, with membership (#189 AC 'conversations exist as objects')", () => {
  const dmRoom: RawSyncRoom = {
    state: {
      events: [
        createEvent(),
        memberEvent(ALICE, "join", 10),
        memberEvent(DUO_ALICE, "join", 11),
      ],
    },
    timeline: {
      events: [
        textEvent({ id: "$q1", sender: ALICE, body: "What did Alice decide?", at: ts(1000) }),
        textEvent({ id: "$a1", sender: DUO_ALICE, body: "Approved on 2026-08-14.", at: ts(2000) }),
      ],
    },
    ephemeral: {
      events: [
        {
          type: "m.receipt",
          content: {
            "$a1": { "m.read": { [ALICE]: { ts: ts(3000) } } },
            "$q1": { "m.read": { [DUO_ALICE]: { ts: ts(2500) } } },
          },
        },
      ],
    },
  };

  const channelRoom: RawSyncRoom = {
    state: {
      events: [
        createEvent({ type: "m.channel", room_version: "10" }),
        memberEvent(ALICE, "join", 10),
        memberEvent(BOB, "join", 12),
        memberEvent(DUO_ALICE, "join", 13),
        nameEvent("announcements", 14),
      ],
    },
    timeline: { events: [textEvent({ id: "$c1", sender: ALICE, body: "All-hands moved to 15:00.", at: ts(5000) })] },
  };

  const groupRoom: RawSyncRoom = {
    state: {
      events: [
        createEvent(),
        memberEvent(ALICE, "join", 10),
        memberEvent(BOB, "join", 12),
        memberEvent("@carol:workspace", "join", 13),
        memberEvent("@dana:workspace", "leave", 14),
      ],
    },
    timeline: { events: [] },
  };

  const sync: RawSyncRooms = { join: { "!group:workspace": groupRoom, "!dm:workspace": dmRoom, "!channel:workspace": channelRoom } };

  it("lists direct, group and channel conversations — room-id order, kinds by the stated rules", () => {
    const conversations = conversationsFromSync(sync);
    expect(conversations.map((conversation) => [conversation.id, conversation.kind])).toEqual([
      ["!channel:workspace", "channel"],
      ["!dm:workspace", "direct"],
      ["!group:workspace", "group"],
    ]);
  });

  it("returns membership with structural author kinds — a duo member sits alongside people, as its own kind", () => {
    const channel = conversationsFromSync(sync).find((conversation) => conversation.id === "!channel:workspace")!;
    const byUser = new Map(channel.members.map((member) => [member.userId, member]));
    expect(byUser.get(ALICE)).toEqual({ userId: ALICE, author: { kind: "person", userId: ALICE }, membership: "join" });
    expect(byUser.get(DUO_ALICE)).toEqual({ userId: DUO_ALICE, author: { kind: "duo", userId: DUO_ALICE }, membership: "join" });
    expect(channel.members.filter((member) => member.author.kind === "duo")).toHaveLength(1);
    expect(channel.members.filter((member) => member.author.kind === "person")).toHaveLength(2);
  });

  it("carries membership state, not just presence — a left member is listed as left", () => {
    const group = conversationsFromSync(sync).find((conversation) => conversation.id === "!group:workspace")!;
    expect(group.members.find((member) => member.userId === "@dana:workspace")?.membership).toBe("leave");
  });

  it("takes the title from m.room.name, and null when the room never got one (direct rooms usually don't)", () => {
    const conversations = conversationsFromSync(sync);
    expect(conversations.find((conversation) => conversation.id === "!channel:workspace")?.title).toBe("announcements");
    expect(conversations.find((conversation) => conversation.id === "!dm:workspace")?.title).toBeNull();
  });

  it("stamps lastActivityAt from the newest timeline event", () => {
    const conversations = conversationsFromSync(sync);
    expect(conversations.find((conversation) => conversation.id === "!dm:workspace")?.lastActivityAt).toBe(iso(2000));
    expect(conversations.find((conversation) => conversation.id === "!group:workspace")?.lastActivityAt).toBeNull();
  });

  it("reads per-person-per-conversation read state from receipts — latest per member, consistent because the homeserver records it", () => {
    const dm = conversationsFromSync(sync).find((conversation) => conversation.id === "!dm:workspace")!;
    expect(dm.readPositions).toEqual([
      { userId: ALICE, eventId: "$a1", readAt: iso(3000) },
      { userId: DUO_ALICE, eventId: "$q1", readAt: iso(2500) },
    ]);
  });

  it("trusts membership over the is_direct flag — a flagged room that grew members is a group, not a mislabeled direct", () => {
    const room: RawSyncRoom = {
      state: { events: [createEvent({ is_direct: true }), memberEvent(ALICE, "join", 10), memberEvent(BOB, "join", 11), memberEvent(DUO_ALICE, "join", 12)] },
    };
    expect(conversationsFromSync({ join: { "!grown:workspace": room } })[0]!.kind).toBe("group");
  });

  it("derives the kind from member count alone when the create event is outside the state window — degrade, never crash", () => {
    const room: RawSyncRoom = { state: { events: [memberEvent(ALICE, "join", 10), memberEvent(DUO_ALICE, "join", 11)] } };
    expect(conversationsFromSync({ join: { "!nocreate:workspace": room } })[0]!.kind).toBe("direct");
  });

  it("uses the latest membership line per member — state folds forward", () => {
    const room: RawSyncRoom = {
      state: { events: [createEvent(), memberEvent(BOB, "join", 10), memberEvent(BOB, "ban", 20), memberEvent(ALICE, "join", 11), memberEvent(DUO_ALICE, "join", 12)] },
    };
    const conversation = conversationsFromSync({ join: { "!folded:workspace": room } })[0]!;
    expect(conversation.members.find((member) => member.userId === BOB)?.membership).toBe("ban");
    // Alice+duo joined, Bob banned: two JOINED members is still direct by
    // the stated rule (joined count, not member count).
    expect(conversation.kind).toBe("direct");
  });

  it("folds state events that arrived inside the timeline — a room whose whole life the sync window covers still gets its kind, members and name", () => {
    // Every room on the initial sync of a fresh account looks like this:
    // no state block at all, the create/join/name lines inside timeline.
    const room: RawSyncRoom = {
      timeline: {
        events: [
          createEvent({}, 1),
          memberEvent(ALICE, "join", 10),
          memberEvent(DUO_ALICE, "join", 11),
          nameEvent("late name", 20),
          textEvent({ id: "$q1", sender: ALICE, body: "hi", at: ts(1000) }),
        ],
      },
    };
    const conversation = conversationsFromSync({ join: { "!fresh:workspace": room } })[0]!;
    expect(conversation.kind).toBe("direct");
    expect(conversation.title).toBe("late name");
    expect(conversation.members.map((member) => member.userId)).toEqual([ALICE, DUO_ALICE]);
  });

  it("lets a timeline state line override the state block — /sync orders state before timeline, so the latest line wins", () => {
    const room: RawSyncRoom = {
      state: { events: [createEvent(), memberEvent(ALICE, "join", 10), memberEvent(DUO_ALICE, "join", 11), memberEvent(BOB, "join", 12)] },
      timeline: { events: [memberEvent(BOB, "leave", 500)] },
    };
    const conversation = conversationsFromSync({ join: { "!moved:workspace": room } })[0]!;
    expect(conversation.members.find((member) => member.userId === BOB)?.membership).toBe("leave");
    // Alice+duo joined, Bob gone: still exactly two joined members.
    expect(conversation.kind).toBe("direct");
  });

  it("degrades a state event whose content is not an object — malformed wire never crashes the parser", () => {
    // The Raw* types declare content as a record because well-formed events
    // always carry one; these casts deliver the shapes a broken server or
    // proxy could still produce, which this seam must face at runtime.
    const room: RawSyncRoom = {
      state: {
        events: [
          { type: "m.room.create", state_key: "", sender: ALICE, event_id: "$c", origin_server_ts: ts(0), content: null as unknown as Record<string, unknown> },
          { type: "m.room.member", state_key: BOB, sender: ALICE, event_id: "$m", origin_server_ts: ts(10), content: "not an object" as unknown as Record<string, unknown> },
          { type: "m.room.name", state_key: "", sender: ALICE, event_id: "$n", origin_server_ts: ts(20), content: null as unknown as Record<string, unknown> },
        ],
      },
    };
    const conversation = conversationsFromSync({ join: { "!broken:workspace": room } })[0]!;
    // No channel create, one member floored to leave, no joined members: group, null title.
    expect(conversation.kind).toBe("group");
    expect(conversation.title).toBeNull();
    expect(conversation.members.find((member) => member.userId === BOB)?.membership).toBe("leave");
  });

  it("treats an unknown membership value as leave — the safe floor, never a crash", () => {
    const room: RawSyncRoom = {
      state: { events: [createEvent(), memberEvent(ALICE, "join", 10), memberEvent(BOB, "knock", 11)] },
    };
    expect(conversationsFromSync({ join: { "!odd:workspace": room } })[0]!.members.find((member) => member.userId === BOB)?.membership).toBe("leave");
  });
});

describe("readPositionsFromEphemeral — receipts fold to the newest per user", () => {
  it("keeps each user's newest receipt across receipt events, and ignores non-receipt ephemera", () => {
    const events: RawMatrixEvent[] = [
      { type: "m.typing", content: { user_ids: [BOB] } },
      {
        type: "m.receipt",
        content: {
          "$old": { "m.read": { [BOB]: { ts: ts(1000) } } },
        },
      },
      {
        type: "m.receipt",
        content: {
          "$new": { "m.read": { [BOB]: { ts: ts(9000) }, [ALICE]: { ts: ts(4000) } } },
        },
      },
    ];
    expect(readPositionsFromEphemeral(events)).toEqual([
      { userId: ALICE, eventId: "$new", readAt: iso(4000) },
      { userId: BOB, eventId: "$new", readAt: iso(9000) },
    ]);
  });

  it("skips receipts without a usable ts rather than guessing a time", () => {
    const events: RawMatrixEvent[] = [{ type: "m.receipt", content: { "$e": { "m.read": { [BOB]: {} } } } }];
    expect(readPositionsFromEphemeral(events)).toEqual([]);
  });

  it("skips receipt events whose content is not an object — the wire can be malformed; the parser is not allowed to crash", () => {
    const events: RawMatrixEvent[] = [
      { type: "m.receipt", content: null as unknown as Record<string, unknown> },
      { type: "m.receipt", content: "nope" as unknown as Record<string, unknown> },
      { type: "m.receipt", content: { "$e": { "m.read": { [BOB]: { ts: ts(1000) } } } } },
    ];
    expect(readPositionsFromEphemeral(events)).toEqual([{ userId: BOB, eventId: "$e", readAt: iso(1000) }]);
  });
});

describe("messagesFromTimeline — messages are first-class (#189 AC 'messages are first-class')", () => {
  const timeline: RawMatrixEvent[] = [
    textEvent({ id: "$q1", sender: BOB, body: "What did Alice decide about the vendor?", at: ts(1000) }),
    textEvent({ id: "$a1", sender: DUO_ALICE, body: "Approved on 2026-08-14.", at: ts(2000) }),
  ];

  it("returns each message with author, body, time, edit state, a null thread parent and a null file (#190)", () => {
    expect(messagesFromTimeline("!dm:workspace", timeline)).toEqual([
      {
        id: "$q1",
        conversationId: "!dm:workspace",
        author: { kind: "person", userId: BOB },
        body: "What did Alice decide about the vendor?",
        sentAt: iso(1000),
        edit: { kind: "original" },
        threadParentId: null,
        file: null,
      },
      {
        id: "$a1",
        conversationId: "!dm:workspace",
        author: { kind: "duo", userId: DUO_ALICE },
        body: "Approved on 2026-08-14.",
        sentAt: iso(2000),
        edit: { kind: "original" },
        threadParentId: null,
        file: null,
      },
    ]);
  });

  it("folds a replacement into the message it replaces — the original id, time and author stand, the body and edit state update", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({ id: "$q1", sender: BOB, body: "What did Alice decide?", at: ts(1000) }),
      textEvent({
        id: "$edit1",
        sender: BOB,
        body: "* What did Alice decide about the renewal?",
        at: ts(5000),
        content: {
          "m.new_content": { msgtype: "m.text", body: "What did Alice decide about the renewal?" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$q1" },
        },
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "$q1",
      author: { kind: "person", userId: BOB },
      body: "What did Alice decide about the renewal?",
      sentAt: iso(1000),
      edit: { kind: "edited", editedAt: iso(5000) },
    });
  });

  it("folds the newest replacement when a message was edited twice", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({ id: "$q1", sender: BOB, body: "first", at: ts(1000) }),
      textEvent({
        id: "$edit1",
        sender: BOB,
        body: "* second",
        at: ts(2000),
        content: { "m.new_content": { msgtype: "m.text", body: "second" }, "m.relates_to": { rel_type: "m.replace", event_id: "$q1" } },
      }),
      textEvent({
        id: "$edit2",
        sender: BOB,
        body: "* third",
        at: ts(3000),
        content: { "m.new_content": { msgtype: "m.text", body: "third" }, "m.relates_to": { rel_type: "m.replace", event_id: "$q1" } },
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("third");
    expect(messages[0]!.edit).toEqual({ kind: "edited", editedAt: iso(3000) });
  });

  it("ignores a replacement whose sender is not the original's — the spec's rule, so a crafted event cannot rewrite another member's message", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({ id: "$q1", sender: BOB, body: "What did Alice decide?", at: ts(1000) }),
      textEvent({
        id: "$evil",
        sender: ALICE,
        body: "* What did Alice decide? (never mind)",
        at: ts(2000),
        content: {
          "m.new_content": { msgtype: "m.text", body: "What did Alice decide? (never mind)" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$q1" },
        },
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "$q1", body: "What did Alice decide?", edit: { kind: "original" } });
  });

  it("renders an orphan replacement standalone — the original is outside the parsed slice, as Element does", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({
        id: "$edit",
        sender: BOB,
        body: "* edited from before the window",
        at: ts(2000),
        content: {
          "m.new_content": { msgtype: "m.text", body: "edited from before the window" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$outside" },
        },
      }),
    ]);
    expect(messages).toEqual([
      {
        id: "$edit",
        conversationId: "!dm:workspace",
        author: { kind: "person", userId: BOB },
        body: "edited from before the window",
        sentAt: iso(2000),
        edit: { kind: "original" },
        threadParentId: null,
        file: null,
      },
    ]);
  });

  it("skips an orphan replacement whose m.new_content has no readable body — the '* ' fallback marker is not text", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({
        id: "$editA",
        sender: BOB,
        body: "* ",
        at: ts(2000),
        content: { "m.new_content": { msgtype: "m.text" }, "m.relates_to": { rel_type: "m.replace", event_id: "$outside" } },
      }),
      textEvent({
        id: "$editB",
        sender: BOB,
        body: "* ",
        at: ts(3000),
        content: { "m.new_content": "not an object", "m.relates_to": { rel_type: "m.replace", event_id: "$outside" } },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  it("leaves a message original when its replacement carries no readable body — an edit with nothing to say does not flip edit state", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({ id: "$q1", sender: BOB, body: "What did Alice decide?", at: ts(1000) }),
      textEvent({
        id: "$edit1",
        sender: BOB,
        body: "* What did Alice decide?",
        at: ts(5000),
        content: { "m.new_content": { msgtype: "m.text" }, "m.relates_to": { rel_type: "m.replace", event_id: "$q1" } },
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "$q1", body: "What did Alice decide?", edit: { kind: "original" } });
  });

  it("emits a duplicated event id once — the first copy stands; wire malformity never renders a message twice", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      textEvent({ id: "$q1", sender: BOB, body: "first copy", at: ts(1000) }),
      textEvent({ id: "$q1", sender: BOB, body: "second copy", at: ts(2000) }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("first copy");
  });

  it("carries a thread reply's root as threadParentId, and does NOT thread a rich reply", () => {
    const messages = messagesFromTimeline("!room:workspace", [
      textEvent({ id: "$root", sender: BOB, body: "Starting a thread.", at: ts(1000) }),
      textEvent({
        id: "$reply",
        sender: ALICE,
        body: "> Starting a thread.\n\nin the thread",
        at: ts(2000),
        content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root", "m.in_reply_to": { event_id: "$root" } } },
      }),
      textEvent({
        id: "$rich",
        sender: ALICE,
        body: "> on the timeline\n\na rich reply is not a thread",
        at: ts(3000),
        content: { "m.relates_to": { "m.in_reply_to": { event_id: "$root" } } },
      }),
    ]);
    expect(messages.find((message) => message.id === "$root")?.threadParentId).toBeNull();
    expect(messages.find((message) => message.id === "$reply")?.threadParentId).toBe("$root");
    expect(messages.find((message) => message.id === "$rich")?.threadParentId).toBeNull();
  });

  it("skips what it cannot honestly parse — other msgtypes and event kinds, missing bodies, senders, or timestamps", () => {
    const messages = messagesFromTimeline("!room:workspace", [
      { type: "m.room.message", sender: BOB, event_id: "$notice", origin_server_ts: ts(1000), content: { msgtype: "m.notice", body: "bot noise" } },
      { type: "m.room.message", sender: BOB, event_id: "$file", origin_server_ts: ts(1100), content: { msgtype: "m.file", body: "notes.pdf" } },
      { type: "m.room.message", sender: BOB, event_id: "$nobody", origin_server_ts: ts(1200), content: { msgtype: "m.text" } },
      { type: "m.room.message", event_id: "$nosender", origin_server_ts: ts(1300), content: { msgtype: "m.text", body: "who?" } },
      { type: "m.room.message", sender: BOB, event_id: "$notime", content: { msgtype: "m.text", body: "when?" } },
      { type: "m.room.topic", sender: BOB, event_id: "$topic", origin_server_ts: ts(1400), content: { topic: "not a message" } },
      // Malformed wire the types do not admit but a broken server could
      // still deliver: content that is not an object, and a timestamp
      // outside ECMAScript's representable time domain — where toISOString
      // would throw and no ordering key could exist. Skipped, not crashed on.
      { type: "m.room.message", sender: BOB, event_id: "$nocontent", origin_server_ts: ts(1250), content: null as unknown as Record<string, unknown> },
      { type: "m.room.message", sender: BOB, event_id: "$farfuture", origin_server_ts: 1e16, content: { msgtype: "m.text", body: "heat death of the universe" } },
      textEvent({ id: "$good", sender: BOB, body: "fine", at: ts(1500) }),
    ]);
    expect(messages.map((message) => message.id)).toEqual(["$good"]);
  });
});

describe("compareMessages + pageMessages — ordering and paging are total and stable (#189 AC 'ordering and paging are stable')", () => {
  function message(id: string, at: number): Message {
    return {
      id,
      conversationId: "!room:workspace",
      author: { kind: "person", userId: BOB },
      body: `body of ${id}`,
      sentAt: new Date(at).toISOString(),
      edit: { kind: "original" },
      threadParentId: null,
    };
  }

  // 20 messages; the middle four share one exact timestamp so the id
  // tiebreak is exercised on real collisions.
  const many: Message[] = [];
  for (let i = 0; i < 20; i += 1) {
    const at = i < 8 || i > 11 ? ts(i * 1000) : ts(8000);
    many.push(message(`$m${i.toString().padStart(2, "0")}`, at));
  }

  it("orders by sentAt, id breaking exact ties — total, and the same total on every call", () => {
    const sorted = [...many].sort(compareMessages);
    expect(sorted.map((m) => m.id)).toEqual(many.map((m) => m.id));
    expect([...many].reverse().sort(compareMessages).map((m) => m.id)).toEqual(sorted.map((m) => m.id));
    // The exact-tie quartet orders by id and stays that way.
    expect(sorted.slice(8, 12).map((m) => m.id)).toEqual(["$m08", "$m09", "$m10", "$m11"]);
    // Antisymmetry and totality over every distinct pair.
    for (const a of sorted) {
      for (const b of sorted) {
        if (a === b) {
          expect(compareMessages(a, b)).toBe(0);
          continue;
        }
        expect(compareMessages(a, b)).toBe(-compareMessages(b, a));
        expect(compareMessages(a, b)).not.toBe(0);
      }
    }
  });

  it("pages backwards from the newest without a cursor, oldest→newest within the page", () => {
    const page = pageMessages(many, { limit: 5 });
    expect(page.messages.map((m) => m.id)).toEqual(["$m15", "$m16", "$m17", "$m18", "$m19"]);
    expect(page.hasMoreBefore).toBe(true);
  });

  it("treats the cursor as exclusive — the page is strictly below it", () => {
    const page = pageMessages(many, { before: "$m15", limit: 5 });
    expect(page.messages.map((m) => m.id)).toEqual(["$m10", "$m11", "$m12", "$m13", "$m14"]);
  });

  it("never drops or duplicates across a full cursor walk — every message seen exactly once", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = pageMessages(many, { before: cursor, limit: 3 });
      seen.push(...page.messages.map((m) => m.id));
      if (!page.hasMoreBefore) {
        break;
      }
      cursor = page.messages[0]!.id;
    }
    // Pages arrive newest-first (backwards paging), but the walk covers
    // every message exactly once: right count, no duplicates, full set.
    expect(seen).toHaveLength(many.length);
    expect(new Set(seen).size).toBe(many.length);
    expect([...seen].sort()).toEqual([...many].map((m) => m.id).sort());
  });

  it("reports hasMoreBefore false exactly at the start of the conversation", () => {
    const page = pageMessages(many, { before: "$m02", limit: 5 });
    expect(page.messages.map((m) => m.id)).toEqual(["$m00", "$m01"]);
    expect(page.hasMoreBefore).toBe(false);
  });

  it("returns an empty page for a cursor the slice does not contain — the gap signal, not a silent rewind to newest", () => {
    // A limited/gappy sync rotates the window; a cursor that fell out of it
    // means the timeline moved under the walker. The honest page is empty
    // with hasMoreBefore false, so the client re-fetches the conversation
    // instead of duplicating history it already rendered.
    const page = pageMessages(many, { before: "$never-seen", limit: 2 });
    expect(page).toEqual({ messages: [], hasMoreBefore: false });
  });
});

describe("invitesFromSync — the invite section is the consent question's wire form (#192)", () => {
  /** A stripped invite slice as Synapse sends it for one room. */
  function inviteRoom(events: readonly RawMatrixEvent[]): RawSyncInviteRoom {
    return { invite_state: { events } };
  }

  function invitedMemberEvent(init: { stateKey?: string; membership?: string; sender?: string } = {}): RawMatrixEvent {
    return {
      type: "m.room.member",
      state_key: init.stateKey ?? DUO_ALICE,
      sender: init.sender ?? BOB,
      event_id: `$invite:${init.stateKey ?? DUO_ALICE}`,
      origin_server_ts: ts(10),
      content: { membership: init.membership ?? "invite" },
    };
  }

  it("parses an invitation with the owner's decision facts: inviter, name, joined count", () => {
    const rooms: RawSyncRooms = {
      invite: {
        "!planning:workspace": inviteRoom([
          invitedMemberEvent(),
          memberEvent(ALICE, "join", 11),
          memberEvent(BOB, "join", 12),
          nameEvent("Launch planning", 13),
        ]),
      },
    };
    expect(invitesFromSync(rooms, DUO_ALICE)).toEqual([
      { roomId: "!planning:workspace", inviterId: BOB, name: "Launch planning", joinedMemberCount: 2 },
    ]);
  });

  it("is room-id ordered and carries the honest count only — non-join memberships never inflate it", () => {
    const rooms: RawSyncRooms = {
      invite: {
        "!z:workspace": inviteRoom([invitedMemberEvent({ sender: ALICE }), memberEvent(ALICE, "join", 11)]),
        "!a:workspace": inviteRoom([
          invitedMemberEvent(),
          memberEvent(ALICE, "join", 11),
          memberEvent("@dana:workspace", "leave", 12),
          memberEvent("@erin:workspace", "ban", 13),
          invitedMemberEvent({ stateKey: "@someone-else:workspace", sender: ALICE }),
        ]),
      },
    };
    expect(invitesFromSync(rooms, DUO_ALICE)).toEqual([
      { roomId: "!a:workspace", inviterId: BOB, name: null, joinedMemberCount: 1 },
      { roomId: "!z:workspace", inviterId: ALICE, name: null, joinedMemberCount: 1 },
    ]);
  });

  it("degrades a missing inviter to null — a fact missing is a fact missing", () => {
    const bare = invitedMemberEvent();
    delete (bare as { sender?: string }).sender;
    const invites = invitesFromSync({ invite: { "!bare:workspace": inviteRoom([bare]) } }, DUO_ALICE);
    expect(invites).toEqual([{ roomId: "!bare:workspace", inviterId: null, name: null, joinedMemberCount: 0 }]);
  });

  it("skips an invite-section room with no invite membership event for THIS account — not an invitation to us", () => {
    const rooms: RawSyncRooms = {
      invite: {
        "!not-ours:workspace": inviteRoom([memberEvent(ALICE, "join", 11), nameEvent("somewhere", 12)]),
        "!already-left:workspace": inviteRoom([invitedMemberEvent({ membership: "leave" })]),
      },
    };
    expect(invitesFromSync(rooms, DUO_ALICE)).toEqual([]);
  });

  it("reads an empty or absent invite section as no invitations", () => {
    expect(invitesFromSync({}, DUO_ALICE)).toEqual([]);
    expect(invitesFromSync({ invite: {} }, DUO_ALICE)).toEqual([]);
    expect(invitesFromSync({ invite: { "!nothing:workspace": inviteRoom([]) } }, DUO_ALICE)).toEqual([]);
  });
});

describe("messagesFromTimeline — files in a conversation (#190, attachments.md §8)", () => {
  function fileEvent(init: { id: string; sender?: string; at?: number; content: Record<string, unknown> }): RawMatrixEvent {
    return {
      type: "m.room.message",
      sender: init.sender ?? BOB,
      event_id: init.id,
      origin_server_ts: init.at ?? ts(1000),
      content: init.content,
    };
  }

  it("parses an m.file into a message carrying its file facts — the wire's own conventions, nothing more", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      fileEvent({
        id: "$f1",
        at: ts(0),
        content: {
          msgtype: "m.file",
          body: "notes.txt",
          filename: "launch-notes.txt",
          url: "mxc://workspace/abc123",
          info: { mimetype: "text/plain", size: 32844 },
        },
      }),
    ]);
    expect(messages).toEqual([
      {
        id: "$f1",
        conversationId: "!dm:workspace",
        author: { kind: "person", userId: BOB },
        body: "notes.txt",
        file: { name: "launch-notes.txt", mimeType: "text/plain", size: 32844, reference: "mxc://workspace/abc123" },
        sentAt: iso(0),
        edit: { kind: "original" },
        threadParentId: null,
      },
    ]);
  });

  it("falls back to the body as the name and to null facts when the sender declared nothing", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      fileEvent({ id: "$f2", at: ts(0), content: { msgtype: "m.file", body: "mystery.bin", url: "mxc://workspace/noinfo" } }),
    ]);
    expect(messages[0]!.file).toEqual({ name: "mystery.bin", mimeType: null, size: null, reference: "mxc://workspace/noinfo" });
  });

  it("reads an m.image without a declared type as image/* — the msgtype is the sender's own declaration", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      fileEvent({ id: "$i1", at: ts(0), content: { msgtype: "m.image", body: "photo.png", url: "mxc://workspace/img1" } }),
    ]);
    expect(messages[0]!.file).toEqual({ name: "photo.png", mimeType: "image/*", size: null, reference: "mxc://workspace/img1" });
  });

  it("skips a file event with no content reference — a dead card is not a message", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      fileEvent({ id: "$dead", content: { msgtype: "m.file", body: "notes.txt", info: { mimetype: "text/plain", size: 10 } } }),
      textEvent({ id: "$ok", sender: BOB, body: "still here", at: ts(2000) }),
    ]);
    expect(messages.map((message) => message.id)).toEqual(["$ok"]);
  });

  it("folds an edit of a file message: the body updates, the file facts stand — an edit renames, it does not re-upload", () => {
    const messages = messagesFromTimeline("!dm:workspace", [
      fileEvent({
        id: "$f3",
        at: ts(0),
        content: { msgtype: "m.file", body: "draft.txt", filename: "draft-v1.txt", url: "mxc://workspace/f3", info: { mimetype: "text/plain", size: 12 } },
      }),
      {
        type: "m.room.message",
        sender: BOB,
        event_id: "$f3-edit",
        origin_server_ts: ts(1000),
        content: {
          msgtype: "m.file",
          body: "* draft-v2.txt",
          url: "mxc://workspace/different",
          "m.new_content": { msgtype: "m.file", body: "renamed-draft.txt" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$f3" },
        },
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe("$f3");
    expect(messages[0]!.body).toBe("renamed-draft.txt");
    expect(messages[0]!.edit).toEqual({ kind: "edited", editedAt: iso(1000) });
    // The facts of the event that was shared are the facts that stand: the
    // reference the room dereferences is the one the file event carried, not
    // one an edit claims — a replacement pointing at a whole new file is a
    // new file event, and the #190 door grounds what rides the question.
    expect(messages[0]!.file).toEqual({ name: "draft-v1.txt", mimeType: "text/plain", size: 12, reference: "mxc://workspace/f3" });
  });

  it("serializes a file message with exactly one file field — no second place a client could read a different file", () => {
    const message = messagesFromTimeline("!dm:workspace", [
      fileEvent({ id: "$f4", at: ts(0), content: { msgtype: "m.file", body: "a.txt", url: "mxc://workspace/f4" } }),
    ])[0]!;
    expect(JSON.parse(JSON.stringify(message)).file).toEqual({ name: "a.txt", mimeType: null, size: null, reference: "mxc://workspace/f4" });
  });
});
