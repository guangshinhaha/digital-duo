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

describe("duo draft", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["draft", "anything"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("escalates rather than guessing when nothing in the store supports an answer", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/escalate/i);
    expect(result.stderr).toMatch(/escalated — draft id/);
  });

  it("accepts piped-in thread context without hanging or erroring (#32 AC4)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["draft", "is that still true?"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
      stdin: "Alice: what are the office hours?\nMe: 9 to 5, Monday to Friday",
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("duo draft-outcome — the outcome of a draft is recorded (#32 AC3)", () => {
  it("records an outcome against a draft printed by `duo draft`", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const draftResult = await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(draftResult.exitCode).toBe(0);
    const idMatch = /draft id ([\w-]+)/.exec(draftResult.stderr);
    expect(idMatch).not.toBeNull();
    const draftId = idMatch![1];

    const outcomeResult = await runCli(["draft-outcome", draftId, "discarded"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(outcomeResult.exitCode).toBe(0);
    expect(outcomeResult.stdout).toContain("discarded");
  });

  it("refuses an unrecognized outcome value", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const draftResult = await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const idMatch = /draft id ([\w-]+)/.exec(draftResult.stderr);
    const draftId = idMatch![1];

    const result = await runCli(["draft-outcome", draftId, "not-a-real-outcome"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/sent, edited, discarded/);
  });

  it("fails loudly, naming the id, for a draft that doesn't exist", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["draft-outcome", "not-a-real-id", "sent"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not-a-real-id/);
  });
});

describe("duo draft — a refused subject escalates citing the refusal (#34 AC2)", () => {
  it("cites duo/refusals.md rather than drafting anything", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    mkdirSync(duoDir, { recursive: true });
    writeFileSync(join(duoDir, "refusals.md"), "- salary\n", "utf8");

    const result = await runCli(["draft", "what is my salary"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDir } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/salary/);
    expect(result.stderr).toMatch(/refused/);
  });
});

describe("duo draft-answer — an escalation can be turned into a rule on the spot (#34 AC3)", () => {
  it("queues a standing-order candidate from the owner's own answer", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const draftResult = await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const idMatch = /draft id ([\w-]+)/.exec(draftResult.stderr);
    expect(idMatch).not.toBeNull();
    const draftId = idMatch![1];

    const result = await runCli(["draft-answer", draftId, "42, obviously."], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Queued standing-order candidate/);
  });

  it("fails loudly, naming the id, for a draft that doesn't exist", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["draft-answer", "not-a-real-id", "answer"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not-a-real-id/);
  });
});
