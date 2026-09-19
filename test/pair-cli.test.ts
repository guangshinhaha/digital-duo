import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo pair — device pairing (client-tech-design.md Part 2)", () => {
  it("mints a token and prints it once", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["pair", "new", "iPhone"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("iPhone");
    expect(result.stdout).toContain("paired");
  });

  it("says so on an empty roster", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["pair", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No paired devices.");
  });

  it("lists a paired device by name", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    await runCli(["pair", "new", "iPhone"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["pair", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("iPhone");
    expect(result.stdout).toContain("last seen never");
  });

  it("revokes a device by id, and it stops appearing as valid", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const pairResult = await runCli(["pair", "new", "iPhone"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const idMatch = /id ([\w-]+)/.exec(pairResult.stdout);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const revokeResult = await runCli(["pair", "revoke", id], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(revokeResult.exitCode).toBe(0);

    const listResult = await runCli(["pair", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(listResult.stdout).toContain("revoked");
  });

  it("fails loudly, naming the id, revoking a device that doesn't exist", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["pair", "revoke", "not-a-real-id"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not-a-real-id");
  });
});
