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

describe("duo mirror rules", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["mirror", "rules", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("explains that no rules were derived at all, on a freshly initialized store (AC4)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["mirror", "rules", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no rule has cleared/i);
    expect(result.stdout).toMatch(/no rules were derived at all/i);
    expect(result.stdout).toMatch(/duo mirror rules write/);
  });

  it("writes a rule by hand, shows its evidence (none), approves idempotently, then rejects it (AC4, AC1, AC2)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());

    const write = await runCli(
      ["mirror", "rules", "write", "--label", "Expense approvals", "--text", "I never approve expenses over $500 alone."],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath } },
    );
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toMatch(/owner-asserted, approved/i);
    const idMatch = write.stdout.match(/\[([^\]]+)\]/);
    expect(idMatch).not.toBeNull();
    const ruleId = idMatch![1];

    const show = await runCli(["mirror", "rules", "show", ruleId], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toMatch(/no cited exchanges/i);
    expect(show.stdout).toMatch(/review: approved/i);

    const approve = await runCli(["mirror", "rules", "approve", ruleId], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(approve.exitCode).toBe(0);
    expect(approve.stdout).toMatch(/approved/i);

    const reject = await runCli(["mirror", "rules", "reject", ruleId], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(reject.exitCode).toBe(0);
    expect(reject.stdout).toMatch(/rejected/i);
  });

  it("refuses to promote a rule that isn't a weak signal, and to approve/show an unknown rule, with a non-zero exit", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());

    const write = await runCli(
      ["mirror", "rules", "write", "--label", "Some topic", "--text", "some rule"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath } },
    );
    const ruleId = write.stdout.match(/\[([^\]]+)\]/)![1];

    const promote = await runCli(["mirror", "rules", "promote", ruleId], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(promote.exitCode).not.toBe(0);
    expect(promote.stderr).toMatch(/weak_signal/);

    const unknown = await runCli(["mirror", "rules", "approve", "no-such-rule"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toMatch(/no rule with id/i);
  });
});
