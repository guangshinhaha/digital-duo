import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicAnswerOutcome } from "../src/permissions/public-answer.js";
import { workspaceDeclineNotice } from "../src/permissions/public-answer.js";
import { forgetAlwaysAllowed, InvalidRoomConsentError, readAlwaysAllowed, readRoomConsent, recordAlwaysAllowed } from "../src/workspace/consent.js";
import type { RoomInvite } from "../src/workspace/messages.js";
import { answerableQuestionFrom, directQuestionFrom } from "../src/workspace/questions.js";
import { AlwaysAllowNotApplicableError, NoOwnerToInviteError, WorkspaceService } from "../src/workspace/service.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import type { WorkspaceQuestion, WorkspaceTransport } from "../src/workspace/transport.js";
import { workspaceDraftProvenance } from "../src/serve/workspace-wiring.js";
import { FakeWorkspaceTransport } from "./helpers/fake-workspace-transport.js";
import { useTempDir } from "./helpers/temp-dir.js";

/**
 * guangshinhaha/duo#313/#314/#315 — the daemon half of colleagues talking to
 * someone's duo: the owner brought into the conversation to answer a passed-
 * on question (and the duo still answering the colleague there), a first
 * message's preview riding the invitation, "always allow this person", and
 * a decline that tells the colleague politely.
 */

const SELF = "@duo-alice:workspace";
const OWNER = "@alice:workspace";
const BOB = "@bob:workspace";
const DECLINE = workspaceDeclineNotice("Alice");

const tempDir = useTempDir("duo-conversations-test-");

function duoDir(): string {
  const dir = join(tempDir(), "duo");
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

function passedOn(): PublicAnswerOutcome {
  return { kind: "passed_on", draftId: "d", logEntryId: "l", message: "passed on", topicId: undefined, ownerNotice: undefined };
}

async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

function harness(options: { dir?: string; selfUserId?: string } = {}) {
  const transport = new FakeWorkspaceTransport();
  const answers: WorkspaceQuestion[] = [];
  const service = new WorkspaceService({
    settings: settings(options.selfUserId === undefined ? {} : { userId: options.selfUserId }),
    transportFactory: () => transport as WorkspaceTransport,
    answer: async (question) => {
      answers.push(question);
      return passedOn();
    },
    consent: { duoDir: options.dir ?? duoDir(), declineNotice: DECLINE },
  });
  return { transport, service, answers };
}

function directInvite(overrides: Partial<RoomInvite> = {}): RoomInvite {
  return { roomId: "!dm:workspace", inviterId: BOB, name: null, joinedMemberCount: 1, reason: "Where is the deploy runbook?", direct: true, ...overrides };
}

function message(body: string, senderId: string, joinedMemberIds: string[], eventId = `$${body.length}`) {
  return { eventId, roomId: "!dm:workspace", senderId, body, originServerTs: Date.now(), joinedMemberIds };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the owner in their duo's conversation (#314)", () => {
  it("a colleague's conversation with the duo stays direct when the duo's own owner joins it", () => {
    const question = directQuestionFrom(message("How do I get deploy access?", BOB, [SELF, BOB, OWNER]), SELF);
    expect(question).toMatchObject({ senderId: BOB, body: "How do I get deploy access?" });
  });

  it("the owner's own reply there is never a question to their duo — with or without a consent lookup", () => {
    const reply = message("Ask Priya, she owns that.", OWNER, [SELF, BOB, OWNER]);
    expect(directQuestionFrom(reply, SELF)).toBeNull();
    expect(answerableQuestionFrom(reply, SELF, () => null)).toBeNull();
  });

  it("anyone else joining still makes it a group room — only the owner is set aside", () => {
    expect(directQuestionFrom(message("still direct?", BOB, [SELF, BOB, "@carol:workspace"]), SELF)).toBeNull();
  });

  it("inviteOwner invites exactly the owner the duo's id names, and nobody else", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    await expect(service.inviteOwner("!dm:workspace")).resolves.toEqual({ roomId: "!dm:workspace", userId: OWNER });
    expect(transport.inviteCalls).toEqual([{ roomId: "!dm:workspace", userId: OWNER }]);
    await service.stop();
  });

  it("inviteOwner refuses when the duo's id names no owner, and when the connection is down", async () => {
    const strange = harness({ selfUserId: "@helpdesk:workspace" });
    strange.service.start();
    await flush();
    await expect(strange.service.inviteOwner("!dm:workspace")).rejects.toBeInstanceOf(NoOwnerToInviteError);
    expect(strange.transport.inviteCalls).toEqual([]);
    await strange.service.stop();

    const { service } = harness();
    await expect(service.inviteOwner("!dm:workspace")).rejects.toThrow(/not live/);
  });

  it("after the owner joins, the colleague's next question is still answered there", async () => {
    const { transport, service, answers } = harness();
    service.start();
    await flush();
    transport.deliver(message("And for staging?", BOB, [SELF, BOB, OWNER], "$next"));
    await flush();
    expect(answers.map((question) => question.body)).toEqual(["And for staging?"]);
    expect(transport.sentAnswers.map((sent) => sent.roomId)).toEqual(["!dm:workspace"]);
    await service.stop();
  });
});

describe("a workspace question's draft says where it came from (#314)", () => {
  it("carries the asker, the room, and the question's own matrix.to permalink", () => {
    expect(workspaceDraftProvenance({ roomId: "!dm:workspace", eventId: "$q1", senderId: BOB })).toEqual({
      origin: "channel",
      channelKind: "workspace",
      askerRef: BOB,
      threadId: "!dm:workspace",
      permalink: "https://matrix.to/#/!dm%3Aworkspace/%24q1",
    });
  });
});

