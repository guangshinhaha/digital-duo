import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { writeTopicsFile } from "../src/derivation/topics.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

function seedTopics(duoDir: string, topics: { id: string; label: string }[]): void {
  writeTopicsFile(
    duoDir,
    topics.map((topic) => ({ ...topic, createdAt: "2026-01-01T00:00:00.000Z" })),
  );
}

describe("duo trust grid", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["trust", "grid"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("reports no cells have moved yet on a fresh store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["trust", "grid"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no cell has moved/i);
  });
});

describe("duo trust grant", () => {
  it("applies immediately and shows up in duo trust grid", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    seedTopics(duoDir, [{ id: "topic-deploy", label: "Deploy access" }]);

    const grantResult = await runCli(["trust", "grant", "deploy access questions", "--tier", "T0"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(grantResult.exitCode).toBe(0);
    expect(grantResult.stdout).toMatch(/Granted T0 autonomy on "Deploy access"/);

    const gridResult = await runCli(["trust", "grid"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir } });
    expect(gridResult.stdout).toMatch(/topic-deploy.*T0.*auto \(granted\).*Deploy access/);
  });

  it("shows candidates and exits non-zero on an ambiguous scope, changing nothing", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    seedTopics(duoDir, [
      { id: "topic-a", label: "deploy access" },
      { id: "topic-b", label: "deploy access" },
    ]);

    const result = await runCli(["trust", "grant", "deploy access", "--tier", "T0"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/could refer to more than one topic/i);
    expect(result.stdout).toMatch(/topic-a/);
    expect(result.stdout).toMatch(/topic-b/);
  });

  it("refuses a grant that conflicts with duo/refusals.md, naming the refusal", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    seedTopics(duoDir, [{ id: "topic-headcount", label: "Headcount" }]);
    mkdirSync(duoDir, { recursive: true });
    writeFileSync(join(duoDir, "refusals.md"), "## Headcount\nNever speak for me on this.\n", "utf8");

    const result = await runCli(["trust", "grant", "headcount questions", "--tier", "T0"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Refused/);
    expect(result.stderr).toMatch(/Headcount/);
  });

  it("rejects an invalid tier before touching the store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["trust", "grant", "anything", "--tier", "T9"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not a valid trust tier/i);
  });
});
