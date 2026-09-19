import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

async function importFixture(storePath: string, cwd: string): Promise<void> {
  const fixture = fileURLToPath(new URL("./fixtures/claude-export-all-work.json", import.meta.url));
  const result = await runCli(["import", "claude", fixture], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

function writeDirectory(duoDir: string, entries: unknown): void {
  mkdirSync(duoDir, { recursive: true });
  writeFileSync(join(duoDir, "directory.json"), JSON.stringify(entries), "utf8");
}

describe("duo permissions ask", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["permissions", "ask", "anything", "--as", "alice"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("declines, without an inference provider configured, when nothing in the store informs the answer", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["permissions", "ask", "what is the vacation policy?", "--as", "anyone"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("I don't have anything I can share with you on that.");
    expect(result.stderr).toMatch(/declined/i);
  });

  it("declines a low-clearance asker even though a matching record exists, because it's unmarked and requires top clearance", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    await importFixture(storePath, tempDir());
    writeDirectory(duoDir, [{ id: "low", name: "Low", clearance: "official_open" }]);

    // The imported fixture carries no classification marking at all, so
    // it's "unknown" — invisible to anyone below top clearance (#48).
    const result = await runCli(["permissions", "ask", "incident report outage", "--as", "low"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("I don't have anything I can share with you on that.");
  });

  it("answers a top-clearance asker from the visible record text when no inference provider is configured", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    await importFixture(storePath, tempDir());
    writeDirectory(duoDir, [{ id: "top", name: "Top", clearance: "secret" }]);

    const result = await runCli(["permissions", "ask", "incident report outage", "--as", "top"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/billing service outage/i);
    expect(result.stderr).not.toMatch(/declined/i);
  });
});
