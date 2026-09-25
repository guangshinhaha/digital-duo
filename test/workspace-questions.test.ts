import { describe, expect, it } from "vitest";
import { directQuestionFrom } from "../src/workspace/questions.js";
import type { WorkspaceCandidateMessage } from "../src/workspace/transport.js";

const SELF = "@duo-alice:workspace";

function candidate(overrides: Partial<WorkspaceCandidateMessage> = {}): WorkspaceCandidateMessage {
  return {
    eventId: "$1",
    roomId: "!dm:workspace",
    senderId: "@bob:workspace",
    body: "What did Alice decide about the vendor?",
    joinedMemberIds: [SELF, "@bob:workspace"],
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
});
