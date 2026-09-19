import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const SQLITE_MAGIC = "SQLite format 3\0";

describe("duo init", () => {
  it("creates an encrypted store outside version control and reports its path", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(storePath);
    expect(existsSync(storePath)).toBe(true);

    const bytes = readFileSync(storePath);
    expect(bytes.subarray(0, SQLITE_MAGIC.length).toString("latin1")).not.toBe(SQLITE_MAGIC);
  });

  it("is idempotent: running it again on an existing store reports it as already existing and doesn't touch it", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const before = readFileSync(storePath);

    const second = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/already exists/i);
    expect(readFileSync(storePath)).toEqual(before);
  });

  it("a subsequent duo status reports the store as existing", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const status = await runCli(["status"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(status.stdout).toContain("store exists: true");
  });

  it("refuses a DUO_STORE_PATH with no directory component, since its data directory would be the cwd itself", async () => {
    const result = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: "duo.db" } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/refusing/i);
    expect(existsSync(join(tempDir(), "duo.db"))).toBe(false);
  });
});