describe("a first message waits for the owner's OK (#315)", () => {
  it("holds the invitation with the colleague's first message as its preview", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    transport.deliverInvite(directInvite());
    await flush();
    expect(service.pendingInvites()).toEqual([expect.objectContaining({ roomId: "!dm:workspace", inviterId: BOB, reason: "Where is the deploy runbook?", direct: true })]);
    expect(transport.joinCalls).toEqual([]);
    await service.stop();
  });

  it("a decline tells the colleague politely, on the rejected invitation itself", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    transport.deliverInvite(directInvite());
    await flush();
    await service.refuseInvite("!dm:workspace");
    expect(transport.leaveCalls).toEqual(["!dm:workspace"]);
    expect(transport.leaveReasons).toEqual([DECLINE]);
    expect(DECLINE).toBe("Thanks for reaching out. Alice's duo won't be answering in this conversation — please message Alice directly.");
    await service.stop();
  });

  it("a withdrawal is still a bare leave — the polite notice belongs to a declined first message", async () => {
    const dir = duoDir();
    const { transport, service } = harness({ dir });
    service.start();
    await flush();
    transport.deliverInvite(directInvite());
    await flush();
    await service.allowInvite("!dm:workspace");
    await service.withdrawRoom("!dm:workspace");
    expect(transport.leaveReasons).toEqual([undefined]);
    await service.stop();
  });

  it("Allow and always allow records the person, and their next one-to-one conversation is allowed without asking", async () => {
    const dir = duoDir();
    const { transport, service } = harness({ dir });
    service.start();
    await flush();
    transport.deliverInvite(directInvite());
    await flush();
    await service.allowInvite("!dm:workspace", { always: true });
    expect(readAlwaysAllowed(dir).map((entry) => entry.userId)).toEqual([BOB]);
    expect(service.alwaysAllowed().map((entry) => entry.userId)).toEqual([BOB]);

    transport.deliverInvite(directInvite({ roomId: "!dm2:workspace", reason: "One more thing" }));
    await flush(40);
    expect(transport.joinCalls).toEqual(["!dm:workspace", "!dm2:workspace"]);
    expect(service.pendingInvites()).toEqual([]);
    expect(readRoomConsent(dir).map((entry) => [entry.roomId, entry.status])).toEqual([
      ["!dm2:workspace", "allowed"],
      ["!dm:workspace", "allowed"],
    ]);
    await service.stop();
  });

  it("always-allow never covers a group room from the same person — that stays a fresh decision", async () => {
    const dir = duoDir();
    recordAlwaysAllowed(dir, BOB);
    const { transport, service } = harness({ dir });
    service.start();
    await flush();
    transport.deliverInvite(directInvite({ roomId: "!group:workspace", direct: false, joinedMemberCount: 3 }));
    await flush(40);
    expect(transport.joinCalls).toEqual([]);
    expect(service.pendingInvites().map((invite) => invite.roomId)).toEqual(["!group:workspace"]);
    await service.stop();
  });

  it("invitations from always-allowed people that arrived while offline are allowed on connect", async () => {
    const dir = duoDir();
    recordAlwaysAllowed(dir, BOB);
    const { transport, service } = harness({ dir });
    // Delivered during the sync catch-up, before the connection is live.
    const originalConnect = transport.connect.bind(transport);
    transport.connect = async () => {
      await originalConnect();
      transport.deliverInvite(directInvite());
    };
    service.start();
    await flush(40);
    expect(transport.joinCalls).toEqual(["!dm:workspace"]);
    await service.stop();
  });

  it("refuses 'always' for an invitation that isn't a person's one-to-one conversation — and joins nothing", async () => {
    const { transport, service } = harness();
    service.start();
    await flush();
    transport.deliverInvite(directInvite({ roomId: "!group:workspace", direct: false }));
    await flush();
    await expect(service.allowInvite("!group:workspace", { always: true })).rejects.toBeInstanceOf(AlwaysAllowNotApplicableError);
    expect(transport.joinCalls).toEqual([]);
    expect(service.pendingInvites()).toHaveLength(1);
    await service.stop();
  });

  it("taking the standing yes back holds the next invitation for the owner again", async () => {
    const dir = duoDir();
    recordAlwaysAllowed(dir, BOB);
    const { transport, service } = harness({ dir });
    service.start();
    await flush();
    expect(service.forgetAlwaysAllowed(BOB)).toEqual({ removed: true, people: [] });
    expect(service.forgetAlwaysAllowed(BOB)).toEqual({ removed: false, people: [] });
    transport.deliverInvite(directInvite());
    await flush(40);
    expect(transport.joinCalls).toEqual([]);
    await service.stop();
  });
});

describe("the always-allow record (#315)", () => {
  it("is empty when absent, upserts one entry per person, and forgets honestly", () => {
    const dir = duoDir();
    expect(readAlwaysAllowed(dir)).toEqual([]);
    recordAlwaysAllowed(dir, BOB);
    recordAlwaysAllowed(dir, BOB);
    expect(readAlwaysAllowed(dir).map((entry) => entry.userId)).toEqual([BOB]);
    expect(forgetAlwaysAllowed(dir, "@nobody:workspace").removed).toBe(false);
    expect(forgetAlwaysAllowed(dir, BOB).removed).toBe(true);
    expect(readAlwaysAllowed(dir)).toEqual([]);
  });

  it("throws on a malformed file rather than silently re-gating people", () => {
    const dir = duoDir();
    writeFileSync(join(dir, "always-allow.json"), JSON.stringify([{ decidedAt: "x" }]), "utf8");
    expect(() => readAlwaysAllowed(dir)).toThrow(InvalidRoomConsentError);
  });
});
