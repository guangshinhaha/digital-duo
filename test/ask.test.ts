import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "duo-cli-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("duo ask", () => {
  it("Covers R4: with no DUO_PROVIDER set, exits non-zero and names DUO_PROVIDER on stderr", async () => {
    const result = await runCli(["ask", "hello"], { cwd: tempDir, env: {} });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("DUO_PROVIDER");
  });

  it("Covers R4: with DUO_PROVIDER=ollama but no DUO_OLLAMA_MODEL, exits non-zero and names DUO_OLLAMA_MODEL", async () => {
    const result = await runCli(["ask", "hello"], { cwd: tempDir, env: { DUO_PROVIDER: "ollama" } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("DUO_OLLAMA_MODEL");
  });

  it("Covers R4, R5: with Ollama configured but unreachable, exits non-zero, names it unreachable, and prints no completion text", async () => {
    const result = await runCli(["ask", "hello"], {
      cwd: tempDir,
      env: {
        DUO_PROVIDER: "ollama",
        DUO_OLLAMA_MODEL: "llama3",
        // Port 1 is reserved and unroutable, so the connection fails fast.
        DUO_OLLAMA_HOST: "http://127.0.0.1:1",
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unreachable/i);
    expect(result.stdout).toBe("");
  });
});
