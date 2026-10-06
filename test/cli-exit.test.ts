import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEncryptedStore } from "../src/store/store.js";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

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

/**
 * The exact regression this file's exit-on-settle fix caused in production
 * (api.digitalduo.world 502, minutes after #290 merged): `duo serve`'s
 * action resolves as soon as `runServe` finishes binding, so an
 * unconditional exit-on-settle kills the daemon the instant it starts
 * listening. `isRunningAsLongLivedServer` in cli.ts is what's supposed to
 * stop that — this asserts the process genuinely keeps running (and
 * keeps answering requests) well past the point every other command above
 * would have already exited, not just that it printed its "listening"
 * line.
 */
it(
  "duo serve keeps running once it's listening, not just prints that it is (regression: #290 killed the daemon seconds after boot)",
  async () => {
    const dir = tempDir();
    const storePath = join(dir, "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    const port = 17000 + Math.floor(Math.random() * 1000);

    const child = spawn(tsxBin, [cliEntry, "serve", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("serve never printed its listening line")), 10_000);
        child.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited (code ${code}) before ever printing its listening line`));
        });
      });

      // The exact window the bug lived in: settle, then die within a tick.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(child.exitCode, "serve exited on its own after settling — the regression is back").toBeNull();

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
    } finally {
      child.kill("SIGKILL");
    }
  },
  15_000,
);
