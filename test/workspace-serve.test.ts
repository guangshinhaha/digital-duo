import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runServe } from "../src/commands/serve.js";
import { PUBLIC_PASSED_ON_MESSAGE } from "../src/permissions/public-answer.js";
import { listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";
import type { RoomInvite } from "../src/workspace/messages.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import { WorkspaceTokenRevokedError, type WorkspaceTransport } from "../src/workspace/transport.js";
import { FakeWorkspaceTransport } from "./helpers/fake-workspace-transport.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): { storePath: string; config: ReturnType<typeof loadConfig> } {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return { storePath, config: loadConfig({ DUO_STORE_PATH: storePath, DUO_DIR: join(tempDir(), "duo") } as NodeJS.ProcessEnv) };
}

function workspaceEnv(storePath: string): NodeJS.ProcessEnv {
  return {
    DUO_STORE_PATH: storePath,
    DUO_DIR: join(tempDir(), "duo"),
    DUO_PASSPHRASE: PASSPHRASE,
    DUO_WORKSPACE_HOMESERVER: "https://matrix.workspace.example",
    DUO_WORKSPACE_ACCESS_TOKEN: "syt_secret",
    DUO_WORKSPACE_USER_ID: "@duo-alice:workspace",
  } as NodeJS.ProcessEnv;
}

const SELF = "@duo-alice:workspace";

/** runServe resolves before the async workspace dial finishes — wait for the outbound connection to be live (messages only flow once connected). */
async function untilConnected(transport: FakeWorkspaceTransport): Promise<void> {
  await until(() => transport.connectCalls >= 1);
  expect(transport.connectCalls).toBeGreaterThanOrEqual(1);
}

