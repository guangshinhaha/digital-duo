import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
// Port 1 is reserved and unroutable, so a connection to it fails fast — same
// trick test/embed-search-cli.test.ts uses for "Ollama unreachable".
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

describe("duo derive pairs", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["derive", "pairs"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("reports zero pairs on an empty, initialized store, without needing a configured provider", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["derive", "pairs"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/extracted 0 pair/i);
  });

  it("extracts pairs from imported records and is idempotent on a second run", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    await importFixture(storePath, tempDir());

    const first = await runCli(["derive", "pairs"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(first.exitCode).toBe(0);

    const second = await runCli(["derive", "pairs"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/0 new/);
  });
});

describe("duo derive topics", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["derive", "topics"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("reports zero assigned on an empty, initialized store, without contacting Ollama", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());

    const result = await runCli(["derive", "topics"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir, DUO_OLLAMA_HOST: UNROUTABLE_HOST },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/assigned 0 pair/i);
  });
});

describe("duo derive rules", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["derive", "rules"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("reports zero induced on an empty, initialized store, without contacting Ollama", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["derive", "rules"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_OLLAMA_HOST: UNROUTABLE_HOST },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/induced 0 rule/i);
  });
});
