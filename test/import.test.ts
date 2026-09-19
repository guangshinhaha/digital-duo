import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countRecords } from "../src/ingest/record-store.js";
import { resolveOrCreatePassphrase } from "../src/store/passphrase.js";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo import claude", () => {
  it("imports every message as a record and reports a count", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["import", "claude", fixturePath("claude-export-all-work.json")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/imported 2 record/i);
    expect(result.stdout).toMatch(/1\/1 work-relevant/);
    expect(countRecords(storePath, resolveOrCreatePassphrase(storePath, {}))).toBe(2);
  });

  it("re-importing the same export does not duplicate records", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const args = ["import", "claude", fixturePath("claude-export-all-work.json")];

    await runCli(args, { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const second = await runCli(args, { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/imported 0 record.*2 already present/i);
    expect(countRecords(storePath, resolveOrCreatePassphrase(storePath, {}))).toBe(2);
  });

  it("only imports the work-relevant conversation from a mixed export, and reports the fraction", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["import", "claude", fixturePath("claude-export-mixed.json")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/1\/2 work-relevant/);
    expect(countRecords(storePath, resolveOrCreatePassphrase(storePath, {}))).toBe(2);
  });

  it("refuses a malformed export, names what was expected, and writes nothing to the store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["import", "claude", fixturePath("claude-export-malformed.json")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/array/i);
    expect(countRecords(storePath, resolveOrCreatePassphrase(storePath, {}))).toBe(0);
  });

  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["import", "claude", fixturePath("claude-export-all-work.json")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });
});

describe("duo import paste", () => {
  it("imports a pasted transcript into the same record shape and reports a count", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["import", "paste", fixturePath("transcript-work.txt")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/imported 3 record/i);
    expect(countRecords(storePath, resolveOrCreatePassphrase(storePath, {}))).toBe(3);
  });

  it("imports nothing for a transcript judged not work-relevant", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["import", "paste", fixturePath("transcript-personal.txt")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/not work-relevant/i);
    expect(countRecords(storePath, resolveOrCreatePassphrase(storePath, {}))).toBe(0);
  });
});
