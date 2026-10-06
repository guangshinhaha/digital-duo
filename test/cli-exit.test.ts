import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEncryptedStore } from "../src/store/store.js";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "test-passphrase";

/**
 * The bounded time #285 asked for: a real `duo` invocation must exit on
 * its own well inside this, not merely print its output and then sit at
 * 0% CPU forever. 10s is generous for a `tsx`-loaded subprocess (observed
 * cold-start cost alone is 1.5-2.5s under normal load) — a regression here
 * reproduces as "never exits," not "exits a little slower," so this isn't
 * a tight timing assertion chasing a race, just a ceiling nowhere near
 * either side of that gap.
 */
const EXIT_BUDGET_MS = 10_000;

/**
 * Runs one CLI invocation and asserts it exits (any exit code — the bug was
 * "never exits", not "exits wrong") within `EXIT_BUDGET_MS`. `runCli`
 * resolves only once the child process's `close` event fires, so this is a
 * real assertion on process lifetime, not just on the printed output: a
 * regression here hangs this test until vitest's own timeout kills it,
 * which is also a failure, just a slower one — the explicit elapsed-time
 * check below is what turns that into a fast, readable failure instead.
 */
async function assertExitsPromptly(args: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const start = Date.now();
  await runCli(args, { cwd, env });
  const elapsedMs = Date.now() - start;
  expect(elapsedMs, `\`duo ${args.join(" ")}\` took ${elapsedMs}ms to exit`).toBeLessThan(EXIT_BUDGET_MS);
}

describe("every duo CLI subcommand exits on its own once its work is done (#285)", () => {
  it(
    "escalations history",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["escalations", "history"], tempDir(), { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE });
    },
    EXIT_BUDGET_MS + 5000,
  );

  it(
    "corrections approve <id> (including the not-found error path — the bug reproduced after printed output either way)",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["corrections", "approve", "not-a-real-id"], tempDir(), {
        DUO_STORE_PATH: storePath,
        DUO_PASSPHRASE: PASSPHRASE,
      });
    },
    EXIT_BUDGET_MS + 5000,
  );

  it(
    "trust promote <topic> <tier> --accept",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["trust", "promote", "topic-a", "T0", "--accept"], tempDir(), {
        DUO_STORE_PATH: storePath,
        DUO_PASSPHRASE: PASSPHRASE,
      });
    },
    EXIT_BUDGET_MS + 5000,
  );

  it(
    "continuity end <name> --yes",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["continuity", "end", "someone", "--yes"], tempDir(), {
        DUO_STORE_PATH: storePath,
        DUO_PASSPHRASE: PASSPHRASE,
      });
    },
    EXIT_BUDGET_MS + 5000,
  );

  it(
    "continuity transfer list",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["continuity", "transfer", "list"], tempDir(), { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE });
    },
    EXIT_BUDGET_MS + 5000,
  );

  it(
    "ask-link revoke <id>",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["ask-link", "revoke", "not-a-real-id"], tempDir(), { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE });
    },
    EXIT_BUDGET_MS + 5000,
  );

  it(
    "a plain read command (status) exits promptly too, as a control",
    async () => {
      const storePath = join(tempDir(), "data", "duo.db");
      createEncryptedStore(storePath, PASSPHRASE);
      await assertExitsPromptly(["status"], tempDir(), { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE });
    },
    EXIT_BUDGET_MS + 5000,
  );
});
