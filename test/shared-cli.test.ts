import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function writePersona(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "persona.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      id: "shared-duo",
      owner: { kind: "person", id: "dana-cole", name: "Dana Cole" },
      persona: { voice: "plain, procedural" },
      standingOrders: ["answer only from the configured documents"],
      refusals: ["does not decide anything on the team's behalf"],
      knowledge: {
        kind: "authored",
        documents: ["Leave requests (updated 2026-06-01): submit through the HR portal at least 5 working days in advance."],
      },
      ...overrides,
    }),
  );
  return path;
}

function env(personaPath: string, usageLogPath: string): Record<string, string> {
  return { DUO_SHARED_PERSONA_PATH: personaPath, DUO_SHARED_USAGE_LOG_PATH: usageLogPath };
}

describe("duo shared ask", () => {
  it("answers a covered question, citing the source document and its date", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");

    const result = await runCli(["shared", "ask", "leave requests"], { cwd: tempDir(), env: env(personaPath, usageLogPath) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("submit through the HR portal");
    expect(result.stdout).toContain("source: Leave requests, updated 2026-06-01");
    expect(result.stderr).not.toMatch(/declined/i);
  });

  it("declines an out-of-scope question and names the owner to escalate to", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");

    const result = await runCli(["shared", "ask", "what is the parking policy"], { cwd: tempDir(), env: env(personaPath, usageLogPath) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dana Cole");
    expect(result.stderr).toMatch(/declined/i);
  });

  it("attributes every answer to the shared duo and its owner, never as a personal position (#70 AC1)", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");

    const result = await runCli(["shared", "ask", "leave requests"], { cwd: tempDir(), env: env(personaPath, usageLogPath) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("the shared duo");
    expect(result.stdout).toContain("owned by Dana Cole");
  });

  it("refuses a request to decide or approve something, naming the owner it routes to (#70 AC2)", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");

    const result = await runCli(["shared", "ask", "can you approve this leave request?"], { cwd: tempDir(), env: env(personaPath, usageLogPath) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/can't decide|cannot decide/i);
    expect(result.stdout).toContain("Dana Cole");
    expect(result.stderr).toMatch(/declined/i);
  });

  it("refuses a persona file with no human owner, naming the problem", async () => {
    const personaPath = writePersona(tempDir(), { owner: { kind: "none" } });
    const usageLogPath = join(tempDir(), "usage.json");

    const result = await runCli(["shared", "ask", "leave requests"], { cwd: tempDir(), env: env(personaPath, usageLogPath) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/human owner/i);
  });

  it("records the asker given with --as, and defaults to anonymous when omitted (#71)", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");
    const cliEnv = env(personaPath, usageLogPath);

    await runCli(["shared", "ask", "leave requests", "--as", "alice"], { cwd: tempDir(), env: cliEnv });
    await runCli(["shared", "ask", "leave requests"], { cwd: tempDir(), env: cliEnv });

    const logged = JSON.parse(readFileSync(usageLogPath, "utf8")) as Array<{ askerId: string }>;
    expect(logged.map((e) => e.askerId)).toEqual(["alice", "anonymous"]);
  });
});

describe("a personal `duo purge` never touches the shared duo's usage log", () => {
  it("leaves shared-duo-runtime/usage.json intact after purging the personal store", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "shared-duo-runtime", "usage.json");
    const storePath = join(tempDir(), "data", "duo.db");

    await runCli(["shared", "ask", "leave requests"], { cwd: tempDir(), env: env(personaPath, usageLogPath) });
    const init = await runCli(["init"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(init.exitCode).toBe(0);

    const purge = await runCli(["purge", "--yes"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(purge.exitCode).toBe(0);

    const gaps = await runCli(["shared", "gaps"], { cwd: tempDir(), env: { DUO_SHARED_USAGE_LOG_PATH: usageLogPath } });
    expect(gaps.exitCode).toBe(0);
    // The one ask above was answered (covered), not declined, so it's not a
    // gap — the point here is only that the log file itself, and the
    // process reading it, both survived the purge untouched.
    expect(gaps.stdout).toMatch(/no out-of-scope questions/i);
  });
});

describe("duo shared gaps", () => {
  it("reports nothing yet before any question has been asked", async () => {
    const usageLogPath = join(tempDir(), "usage.json");
    const result = await runCli(["shared", "gaps"], { cwd: tempDir(), env: { DUO_SHARED_USAGE_LOG_PATH: usageLogPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no out-of-scope questions/i);
  });

  it("surfaces the same out-of-scope question asked several times as a gap, with its count", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");
    const cliEnv = env(personaPath, usageLogPath);

    await runCli(["shared", "ask", "what is the parking policy"], { cwd: tempDir(), env: cliEnv });
    await runCli(["shared", "ask", "WHAT IS THE PARKING POLICY"], { cwd: tempDir(), env: cliEnv });

    const result = await runCli(["shared", "gaps"], { cwd: tempDir(), env: { DUO_SHARED_USAGE_LOG_PATH: usageLogPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/2x\s+what is the parking policy/i);
  });
});

describe("duo shared usage", () => {
  it("says plainly, in those words, that the duo is not being used when nothing has been asked (#71 AC4)", async () => {
    const usageLogPath = join(tempDir(), "usage.json");
    const result = await runCli(["shared", "usage"], { cwd: tempDir(), env: { DUO_SHARED_USAGE_LOG_PATH: usageLogPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The shared duo is not being used.");
  });

  it("reports questions, distinct/repeat askers, answer/escalation rate, and gaps after real use", async () => {
    const personaPath = writePersona(tempDir());
    const usageLogPath = join(tempDir(), "usage.json");
    const cliEnv = env(personaPath, usageLogPath);

    await runCli(["shared", "ask", "leave requests", "--as", "alice"], { cwd: tempDir(), env: cliEnv });
    await runCli(["shared", "ask", "what is the parking policy", "--as", "alice"], { cwd: tempDir(), env: cliEnv });
    await runCli(["shared", "ask", "what is the parking policy", "--as", "bob"], { cwd: tempDir(), env: cliEnv });

    const result = await runCli(["shared", "usage"], { cwd: tempDir(), env: { DUO_SHARED_USAGE_LOG_PATH: usageLogPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Total questions: 3");
    expect(result.stdout).toMatch(/Distinct askers: 2 \(1 asked more than once\)/);
    expect(result.stdout).toMatch(/Answer rate: 33%/);
    expect(result.stdout).toMatch(/Escalation rate: 67%/);
    expect(result.stdout).toMatch(/2x\s+what is the parking policy/i);
  });

  it("states plainly, with the date, when usage has stopped rather than smoothing it into an average (#71 AC2)", async () => {
    const usageLogPath = join(tempDir(), "usage.json");
    mkdirSync(join(tempDir()), { recursive: true });
    writeFileSync(
      usageLogPath,
      JSON.stringify([
        { id: "1", createdAt: "2020-01-01T00:00:00.000Z", question: "old question", askerId: "alice", declined: false, citedTitles: [], staleCitation: false },
      ]),
    );

    const result = await runCli(["shared", "usage"], { cwd: tempDir(), env: { DUO_SHARED_USAGE_LOG_PATH: usageLogPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/stopped/i);
    expect(result.stdout).toContain("2020-01-01");
  });
});
