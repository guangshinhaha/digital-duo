import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { FAKE_SYNAPSE_URL } from "./helpers/fake-synapse.js";
import { FakeWorkspaceTransport } from "./helpers/fake-workspace-transport.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { DuoWorkspaceConnections } from "../src/hosted/duo-workspace.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { createEncryptedStore } from "../src/store/store.js";

const captured: Array<{ sdkLogger?: { debug: (...args: unknown[]) => void; error: (...args: unknown[]) => void } }> = [];

vi.mock("../src/workspace/matrix-transport.js", () => ({
  createMatrixTransport: (_settings: unknown, options: (typeof captured)[number]) => {
    captured.push(options);
    return new FakeWorkspaceTransport();
  },
}));

const tempDir = useTempDir();
const managers: DuoWorkspaceConnections[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  captured.length = 0;
});

describe("what the SDK says goes through the duo's scrubbed log", () => {
  it("names the duo, takes the token out, and is filtered by the level", async () => {
    const registry = new HostedRegistry(join(tempDir(), "registry.json"), "master");
    const { invite } = registry.createInvite("Sam", new Date(Date.now() + 3_600_000).toISOString());
    const tenant = registry.addTenant(invite.id, "Sam", "pw");
    createEncryptedStore(join(tempDir(), "duos", tenant.id, "duo.db"), "pw");
    const config = loadConfig({});
    const logs: string[] = [];
    const manager = new DuoWorkspaceConnections({ registry, config, homeserverUrl: FAKE_SYNAPSE_URL, startStaggerMs: 0, sdkLogLevel: "debug", log: (line) => logs.push(line) });
    managers.push(manager);
    registry.onChange(() => manager.reconcile());
    manager.attach(tenant.id, {
      storePath: join(tempDir(), "duos", tenant.id, "duo.db"),
      passphrase: "pw",
      duoDir: join(tempDir(), "duos", tenant.id, "duo"),
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: undefined,
      confidenceConfig: config.confidence,
      classificationCeiling: config.classificationCeiling,
      ownerName: "Sam",
    });
    registry.setMatrixAccounts(tenant.id, { personUserId: `@default.${tenant.id}:duo.test`, duoUserId: `@duo-default.${tenant.id}:duo.test` }, "syt_exact_token_value");
    await expect.poll(() => captured.length, { timeout: 8_000 }).toBe(1);

    captured[0]!.sdkLogger!.debug("request with syt_exact_token_value and another syt_other_shaped_token", new Error("also syt_exact_token_value"));
    const line = logs.find((candidate) => candidate.includes("matrix sdk debug"))!;
    expect(line).toContain(`duo ${tenant.id}`);
    expect(line).not.toContain("syt_exact_token_value");
    expect(line).not.toContain("syt_other_shaped_token");
    expect(line).toContain("[redacted]");
  });
});