/** Polls a short-bounded condition instead of sleeping a fixed interval — the answering pipeline is async (draftReply inside answerPublicly). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  expect(condition()).toBe(true);
}

describe("runServe + workspace — the outbound connection alongside the unchanged listener (#186 AC1/AC2)", () => {
  it("dials out when configured, while the HTTP listener serves exactly as before", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const factorySettings: WorkspaceSettings[] = [];
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe(
      { host: "127.0.0.1", port: 0 },
      config,
      workspaceEnv(storePath),
      (settings) => {
        factorySettings.push(settings);
        return transport as WorkspaceTransport;
      },
    );
    try {
      expect(factorySettings).toHaveLength(1);
      expect(factorySettings[0].userId).toBe(SELF);
      await untilConnected(transport);
      // The one listening socket is the tailnet-bound HTTP listener — the
      // workspace connection dialed out and opened nothing inbound.
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await (await fetch(`${address}/health`)).json()).toEqual({ ok: true });
    } finally {
      await close();
    }
    expect(transport.stopCalls).toBe(1);
  });

  it("runs the SAME answering pipeline for a workspace question, logs the asker, and returns the answer over the same connection (#186 AC3)", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { close } = await runServe(
      { host: "127.0.0.1", port: 0 },
      config,
      workspaceEnv(storePath),
      () => transport as WorkspaceTransport,
    );
    try {
      await untilConnected(transport);
      transport.deliver({
        eventId: "$q1",
        roomId: "!dm:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide about the vendor?",
        originServerTs: Date.now(),
        joinedMemberIds: [SELF, "@bob:workspace"],
      });
      await until(() => transport.sentAnswers.length >= 1);
      // An empty store answers passed_on through the public pipeline — the
      // identical outcome POST /ask produces for the same corpus state,
      // attribution line included (withPublicAttribution composes it into
      // the asker-visible text).
      expect(transport.sentAnswers).toHaveLength(1);
      expect(transport.sentAnswers[0].roomId).toBe("!dm:workspace");
      expect(transport.sentAnswers[0].content.msgtype).toBe("m.text");
      expect(transport.sentAnswers[0].content.body).toContain(PUBLIC_PASSED_ON_MESSAGE);
      expect(transport.sentAnswers[0].content.body).toMatch(/— the owner's duo speaking here, not the owner directly\./);
      // The asker resolved through the existing directory lookup: no
      // directory exists, so the full Matrix sender id is logged as the ref.
      const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
      expect(entries).toHaveLength(1);
      expect(entries[0].askerRef).toBe("@bob:workspace");
      expect(entries[0].askLinkId).toBeNull();
    } finally {
      await close();
    }
    // The durable read state coalesces its writes onto the next event-loop
    // turn; let that turn happen while this test's store still exists, so
    // the record lands (and no orphaned flush fires after teardown).
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  });

  it("never starts the workspace when unconfigured — zero behavior change for non-workspace users (#186 AC2)", async () => {
    const { storePath, config } = initStore();
    let factoryCalls = 0;
    const { address, close } = await runServe(
      { host: "127.0.0.1", port: 0 },
      config,
      { DUO_STORE_PATH: storePath, DUO_DIR: join(tempDir(), "duo"), DUO_PASSPHRASE: PASSPHRASE } as NodeJS.ProcessEnv,
      () => {
        factoryCalls += 1;
        return new FakeWorkspaceTransport() as WorkspaceTransport;
      },
    );
    try {
      expect(factoryCalls).toBe(0);
      expect(await (await fetch(`${address}/health`)).json()).toEqual({ ok: true });
    } finally {
      await close();
    }
  });

  it("refuses a half-configured workspace before binding anything", async () => {
    const { storePath } = initStore();
    const partial = workspaceEnv(storePath);
    delete partial.DUO_WORKSPACE_ACCESS_TOKEN;
    const config = loadConfig(partial);
    await expect(runServe({ host: "127.0.0.1", port: 0 }, config, partial, () => new FakeWorkspaceTransport() as WorkspaceTransport)).rejects.toThrow(
      /workspace configuration is incomplete/,
    );
  });

  it("runs the connect-time identity read and logs the asker exactly as the unfed path does — the directory serves the existing path, never replaces it (#187 AC3)", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    transport.setMembers({
      members: [
        { userId: "@bob:workspace", displayName: "Bob", presence: { online: true, lastActiveAgoMs: 1000 } },
        { userId: "@mallory:workspace", displayName: "Bob", presence: { online: false, lastActiveAgoMs: null } },
      ],
      truncated: false,
    });
    const { close } = await runServe(
      { host: "127.0.0.1", port: 0 },
      config,
      workspaceEnv(storePath),
      () => transport as WorkspaceTransport,
    );
    try {
      await untilConnected(transport);
      // The connect-time identity read ran — the workspace directory is
      // what the feed reads — and it is the identity-only read: no
      // presence fan-out on the connect path.
      await until(() => transport.listMemberIdentitiesCalls >= 1);
      expect(transport.listMembersCalls).toBe(0);
      transport.deliver({
        eventId: "$q1",
        roomId: "!dm:workspace",
        senderId: "@bob:workspace",
        body: "What did Alice decide about the vendor?",
        originServerTs: Date.now(),
        joinedMemberIds: [SELF, "@bob:workspace"],
      });
      await until(() => transport.sentAnswers.length >= 1);
      // The member-fed resolution logged the same ref the existing path
      // produces for this sender (no directory.json exists, so the full
      // Matrix user id): the feed is outcome-neutral by design — the AC's
      // "the existing permissions path is unchanged" — so this asserts the
      // byte-identical outcome, not a new one.
      const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.askerRef).toBe("@bob:workspace");
      expect(entries[0]!.askerResolved).toBe(false);
    } finally {
      await close();
    }
  });

  it("survives a revoked token at boot — the listener serves, the error says re-pair, and nothing hot-loops (#187 R7)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { storePath } = initStore();
      // A short initial delay makes the post-rejection window below long
      // enough to catch a wrongly-scheduled STANDARD reconnect too, not
      // just a hot loop (the service-level test pins the full 300s no-dial
      // contract against fake timers).
      const fastBackoff = workspaceEnv(storePath);
      fastBackoff.DUO_WORKSPACE_RECONNECT_INITIAL_MS = "50";
      const config = loadConfig(fastBackoff);
      const transport = new FakeWorkspaceTransport();
      transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("Unrecognised access token"));
      const { address, close } = await runServe(
        { host: "127.0.0.1", port: 0 },
        config,
        fastBackoff,
        () => transport as WorkspaceTransport,
      );
      try {
        // The revoked dial is async; wait for it to land, then give a
        // would-be reconnect (initial delay 50ms) a window to fire in.
        await until(() => transport.connectCalls >= 1);
        await new Promise((resolveTick) => setTimeout(resolveTick, 200));
        // Terminal: no re-dials, the HTTP listener is unaffected, and the
        // owner-side error names the fix.
        expect(transport.connectCalls).toBe(1);
        expect(await (await fetch(`${address}/health`)).json()).toEqual({ ok: true });
        const logged = consoleError.mock.calls.map((call) => String(call[0]));
        expect(logged.some((line) => line.includes("re-pair the duo"))).toBe(true);
      } finally {
        await close();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not re-answer an already-handled question after a restart — durable read state in the encrypted store (#189)", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const question = {
      eventId: "$once",
      roomId: "!dm:workspace",
      senderId: "@bob:workspace",
      body: "What did Alice decide about the vendor?",
      originServerTs: Date.now(),
      joinedMemberIds: [SELF, "@bob:workspace"],
    };
    // First process: answers, and records the handled event durably.
    const firstTransport = new FakeWorkspaceTransport();
    const first = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => firstTransport as WorkspaceTransport);
    try {
      await untilConnected(firstTransport);
      firstTransport.deliver(question);
      for (let i = 0; i < 100 && firstTransport.sentAnswers.length === 0; i += 1) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      }
      expect(firstTransport.sentAnswers).toHaveLength(1);
    } finally {
      await first.close();
    }
    // The handled-event record coalesces onto the next event-loop turn —
    // let it land before the test's teardown removes the store, or the
    // restart below would rightly see nothing handled.
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    // Restart: fresh service, same encrypted store — the sync replay of the
    // same event stays silent where the pre-#189 in-process dedupe would
    // have re-answered it.
    const secondTransport = new FakeWorkspaceTransport();
    const second = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => secondTransport as WorkspaceTransport);
    try {
      await untilConnected(secondTransport);
      secondTransport.deliver(question);
      // The negative half polls for the same ~1s window the positive halves
      // allow, so a late answer (the failure this test pins) cannot hide
      // behind a too-short fixed wait.
      for (let i = 0; i < 100 && secondTransport.sentAnswers.length === 0; i += 1) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      }
      expect(secondTransport.sentAnswers).toEqual([]);
    } finally {
      await second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// #192: consent for a duo in a shared conversation — the owner surface over
// HTTP, and the scope-follows-the-asker contract through the real pipeline.
// ---------------------------------------------------------------------------

const ROOM = "!room:workspace";
const BOB = "@bob:workspace";

function invite(overrides: Partial<RoomInvite> = {}): RoomInvite {
  return { roomId: ROOM, inviterId: BOB, name: "Launch planning", joinedMemberCount: 3, ...overrides };
}

function roomMessage(message: { eventId: string; body: string; senderId?: string; roomId?: string; joinedMemberIds?: string[] }) {
  return {
    eventId: message.eventId,
    roomId: message.roomId ?? ROOM,
    senderId: message.senderId ?? BOB,
    body: message.body,
    originServerTs: Date.now(),
    joinedMemberIds: message.joinedMemberIds ?? [SELF, BOB, "@carol:workspace"],
  };
}

/** Polls the negative half for the same ~1s window the positive halves allow. */
async function staysSilent(transport: FakeWorkspaceTransport): Promise<void> {
  for (let i = 0; i < 100 && transport.sentAnswers.length === 0; i += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  expect(transport.sentAnswers).toEqual([]);
}

describe("runServe + workspace — the consent surface over HTTP (#192)", () => {
  it("holds the invitation, lists it, allows it, and the room becomes answerable — owner-token gated throughout", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => transport as WorkspaceTransport);
    try {
      await untilConnected(transport);
      const paired = createDeviceToken(storePath, PASSPHRASE, "owner-device");
      const auth = { authorization: `Bearer ${paired.token}` };
      // The surface is the owner's: no token, no list.
      expect((await fetch(`${address}/workspace/invites`)).status).toBe(401);
      transport.deliverInvite(invite());
      await until(() => transport.inviteDeliveries >= 1);
      const listed = (await (await fetch(`${address}/workspace/invites`, { headers: auth })).json()) as { invites: { roomId: string; inviterId: string; name: string; joinedMemberCount: number }[] };
      expect(listed.invites[0]).toMatchObject({ roomId: ROOM, inviterId: BOB, name: "Launch planning", joinedMemberCount: 3 });
      // The allow is the owner's act, and it is the only thing that joined.
      expect(transport.joinCalls).toEqual([]);
      const allowed = await fetch(`${address}/workspace/invites/${ROOM}/allow`, { method: "POST", headers: auth });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ roomId: ROOM, status: "allowed", inviterId: BOB, name: "Launch planning", joinedMemberCount: 3 });
      expect(transport.joinCalls).toEqual([ROOM]);
      const rooms = (await (await fetch(`${address}/workspace/rooms`, { headers: auth })).json()) as { rooms: { roomId: string }[] };
      expect(rooms.rooms.map((room) => room.roomId)).toEqual([ROOM]);
      // The gate opened: a question in the shared room now answers, through
      // the same pipeline a DM question takes.
      transport.deliver(roomMessage({ eventId: "$q1", body: "What did Alice decide about the vendor?" }));
      await until(() => transport.sentAnswers.length >= 1);
      expect(transport.sentAnswers[0]!.roomId).toBe(ROOM);
      expect(transport.sentAnswers[0]!.content.body).toContain(PUBLIC_PASSED_ON_MESSAGE);
    } finally {
      await close();
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  });

  it("refuses over HTTP — 204 with nothing left held or recorded, and the room stays gated", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => transport as WorkspaceTransport);
    try {
      await untilConnected(transport);
      const auth = { authorization: `Bearer ${createDeviceToken(storePath, PASSPHRASE, "owner-device").token}` };
      transport.deliverInvite(invite());
      await until(() => transport.inviteDeliveries >= 1);
      const refused = await fetch(`${address}/workspace/invites/${ROOM}/refuse`, { method: "POST", headers: auth });
      expect(refused.status).toBe(204);
      expect(await refused.text()).toBe("");
      expect((await (await fetch(`${address}/workspace/invites`, { headers: auth })).json()).invites).toEqual([]);
      expect((await (await fetch(`${address}/workspace/rooms`, { headers: auth })).json()).rooms).toEqual([]);
      expect(transport.leaveCalls).toEqual([ROOM]);
      // The refusal was real: the room's questions are not work.
      transport.deliver(roomMessage({ eventId: "$q-after-refuse", body: "let me in anyway" }));
      await staysSilent(transport);
    } finally {
      await close();
    }
  });

  it("withdraws over HTTP — the withdrawn entry comes back, the room empties, and the questions stop", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => transport as WorkspaceTransport);
    try {
      await untilConnected(transport);
      const auth = { authorization: `Bearer ${createDeviceToken(storePath, PASSPHRASE, "owner-device").token}` };
      transport.deliverInvite(invite());
      await until(() => transport.inviteDeliveries >= 1);
      await fetch(`${address}/workspace/invites/${ROOM}/allow`, { method: "POST", headers: auth });
      transport.deliver(roomMessage({ eventId: "$before", body: "answered while consented" }));
      await until(() => transport.sentAnswers.length >= 1);
      const withdrawn = await fetch(`${address}/workspace/rooms/${ROOM}/withdraw`, { method: "POST", headers: auth });
      expect(withdrawn.status).toBe(200);
      expect(await withdrawn.json()).toMatchObject({ roomId: ROOM, status: "withdrawn" });
      expect((await (await fetch(`${address}/workspace/rooms`, { headers: auth })).json()).rooms).toEqual([]);
      expect(transport.leaveCalls).toEqual([ROOM]);
      // Only the pre-withdrawal answer ever went out — withdrawal killed the
      // room at once, with no in-flight grace for later questions.
      transport.deliver(roomMessage({ eventId: "$after", body: "asked after withdrawal" }));
      for (let i = 0; i < 100 && transport.sentAnswers.length === 1; i += 1) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      }
      expect(transport.sentAnswers).toHaveLength(1);
    } finally {
      await close();
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  });

  it("maps the service's not-found refusals to clean 404s", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => transport as WorkspaceTransport);
    try {
      await untilConnected(transport);
      const auth = { authorization: `Bearer ${createDeviceToken(storePath, PASSPHRASE, "owner-device").token}` };
      const allow = await fetch(`${address}/workspace/invites/${ROOM}/allow`, { method: "POST", headers: auth });
      expect(allow.status).toBe(404);
      expect(((await allow.json()) as { error: { code: string } }).error.code).toBe("NoPendingInviteError");
      const withdraw = await fetch(`${address}/workspace/rooms/${ROOM}/withdraw`, { method: "POST", headers: auth });
      expect(withdraw.status).toBe(404);
      expect(((await withdraw.json()) as { error: { code: string } }).error.code).toBe("RoomConsentNotFoundError");
    } finally {
      await close();
    }
  });

  it("reads empty state and refuses the consented acts when no workspace is configured", async () => {
    const { storePath, config } = initStore();
    const { address, close } = await runServe(
      { host: "127.0.0.1", port: 0 },
      config,
      { DUO_STORE_PATH: storePath, DUO_DIR: join(tempDir(), "duo"), DUO_PASSPHRASE: PASSPHRASE } as NodeJS.ProcessEnv,
      () => new FakeWorkspaceTransport() as WorkspaceTransport,
    );
    try {
      const auth = { authorization: `Bearer ${createDeviceToken(storePath, PASSPHRASE, "owner-device").token}` };
      expect(await (await fetch(`${address}/workspace/invites`, { headers: auth })).json()).toEqual({ invites: [] });
      expect(await (await fetch(`${address}/workspace/rooms`, { headers: auth })).json()).toEqual({ rooms: [] });
      for (const [path, act] of [
        [`/workspace/invites/${ROOM}/allow`, "Allowing"],
        [`/workspace/invites/${ROOM}/refuse`, "Refusing"],
        [`/workspace/rooms/${ROOM}/withdraw`, "Withdrawing"],
      ] as const) {
        const response = await fetch(`${address}${path}`, { method: "POST", headers: auth });
        expect(response.status).toBe(503);
        const error = ((await response.json()) as { error: { code: string; message: string } }).error;
        expect(error.code).toBe("workspace_not_configured");
        expect(error.message).toContain(act);
      }
    } finally {
      await close();
    }
  });
});

