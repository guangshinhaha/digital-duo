import { describe, expect, it } from "vitest";
import { answerableQuestionFrom, directQuestionFrom, type RoomDecisionLookup } from "../src/workspace/questions.js";
import type { WorkspaceCandidateMessage } from "../src/workspace/transport.js";

const SELF = "@duo-alice:workspace";

function candidate(overrides: Partial<WorkspaceCandidateMessage> = {}): WorkspaceCandidateMessage {
  return {
    eventId: "$1",
    roomId: "!dm:workspace",
    senderId: "@bob:workspace",
    body: "What did Alice decide about the vendor?",
    originServerTs: Date.now(),
    joinedMemberIds: [SELF, "@bob:workspace"],
    mentionedUserIds: [],
    replyToSenderId: null,
    threadRootSenderId: null,
    ...overrides,
  };
}

describe("directQuestionFrom — v1: a direct question is a text message from the one other member of a two-member room (#186 AC3)", () => {
  it("accepts a message from the other member of a direct room", () => {
    const question = directQuestionFrom(candidate(), SELF);
    expect(question).toMatchObject({
      eventId: "$1",
      roomId: "!dm:workspace",
      senderId: "@bob:workspace",
      body: "What did Alice decide about the vendor?",
    });
    expect(question?.receivedAt).toBeTruthy();
  });

  it("W-S3-1 (#313): marks every question isDirect — the one fact the answer's reply shape reads", () => {
    expect(directQuestionFrom(candidate(), SELF)?.isDirect).toBe(true);
  });

  it("never treats the duo's own messages as questions — including its own answers replayed by sync", () => {
    expect(directQuestionFrom(candidate({ senderId: SELF }), SELF)).toBeNull();
  });

  it("refuses a blank body", () => {
    expect(directQuestionFrom(candidate({ body: "   \n  " }), SELF)).toBeNull();
  });

  it("refuses a group room — consent and addressing there are #192/#189, not guessed at here", () => {
    expect(directQuestionFrom(candidate({ joinedMemberIds: [SELF, "@bob:workspace", "@carol:workspace"] }), SELF)).toBeNull();
  });

  it("refuses a room the duo is not joined to", () => {
    expect(directQuestionFrom(candidate({ joinedMemberIds: ["@bob:workspace", "@carol:workspace"] }), SELF)).toBeNull();
  });

  it("refuses a room the sender has left — a two-member listing where only the duo remains joined", () => {
    expect(directQuestionFrom(candidate({ joinedMemberIds: [SELF] }), SELF)).toBeNull();
  });

  it("treats duplicate member listings as the one member they are", () => {
    expect(directQuestionFrom(candidate({ joinedMemberIds: [SELF, "@bob:workspace", "@bob:workspace"] }), SELF)).not.toBeNull();
  });

  it("never treats another duo's message as a question — the duo-to-duo loop #219 flagged, closed structurally (#189)", () => {
    // A direct room whose other member is a DIFFERENT duo: the self-filter
    // alone would pass it (the sender is not our exact user id), and the
    // two daemons would answer each other forever. The sender's kind —
    // derived from the @duo- convention, the same authorFromUserId the
    // message contract uses — refuses it.
    expect(directQuestionFrom(candidate({ senderId: "@duo-bob:workspace", joinedMemberIds: [SELF, "@duo-bob:workspace"] }), SELF)).toBeNull();
    // The convention is @duo-<owner>: a bare @duo localpart is not the
    // convention and stays a person's message.
    expect(directQuestionFrom(candidate({ senderId: "@duo:workspace", joinedMemberIds: [SELF, "@duo:workspace"] }), SELF)).not.toBeNull();
  });
});

