import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { runServe } from "../src/commands/serve.js";

const tempDir = useTempDir();

describe("duo serve — refuses an unsafe bind before opening any socket (client-design.md AR-12)", () => {
  it("via the CLI: refuses with no --host given", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["serve"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: "pw" } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to bind/);
  });

  it("via the CLI: refuses --host 0.0.0.0", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["serve", "--host", "0.0.0.0"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: "pw" } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to bind/);
  });
});

describe("runServe — actually binds and serves on an explicit loopback host", () => {
  it("listens on 127.0.0.1, answers /health, and closes cleanly", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    // DUO_PASSPHRASE set on init too, so the store is actually encrypted
    // with "pw" — runServe's own passphrase-mismatch check (below) would
    // otherwise catch this exact mismatch and refuse to start, the same
    // way it's meant to catch a genuine typo.
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: "pw" } });
    const config = loadConfig({ DUO_STORE_PATH: storePath } as NodeJS.ProcessEnv);

    const { address, close } = await runServe({ host: "127.0.0.1", port: 0 }, config, { DUO_PASSPHRASE: "pw" } as NodeJS.ProcessEnv);
    try {
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${address}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await close();
    }
  });

  it("refuses to start with the wrong passphrase, before binding — not a server that starts and then 500s every request", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: "correct-pw" } });
    const config = loadConfig({ DUO_STORE_PATH: storePath } as NodeJS.ProcessEnv);

    await expect(runServe({ host: "127.0.0.1", port: 0 }, config, { DUO_PASSPHRASE: "wrong-pw" } as NodeJS.ProcessEnv)).rejects.toThrow(
      /passphrase/i,
    );
  });
});