describe("runServe + workspace — scope follows the asker, not the room (#192)", () => {
  it("the same asker gets the identical decline in a consented shared room that their DM gets — same text, same logged ref", async () => {
    const { storePath } = initStore();
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => transport as WorkspaceTransport);
    try {
      await untilConnected(transport);
      const auth = { authorization: `Bearer ${createDeviceToken(storePath, PASSPHRASE, "owner-device").token}` };
      transport.deliverInvite(invite());
      await until(() => transport.inviteDeliveries >= 1);
      await fetch(`${address}/workspace/invites/${ROOM}/allow`, { method: "POST", headers: auth });
      // Same person, same question: once in their DM with the duo, once in
      // the consented shared room.
      transport.deliver({
        eventId: "$dm-ask",
        roomId: "!dm:workspace",
        senderId: BOB,
        body: "What did Alice decide about the vendor?",
        originServerTs: Date.now(),
        joinedMemberIds: [SELF, BOB],
      });
      transport.deliver(roomMessage({ eventId: "$room-ask", body: "What did Alice decide about the vendor?" }));
      await until(() => transport.sentAnswers.length >= 2);
      const [dmAnswer, roomAnswer] = transport.sentAnswers;
      // Zero lenience from room membership: the shared room's members see
      // exactly what the DM would have shown — the uniform public ceiling,
      // not the room's population, decided.
      expect(roomAnswer!.roomId).toBe(ROOM);
      expect(roomAnswer!.content.body).toBe(dmAnswer!.content.body);
      // And the log attributes both asks to the asker, identically — the
      // resolution is sender-scoped (room-blind) by construction.
      const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.askerRef === BOB)).toBe(true);
      expect(entries.every((entry) => entry.askerResolved === false)).toBe(true);
      expect(entries.every((entry) => entry.askLinkId === null)).toBe(true);
    } finally {
      await close();
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  });

  it("an unresolved asker stays conservative from any room — and a directory entry, however high, buys no lenience", async () => {
    const { storePath } = initStore();
    const duoDir = join(tempDir(), "duo");
    mkdirSync(duoDir, { recursive: true });
    // The owner's own roster names Bob at the highest clearance there is.
    writeFileSync(join(duoDir, "directory.json"), JSON.stringify([{ id: "bob", name: "Bob", clearance: "secret" }]), "utf8");
    const config = loadConfig(workspaceEnv(storePath));
    const transport = new FakeWorkspaceTransport();
    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, workspaceEnv(storePath), () => transport as WorkspaceTransport);
    try {
      await untilConnected(transport);
      const auth = { authorization: `Bearer ${createDeviceToken(storePath, PASSPHRASE, "owner-device").token}` };
      transport.deliverInvite(invite());
      await until(() => transport.inviteDeliveries >= 1);
      await fetch(`${address}/workspace/invites/${ROOM}/allow`, { method: "POST", headers: auth });
      // The resolved, top-clearance asker in the consented room…
      transport.deliver(roomMessage({ eventId: "$bob", body: "What did Alice decide about the vendor?" }));
      // …and a complete stranger in the same room.
      transport.deliver(roomMessage({ eventId: "$stranger", body: "What did Alice decide about the vendor?", senderId: "@stranger:workspace", joinedMemberIds: [SELF, "@stranger:workspace", "@carol:workspace"] }));
      await until(() => transport.sentAnswers.length >= 2);
      const [bobAnswer, strangerAnswer] = transport.sentAnswers;
      // Identical declines both ways: the public answering path applies one
      // uniform ceiling regardless of who resolved — a directory entry,
      // however senior, changes the log line, never the answer.
      expect(bobAnswer!.content.body).toBe(strangerAnswer!.content.body);
      expect(bobAnswer!.content.body).toContain(PUBLIC_PASSED_ON_MESSAGE);
      const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
      expect(entries).toHaveLength(2);
      const byRef = new Map(entries.map((entry) => [entry.askerRef, entry]));
      // Resolution is audit fidelity only: Bob logs as the directory's id
      // (resolved), the stranger as their full Matrix id (unresolved) — and
      // both got the same conservative answer above.
      expect(byRef.get("bob")?.askerResolved).toBe(true);
      expect(byRef.get("@stranger:workspace")?.askerResolved).toBe(false);
    } finally {
      await close();
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  });
});
