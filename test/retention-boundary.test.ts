import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

describe("the retention boundary is stated in the repo in the same words the team is told", () => {
  it("duo import --help states it in the same plain words as v1-tech-design.md §1.4", async () => {
    const result = await runCli(["import", "--help"], { cwd: tempDir(), env: {} });
    expect(result.exitCode).toBe(0);
    // Commander wraps help text at a column width, so normalize whitespace
    // before comparing rather than asserting on one unwrapped line.
    const normalized = result.stdout.replace(/\s+/g, " ");
    expect(normalized).toContain("we keep questions put to you, we discard everything else others said");
  });
});
