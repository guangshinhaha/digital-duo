import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
// Port 1 is reserved and unroutable, so a connection to it fails fast — same
// trick test/ask.test.ts uses to exercise "Ollama unreachable" without a
// real server.
const UNROUTABLE_HOST = "http://127.0.0.1:1";

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

async function importFixture(storePath: string, cwd: string): Promise<void> {
  const { fileURLToPath } = await import("node:url");
  const fixture = fileURLToPath(new URL("./fixtures/claude-export-all-work.json", import.meta.url));
  const result = await runCli(["import", "claude", fixture], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo embed", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["embed"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("reports zero embedded on an empty, initialized store, without contacting Ollama", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["embed"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_OLLAMA_HOST: UNROUTABLE_HOST },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/embedded 0 record.*0 total/i);
  });
});

describe("duo search", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["search", "anything"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("falls back to full-text search and reports it explicitly when the embedding service is down", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    await importFixture(storePath, tempDir());

    const result = await runCli(["search", "runbook"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_OLLAMA_HOST: UNROUTABLE_HOST },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/falling back to full-text search only/i);
    expect(result.stdout).toMatch(/runbook/i);
  });

  it("reports no matching records, not an error, on an empty store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["search", "anything"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_OLLAMA_HOST: UNROUTABLE_HOST },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no matching records/i);
  });
});
