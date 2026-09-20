import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo mentions offer (#47)", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["mentions", "offer", "anything?"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("declines a noisy mention without offering anything", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["mentions", "offer", "Thanks so much for the help!"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/gate declined \(noise\)/i);
  });

  it("reports no_draft for a genuine question with nothing to ground a draft in", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["mentions", "offer", "Can you review the budget doc before Friday?"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no draft to offer/i);
  });

  it("makes no offer at all from a muted channel", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    await runCli(["mentions", "mute", "#printer-support"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(
      ["mentions", "offer", "Can you review the budget doc before Friday?", "--channel", "#printer-support"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/muted/i);
  });
});

describe("duo mentions mute / unmute / muted (#47 AC3)", () => {
  it("starts with no channel muted", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["mentions", "muted"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no channel is muted/i);
  });

  it("mutes, lists, then unmutes a channel — visible and reversible", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const muteResult = await runCli(["mentions", "mute", "#eng-support"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(muteResult.exitCode).toBe(0);
    expect(muteResult.stdout).toMatch(/muted "#eng-support"/i);

    const listResult = await runCli(["mentions", "muted"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(listResult.stdout).toContain("#eng-support");

    const unmuteResult = await runCli(["mentions", "unmute", "#eng-support"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(unmuteResult.exitCode).toBe(0);
    expect(unmuteResult.stdout).toMatch(/unmuted "#eng-support"/i);

    const afterResult = await runCli(["mentions", "muted"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(afterResult.stdout).toMatch(/no channel is muted/i);
  });

  it("reports honestly when asked to unmute a channel that was never muted", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["mentions", "unmute", "#never-muted"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/was not muted/i);
  });

  it("mutes a thread within a channel without muting the channel (#172)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const env = { DUO_STORE_PATH: storePath };

    const muteResult = await runCli(["mentions", "mute", "#eng-support", "--thread", "C0123456789.1660000000"], { cwd: tempDir(), env });
    expect(muteResult.exitCode).toBe(0);
    expect(muteResult.stdout).toMatch(/muted/i);

    const listResult = await runCli(["mentions", "muted"], { cwd: tempDir(), env });
    expect(listResult.stdout).toContain("#eng-support/C0123456789.1660000000");

    // The muted thread makes no offer; a different thread in the same
    // channel still can (here: no draft to offer — the channel is not muted).
    const mutedThread = await runCli(
      ["mentions", "offer", "Can you review the budget doc before Friday?", "--channel", "#eng-support", "--thread-id", "C0123456789.1660000000"],
      { cwd: tempDir(), env },
    );
    expect(mutedThread.exitCode).toBe(0);
    expect(mutedThread.stdout).toMatch(/muted/i);

    const otherThread = await runCli(
      ["mentions", "offer", "Can you review the budget doc before Friday?", "--channel", "#eng-support", "--thread-id", "C9999999999.1660000001"],
      { cwd: tempDir(), env },
    );
    expect(otherThread.exitCode).toBe(0);
    expect(otherThread.stdout).not.toMatch(/^Muted/m);
    expect(otherThread.stdout).toMatch(/no draft to offer|gate declined/i);

    const unmuteResult = await runCli(["mentions", "unmute", "#eng-support", "--thread", "C0123456789.1660000000"], { cwd: tempDir(), env });
    expect(unmuteResult.exitCode).toBe(0);
    expect(unmuteResult.stdout).toMatch(/unmuted/i);

    const afterResult = await runCli(["mentions", "muted"], { cwd: tempDir(), env });
    expect(afterResult.stdout).toMatch(/no channel is muted/i);
  });

  it("refuses a thread mute with \"/\" in either part, naming the rule (#172)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const result = await runCli(["mentions", "mute", "#eng/support", "--thread", "C0123456789.1660000000"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/\//);
  });
});
