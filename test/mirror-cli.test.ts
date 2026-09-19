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

describe("duo mirror refusals", () => {
  it("says plainly that no decision has been recorded yet, before anything exists (AC2)", async () => {
    const duoDirPath = join(tempDir(), "duo");
    const result = await runCli(["mirror", "refusals", "list"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no decision about refusals/i);
    expect(result.stdout).toMatch(/asked once, explicitly/i);
  });

  it("records a refusal, which then shows up in the listing (AC1)", async () => {
    const duoDirPath = join(tempDir(), "duo");
    const add = await runCli(["mirror", "refusals", "add", "Headcount", "Never speak for me on comp or headcount."], {
      cwd: tempDir(),
      env: { DUO_DIR: duoDirPath },
    });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toMatch(/recorded 1 refusal/i);

    const list = await runCli(["mirror", "refusals", "list"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(/Headcount/);
    expect(list.stdout).toMatch(/Never speak for me on comp or headcount/);
  });

  it("records a deliberate choice of none, distinct from never having been asked (AC2)", async () => {
    const duoDirPath = join(tempDir(), "duo");
    const confirm = await runCli(["mirror", "refusals", "confirm-none"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(confirm.exitCode).toBe(0);

    const list = await runCli(["mirror", "refusals", "list"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(/deliberately recorded no refusals/i);
  });

  it("refuses confirm-none when refusals already exist, without discarding them", async () => {
    const duoDirPath = join(tempDir(), "duo");
    await runCli(["mirror", "refusals", "add", "Headcount", "reason"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });

    const confirm = await runCli(["mirror", "refusals", "confirm-none"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(confirm.exitCode).not.toBe(0);
    expect(confirm.stderr).toMatch(/already recorded/i);

    const list = await runCli(["mirror", "refusals", "list"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(list.stdout).toMatch(/Headcount/);
  });

  it("surfaces a rule the refusal now suppresses in `duo mirror rules list` (AC3)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());

    const write = await runCli(
      ["mirror", "rules", "write", "--label", "Headcount", "--text", "some rule"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath } },
    );
    expect(write.exitCode).toBe(0);

    // A refusal on the exact same label, added after the rule was already approved.
    await runCli(["mirror", "refusals", "add", "Headcount", "Never speak for me on this."], {
      cwd: tempDir(),
      env: { DUO_DIR: duoDirPath },
    });

    const list = await runCli(["mirror", "rules", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath } });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(/suppressed by a standing refusal/i);
    expect(list.stdout).toMatch(/Never speak for me on this/);
  });
});

describe("duo mirror calibrate", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["mirror", "calibrate"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("refuses to start before a refusals decision has been recorded (#30 AC2, tying into #29's gate)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());

    const result = await runCli(["mirror", "calibrate"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no decision about refusals/i);
  });

  it("reports insufficient history on an empty store once refusals have been decided", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    const confirm = await runCli(["mirror", "refusals", "confirm-none"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });
    expect(confirm.exitCode).toBe(0);

    const result = await runCli(["mirror", "calibrate"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/not enough held-out history/i);
  });

  it("refuses to judge or summarize when no calibration session exists yet", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    await runCli(["mirror", "refusals", "confirm-none"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });

    const judge = await runCli(["mirror", "calibrate", "judge", "some-id", "--approve"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(judge.exitCode).not.toBe(0);
    expect(judge.stderr).toMatch(/no calibration session/i);

    const summary = await runCli(["mirror", "calibrate", "summary"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(summary.exitCode).not.toBe(0);
    expect(summary.stderr).toMatch(/no calibration session/i);
  });

  it("rejects a judge call missing exactly one of --approve/--reject/--edit", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDirPath = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    await runCli(["mirror", "refusals", "confirm-none"], { cwd: tempDir(), env: { DUO_DIR: duoDirPath } });

    const result = await runCli(["mirror", "calibrate", "judge", "some-id"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_DIR: duoDirPath },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/exactly one of --approve, --reject, or --edit/i);
  });
});
