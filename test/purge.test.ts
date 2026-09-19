import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

describe("duo purge", () => {
  it("without --yes on a populated store: describes what would be deleted, exits non-zero, and deletes nothing", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["purge"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/would delete/i);
    expect(result.stdout).toContain("duo.db");
    expect(existsSync(storePath)).toBe(true);
  });

  it("with --yes: removes every database file and derived artifact, and a second duo status reports no store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["purge", "--yes"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(dirname(storePath))).toBe(false);

    const status = await runCli(["status"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(status.stdout).toContain("store exists: false");
  });

  it("also removes staging databases and the passphrase file alongside the store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dirname(storePath), "import-42.staging.db"), "staging bytes");

    const result = await runCli(["purge", "--yes"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(existsSync(dirname(storePath))).toBe(false);
  });

  it("with no store at all: reports nothing to purge and exits 0, with or without --yes", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["purge"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/nothing to purge/i);
  });

  it("refuses to purge when DUO_STORE_PATH's data directory would be the cwd itself, even with --yes", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tempDir(), "unrelated-project-file.txt"), "do not delete me");

    const result = await runCli(["purge", "--yes"], { cwd: tempDir(), env: { DUO_STORE_PATH: "duo.db" } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/refusing/i);
    expect(existsSync(join(tempDir(), "unrelated-project-file.txt"))).toBe(true);
  });
});
