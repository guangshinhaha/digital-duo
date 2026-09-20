import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo ask-link — short-lived, ask-only links (issue #158)", () => {
  it("mints a link and prints the token once, with its id and expiry", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["ask-link", "new", "Sam"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sam");
    expect(result.stdout).toContain("Expires");
    expect(result.stdout).toContain("Token (copy this now, it will not be shown again):");
    expect(/id ([\w-]+)/.exec(result.stdout)).not.toBeNull();
  });

  it("lists a minted link with its ask scope and expiry", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    await runCli(["ask-link", "new", "Sam"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["ask-link", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sam");
    expect(result.stdout).toContain("ask");
    expect(result.stdout).toContain("expires");
  });

  it("never appears in `duo pair list` — an ask link is not a paired device", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const mintResult = await runCli(["ask-link", "new", "Sam"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(mintResult.exitCode).toBe(0);

    const result = await runCli(["pair", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No paired devices.");
  });

  it("never prints the raw token in `ask-link list`", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const mintResult = await runCli(["ask-link", "new", "Sam"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    // The raw token is the last stdout line of `ask-link new` — everything
    // above it is the id/expiry header and the copy-now warning.
    const token = mintResult.stdout.trimEnd().split("\n").at(-1);
    expect(token).toBeDefined();
    expect(token).not.toContain("Token (");

    const result = await runCli(["ask-link", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(token!);
  });

  it("revokes a link by id, and it shows as revoked", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const mintResult = await runCli(["ask-link", "new", "Sam"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const idMatch = /id ([\w-]+)/.exec(mintResult.stdout);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const revokeResult = await runCli(["ask-link", "revoke", id], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(revokeResult.exitCode).toBe(0);

    const listResult = await runCli(["ask-link", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(listResult.stdout).toContain("revoked");
  });

  it("fails loudly, naming the id, revoking a link that doesn't exist", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["ask-link", "revoke", "not-a-real-id"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not-a-real-id");
  });

  it("rejects a non-positive --expires-in-hours (0 and negative)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    for (const badValue of ["0", "-1"]) {
      const result = await runCli(["ask-link", "new", "Sam", "--expires-in-hours", badValue], {
        cwd: tempDir(),
        env: { DUO_STORE_PATH: storePath },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--expires-in-hours");
    }
  });

  it("rejects a fractional --expires-in-hours", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["ask-link", "new", "Sam", "--expires-in-hours", "1.5"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--expires-in-hours");
  });

  it("says so on an empty roster", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["ask-link", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No ask links.");
  });
});
