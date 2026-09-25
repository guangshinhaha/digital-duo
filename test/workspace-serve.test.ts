import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runServe } from "../src/commands/serve.js";
import { PUBLIC_PASSED_ON_MESSAGE } from "../src/permissions/public-answer.js";
import { listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import { createEncryptedStore } from "../src/store/store.js";
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
