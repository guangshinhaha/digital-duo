import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runServe } from "../src/commands/serve.js";
import { PUBLIC_PASSED_ON_MESSAGE } from "../src/permissions/public-answer.js";
import { listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import { createEncryptedStore } from "../src/store/store.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import type { WorkspaceTransport } from "../src/workspace/transport.js";
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
  for (let i = 0; i < 100 && transport.connectCalls === 0; i += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  expect(transport.connectCalls).toBeGreaterThanOrEqual(1);
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
        joinedMemberIds: [SELF, "@bob:workspace"],
      });
      // The answering pipeline is async (draftReply inside answerPublicly);
      // poll briefly rather than sleeping a fixed interval.
      for (let i = 0; i < 100 && transport.sentAnswers.length === 0; i += 1) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      }
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
});
