import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

describe("duo continuity handover", () => {
  it("generates an honest, thin draft on a fresh store, then shares a document naming what it could not cover", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const init = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(init.exitCode).toBe(0);

    const generate = await runCli(["continuity", "handover", "generate"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(generate.exitCode).toBe(0);
    expect(generate.stdout).toContain("Recurring questions: 0");
    expect(generate.stdout).toContain("What this pack could not cover:");

    const outputPath = join(tempDir(), "shared", "handover.md");
    const share = await runCli(["continuity", "handover", "share", outputPath], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(share.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain("What this pack could not cover");
  });

  it("refuses to share before a draft has ever been generated", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const init = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(init.exitCode).toBe(0);

    const share = await runCli(["continuity", "handover", "share", join(tempDir(), "out.md")], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(share.exitCode).not.toBe(0);
    expect(share.stderr).toMatch(/generate/);
  });
});
