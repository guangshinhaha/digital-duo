import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

async function escalate(storePath: string, cwd: string, question: string): Promise<void> {
  const result = await runCli(["draft", question], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toMatch(/escalated/i);
}

describe("duo escalations digest / check / rate / history (#46)", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    for (const sub of [["digest"], ["check"], ["rate"], ["history"]]) {
      const result = await runCli(["escalations", ...sub], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/duo init/);
    }
  });

  it("sends nothing on an empty store, then a real digest once escalations exist, then nothing again", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const emptyDigest = await runCli(["escalations", "digest"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(emptyDigest.exitCode).toBe(0);
    expect(emptyDigest.stdout).toMatch(/nothing to digest/i);

    await escalate(storePath, tempDir(), "how much vacation leave do I get");
    await escalate(storePath, tempDir(), "what is the printer's ip address");

    const sentDigest = await runCli(["escalations", "digest"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(sentDigest.exitCode).toBe(0);
    expect(sentDigest.stdout).toMatch(/2 escalation\(s\)/);
    expect(sentDigest.stdout).toMatch(/how much vacation leave do I get/);
    expect(sentDigest.stdout).toMatch(/what is the printer's ip address/);

    const secondDigest = await runCli(["escalations", "digest"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(secondDigest.stdout).toMatch(/nothing to digest/i);

    const history = await runCli(["escalations", "history"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toMatch(/2 escalation\(s\)/);
  });

  it("reports no urgent escalations by default, then one after an objectively severe question, exactly once", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const emptyCheck = await runCli(["escalations", "check"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(emptyCheck.stdout).toMatch(/no urgent escalations/i);

    await escalate(storePath, tempDir(), "production is down, nobody can log in");

    const firstCheck = await runCli(["escalations", "check"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(firstCheck.stdout).toMatch(/1 urgent escalation/i);
    expect(firstCheck.stdout).toMatch(/production is down/);

    const secondCheck = await runCli(["escalations", "check"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(secondCheck.stdout).toMatch(/no urgent escalations/i);

    // Never shows up in the ordinary digest either.
    const digest = await runCli(["escalations", "digest"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(digest.stdout).toMatch(/nothing to digest/i);
  });

  it("reports the all-time urgent rate, honestly zero on an empty store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const emptyRate = await runCli(["escalations", "rate"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(emptyRate.stdout).toMatch(/no escalations classified/i);

    await escalate(storePath, tempDir(), "how much vacation leave do I get");
    await escalate(storePath, tempDir(), "production is down, nobody can log in");

    const rate = await runCli(["escalations", "rate"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(rate.stdout).toMatch(/1\/2 escalation\(s\) classified urgent \(50\.0%\)/);
  });
});
