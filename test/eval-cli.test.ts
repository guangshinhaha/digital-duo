import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo eval offline (#35)", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["eval", "offline"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("refuses an empty store's corpus as too short, naming the span needed — no Ollama required", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["eval", "offline"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/shorter than/i);
    expect(result.stderr).toMatch(/day\(s\)/);
  });

  it("rejects a non-numeric --sample or --seed with a clear message, rather than silently coercing it", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const badSample = await runCli(["eval", "offline", "--sample", "abc"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(badSample.exitCode).not.toBe(0);
    expect(badSample.stderr).toMatch(/--sample/);

    const badSeed = await runCli(["eval", "offline", "--seed", "abc"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(badSeed.exitCode).not.toBe(0);
    expect(badSeed.stderr).toMatch(/--seed/);
  });
});
