import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("duo status", () => {
  it("with no env configured, reports (not configured), the default store path, and store exists: false; exits 0", async () => {
    const result = await runCli(["status"], { cwd: tempDir, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider: (not configured)");
    expect(result.stdout).toContain("store: data/duo.db");
    expect(result.stdout).toContain("store exists: false");
  });

  it("reports the configured provider name", async () => {
    const result = await runCli(["status"], {
      cwd: tempDir,
      env: { DUO_PROVIDER: "ollama", DUO_OLLAMA_MODEL: "llama3" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider: ollama");
  });

  it("reports store exists: true when the configured store path exists", async () => {
    const storePath = join(tempDir, "duo.db");
    writeFileSync(storePath, "");
    const result = await runCli(["status"], { cwd: tempDir, env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("store exists: true");
  });
});

describe("duo --help", () => {
  it("Covers R2: lists both status and ask", async () => {
    const result = await runCli(["--help"], { cwd: tempDir, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/status/);
    expect(result.stdout).toMatch(/ask/);
  });
});