describe("answerableQuestionFrom — #192: reachable means a direct room, or a room the owner allowed", () => {
  const GROUP = { roomId: "!room:workspace", joinedMemberIds: [SELF, "@bob:workspace", "@carol:workspace"] };

  it("keeps the direct-room posture exactly: a DM question answers with no lookup at all", () => {
    const question = answerableQuestionFrom(candidate(), SELF);
    expect(question).toMatchObject({ eventId: "$1", roomId: "!dm:workspace", senderId: "@bob:workspace", body: "What did Alice decide about the vendor?" });
    expect(question?.receivedAt).toBeTruthy();
  });

  it("answers in an owner-allowed room of any size, once addressed (#312/S1)", () => {
    const allowed: RoomDecisionLookup = (roomId) => (roomId === "!room:workspace" ? "allowed" : null);
    const question = answerableQuestionFrom(candidate({ ...GROUP, mentionedUserIds: [SELF] }), SELF, allowed);
    expect(question).toMatchObject({ eventId: "$1", roomId: "!room:workspace", body: "What did Alice decide about the vendor?" });
  });

  it("W-S3-1 (#313): isDirect is true for the direct-room branch and false for the shared-room branch — the fact the answer's reply shape reads", () => {
    expect(answerableQuestionFrom(candidate(), SELF)?.isDirect).toBe(true);
    const allowed: RoomDecisionLookup = (roomId) => (roomId === "!room:workspace" ? "allowed" : null);
    expect(answerableQuestionFrom(candidate({ ...GROUP, mentionedUserIds: [SELF] }), SELF, allowed)?.isDirect).toBe(false);
  });

  it("treats a shared room with no record as not-a-question — the pre-#192 default refusal, structurally ahead of any retrieval", () => {
    expect(answerableQuestionFrom(candidate(GROUP), SELF)).toBeNull();
    expect(answerableQuestionFrom(candidate(GROUP), SELF, () => null)).toBeNull();
  });

  it("an explicit refused or withdrawn decision is the same silence with the owner's name on it — and it vetoes the direct posture too", () => {
    for (const status of ["refused", "withdrawn"] as const) {
      const decision: RoomDecisionLookup = () => status;
      expect(answerableQuestionFrom(candidate(GROUP), SELF, decision)).toBeNull();
      // The veto outranks the two-member default: a withdrawn direct room
      // stays unanswered until a fresh consent act reopens it.
      expect(answerableQuestionFrom(candidate(), SELF, decision)).toBeNull();
    }
  });

  it("still requires the duo and the sender to be joined members, allowed or not", () => {
    const allowed: RoomDecisionLookup = () => "allowed";
    // The duo was kicked or left: consent cannot make an un-joined room reachable.
    expect(answerableQuestionFrom(candidate({ ...GROUP, joinedMemberIds: ["@bob:workspace", "@carol:workspace"] }), SELF, allowed)).toBeNull();
    // The sender left: a departed member's replayed line is not a live question.
    expect(answerableQuestionFrom(candidate({ ...GROUP, joinedMemberIds: [SELF, "@carol:workspace"] }), SELF, allowed)).toBeNull();
  });

  it("keeps every other structural guard: blank bodies, the duo's own messages, and other duos — the loop guard holds wherever consent reaches", () => {
    const allowed: RoomDecisionLookup = () => "allowed";
    expect(answerableQuestionFrom(candidate({ ...GROUP, body: "  \n " }), SELF, allowed)).toBeNull();
    expect(answerableQuestionFrom(candidate({ ...GROUP, senderId: SELF }), SELF, allowed)).toBeNull();
    expect(answerableQuestionFrom(candidate({ ...GROUP, senderId: "@duo-bob:workspace", joinedMemberIds: [SELF, "@duo-bob:workspace", "@bob:workspace"] }), SELF, allowed)).toBeNull();
  });

  it("scopes the lookup to the message's own room — one allowed room does not open its neighbors", () => {
    const seenBy: string[] = [];
    const lookup: RoomDecisionLookup = (roomId) => {
      seenBy.push(roomId);
      return roomId === "!room:workspace" ? "allowed" : null;
    };
    expect(answerableQuestionFrom(candidate({ ...GROUP, mentionedUserIds: [SELF] }), SELF, lookup)).not.toBeNull();
    expect(answerableQuestionFrom(candidate({ ...GROUP, roomId: "!other:workspace", mentionedUserIds: [SELF] }), SELF, lookup)).toBeNull();
    expect(seenBy).toEqual(["!room:workspace", "!other:workspace"]);
  });

  it("with no lookup is the pre-#192 filter byte for byte: direct rooms only, everything else silence", () => {
    expect(answerableQuestionFrom(candidate(), SELF)).not.toBeNull();
    expect(answerableQuestionFrom(candidate(GROUP), SELF)).toBeNull();
    expect(answerableQuestionFrom(candidate({ roomId: "!dm:workspace", joinedMemberIds: [SELF] }), SELF)).toBeNull();
  });
});

describe("answerableQuestionFrom — #312/S1: an allowed shared room still only answers what it's addressed to", () => {
  const GROUP = { roomId: "!room:workspace", joinedMemberIds: [SELF, "@bob:workspace", "@carol:workspace"] };
  const allowed: RoomDecisionLookup = () => "allowed";

  it("an allowed group room with no mention, reply or thread to the duo is not a question", () => {
    expect(answerableQuestionFrom(candidate(GROUP), SELF, allowed)).toBeNull();
  });

  it("a mention of the duo's own id addresses it", () => {
    expect(answerableQuestionFrom(candidate({ ...GROUP, mentionedUserIds: [SELF] }), SELF, allowed)).not.toBeNull();
    // Mentioning someone else does not — the duo's own id must be among them.
    expect(answerableQuestionFrom(candidate({ ...GROUP, mentionedUserIds: ["@carol:workspace"] }), SELF, allowed)).toBeNull();
  });

  it("a reply to the duo's own message addresses it", () => {
    expect(answerableQuestionFrom(candidate({ ...GROUP, replyToSenderId: SELF }), SELF, allowed)).not.toBeNull();
  });

  it("a reply to a person's message does not address the duo", () => {
    expect(answerableQuestionFrom(candidate({ ...GROUP, replyToSenderId: "@carol:workspace" }), SELF, allowed)).toBeNull();
  });

  it("a thread whose root the duo posted addresses it", () => {
    expect(answerableQuestionFrom(candidate({ ...GROUP, threadRootSenderId: SELF }), SELF, allowed)).not.toBeNull();
  });

  it("a thread whose root a person posted does not address the duo", () => {
    expect(answerableQuestionFrom(candidate({ ...GROUP, threadRootSenderId: "@carol:workspace" }), SELF, allowed)).toBeNull();
  });

  it("a refused or withdrawn room stays silent even when the message addresses the duo — consent outranks addressing", () => {
    for (const status of ["refused", "withdrawn"] as const) {
      const decision: RoomDecisionLookup = () => status;
      expect(answerableQuestionFrom(candidate({ ...GROUP, mentionedUserIds: [SELF] }), SELF, decision)).toBeNull();
    }
  });

  it("the direct-room posture is unaffected by addressing — an unmentioned DM still answers (S2)", () => {
    expect(answerableQuestionFrom(candidate(), SELF)).not.toBeNull();
  });
});
