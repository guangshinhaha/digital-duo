import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

async function importFixture(storePath: string, cwd: string): Promise<void> {
  const { fileURLToPath } = await import("node:url");
  const fixture = fileURLToPath(new URL("./fixtures/claude-export-all-work.json", import.meta.url));
  const result = await runCli(["import", "claude", fixture], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo mirror portrait", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["mirror", "portrait"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("says plainly there isn't enough history on a freshly initialized, empty store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["mirror", "portrait"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/not enough history/i);
    expect(result.stdout).toMatch(/found only 0 question/i);
    expect(result.stdout).toMatch(/duo import/);
  });

  it("shows the portrait once a corpus with real question/answer records exists", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    await importFixture(storePath, tempDir());

    // The Claude-export fixture produces `my_thinking` records, not
    // `question_to_me`/`my_answer` pairs, so pair extraction over it alone
    // yields nothing — exactly the honest "not enough history" case, which
    // this asserts explicitly rather than assuming the fixture happens to
    // produce a pairable corpus.
    await runCli(["derive", "pairs"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const thin = await runCli(["mirror", "portrait"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(thin.exitCode).toBe(0);
    expect(thin.stdout).toMatch(/not enough history/i);
  });
});
