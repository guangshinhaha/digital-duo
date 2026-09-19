import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

describe("duo continuity consult", () => {
  it("refuses to run against a predecessor store that hasn't been initialized, naming duo init", async () => {
    const predecessorStorePath = join(tempDir(), "predecessor", "data", "duo.db");
    const predecessorDuoDir = join(tempDir(), "predecessor", "duo");

    const result = await runCli(
      ["continuity", "consult", predecessorStorePath, predecessorDuoDir, "Alice", "how many days of leave do I get"],
      { cwd: tempDir(), env: {} },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("escalates by name when the predecessor's store has nothing to answer from", async () => {
    const predecessorStorePath = join(tempDir(), "predecessor", "data", "duo.db");
    const predecessorDuoDir = join(tempDir(), "predecessor", "duo");

    const init = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: predecessorStorePath } });
    expect(init.exitCode).toBe(0);

    const result = await runCli(
      ["continuity", "consult", predecessorStorePath, predecessorDuoDir, "Alice", "how many days of leave do I get"],
      { cwd: tempDir(), env: {} },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Alice's duo has nothing dated to answer this from");
  });
});
