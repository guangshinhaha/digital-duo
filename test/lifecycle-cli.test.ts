import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function env(storePath: string, extra: Record<string, string> = {}): Record<string, string> {
  return { DUO_STORE_PATH: storePath, DUO_DIR: join(tempDir(), "duo"), ...extra };
}

describe("duo continuity archive", () => {
  it("archives the duo, then duo draft refuses and points at duo continuity consult", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const init = await runCli(["init"], { cwd: tempDir(), env: env(storePath) });
    expect(init.exitCode).toBe(0);

    const archive = await runCli(["continuity", "archive", "Dana Cole"], { cwd: tempDir(), env: env(storePath) });
    expect(archive.exitCode).toBe(0);
    expect(archive.stdout).toContain("Archived by Dana Cole");

    const draft = await runCli(["draft", "how much leave do I get"], { cwd: tempDir(), env: env(storePath) });
    expect(draft.exitCode).not.toBe(0);
    expect(draft.stderr).toContain("Dana Cole");
    expect(draft.stderr).toContain("duo continuity consult");
  });
});

describe("duo continuity orphan", () => {
  it("declines both duo draft and duo continuity consult once declared orphaned", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const init = await runCli(["init"], { cwd: tempDir(), env: env(storePath) });
    expect(init.exitCode).toBe(0);

    const orphan = await runCli(["continuity", "orphan", "Bob", "owner left with nothing handed over"], {
      cwd: tempDir(),
      env: env(storePath),
    });
    expect(orphan.exitCode).toBe(0);
    expect(orphan.stdout).toContain("Declared orphaned by Bob");

    const draft = await runCli(["draft", "how much leave do I get"], { cwd: tempDir(), env: env(storePath) });
    expect(draft.exitCode).not.toBe(0);
    expect(draft.stderr).toContain("no accountable owner");

    const predecessorDuoDir = join(tempDir(), "duo");
    const consult = await runCli(["continuity", "consult", storePath, predecessorDuoDir, "Bob", "how much leave do I get"], {
      cwd: tempDir(),
      env: env(storePath),
    });
    expect(consult.exitCode).not.toBe(0);
    expect(consult.stderr).toContain("no accountable owner");
  });
});

describe("duo continuity transfer", () => {
  it("stays pending after one confirmation, then completes after both", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const initiate = await runCli(["continuity", "transfer", "initiate", "Alice", "Bob"], { cwd: tempDir(), env: env(storePath) });
    expect(initiate.exitCode).toBe(0);
    expect(initiate.stdout).toContain("pending both confirmations");
    const transferId = initiate.stdout.match(/Transfer "([^"]+)"/)?.[1];
    expect(transferId).toBeTruthy();

    const first = await runCli(["continuity", "transfer", "confirm", transferId!, "Alice"], { cwd: tempDir(), env: env(storePath) });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("still awaiting the other party");

    const second = await runCli(["continuity", "transfer", "confirm", transferId!, "Bob"], { cwd: tempDir(), env: env(storePath) });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("completed");

    const list = await runCli(["continuity", "transfer", "list"], { cwd: tempDir(), env: env(storePath) });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("Alice -> Bob");
    expect(list.stdout).toContain("completed");
  });

  it("refuses a third party's confirmation", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const initiate = await runCli(["continuity", "transfer", "initiate", "Alice", "Bob"], { cwd: tempDir(), env: env(storePath) });
    const transferId = initiate.stdout.match(/Transfer "([^"]+)"/)?.[1];

    const result = await runCli(["continuity", "transfer", "confirm", transferId!, "Carol"], { cwd: tempDir(), env: env(storePath) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not a party");
  });
});

describe("duo continuity end", () => {
  it("without --yes describes what would be deleted and deletes nothing; with --yes deletes everything and reports it", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    const init = await runCli(["init"], { cwd: tempDir(), env: env(storePath) });
    expect(init.exitCode).toBe(0);

    const describe = await runCli(["continuity", "end", "Dana Cole"], { cwd: tempDir(), env: env(storePath) });
    expect(describe.exitCode).toBe(0);
    expect(describe.stdout).toContain("Would delete");
    expect(existsSync(storePath)).toBe(true);

    const end = await runCli(["continuity", "end", "Dana Cole", "--yes"], { cwd: tempDir(), env: env(storePath) });
    expect(end.exitCode).toBe(0);
    expect(end.stdout).toContain("Ended by Dana Cole");
    expect(end.stdout).toContain("Nothing recoverable remains");
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(duoDir)).toBe(false);
  });
});
