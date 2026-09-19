import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft } from "../src/drafting/draft-log.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "test-passphrase";

// createEncryptedStore always creates a fresh store, overwriting anything
// already there (the same low-level primitive `duo init` itself guards
// with an existsSync check before calling it) — guarded the same way here
// so a test that already has a store (e.g. one that ran `duo mirror rules
// write` first) doesn't have this helper silently wipe it.
function seedConfidentDraft(storePath: string, question: string, draftText: string): string {
  if (!existsSync(storePath)) {
    createEncryptedStore(storePath, PASSPHRASE);
  }
  return appendDraft(storePath, PASSPHRASE, {
    question,
    threadContext: null,
    draftText,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.9,
    sources: [],
  });
}

describe("duo corrections review — an empty queue says nothing (#38 AC3)", () => {
  it("prints nothing (and exits 0) on a fresh store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);

    const result = await runCli(["corrections", "review"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("duo corrections review / approve / reject (#38)", () => {
  it("lists a queued candidate, approves it, and it no longer appears", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");

    const outcome = await runCli(
      ["draft-outcome", draftId, "edited", "meeting tuesday 3pm main office"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } },
    );
    expect(outcome.exitCode).toBe(0);

    const review = await runCli(["corrections", "review"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: join(tempDir(), "duo") } });
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toMatch(/when is the meeting\?/);
    const idMatch = /^\[([\w-]+)\]/m.exec(review.stdout);
    expect(idMatch).not.toBeNull();
    const candidateId = idMatch![1];

    const approve = await runCli(
      ["corrections", "approve", candidateId],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: join(tempDir(), "duo") } },
    );
    expect(approve.exitCode).toBe(0);
    expect(approve.stdout).toMatch(/voice\.md/);

    const reviewAfter = await runCli(["corrections", "review"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: join(tempDir(), "duo") } });
    expect(reviewAfter.stdout.trim()).toBe("");
  });

  it("rejects a candidate and it never comes back", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");
    await runCli(["draft-outcome", draftId, "edited", "the budget review moved to thursday afternoon"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE },
    });

    const review = await runCli(["corrections", "review"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    const idMatch = /^\[([\w-]+)\]/m.exec(review.stdout);
    const candidateId = idMatch![1];

    const reject = await runCli(["corrections", "reject", candidateId], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(reject.exitCode).toBe(0);
    expect(reject.stdout).toMatch(/Rejected/);

    const reviewAfter = await runCli(["corrections", "review"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(reviewAfter.stdout.trim()).toBe("");
  });

  // Five real CLI subprocess spawns in one test — comfortably under 5s in
  // isolation, but the default 5000ms timeout is tight under full-suite
  // parallel load (many worker processes contending for the same CPU), so
  // this one gets a longer budget rather than a flaky pass/fail.
  it("refuses a conflicting approval without --supersedes, and succeeds with it (#39 AC3)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    const dir = join(tempDir(), "duo");
    const write = await runCli(
      ["mirror", "rules", "write", "--label", "office hours", "--text", "office hours are nine to five, monday to friday"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: dir } },
    );
    expect(write.exitCode).toBe(0);
    const oldRuleIdMatch = /\[([\w-]+)\]/.exec(write.stdout);
    const oldRuleId = oldRuleIdMatch![1];

    const draftId = seedConfidentDraft(storePath, "what are the office hours?", "office hours are flexible this month");
    await runCli(["draft-outcome", draftId, "edited", "office hours are now ten to six every weekday"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: dir },
    });

    const review = await runCli(["corrections", "review"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: dir } });
    expect(review.stdout).toMatch(/Conflicts with an active rule/);
    const candidateIdMatch = /^\[([\w-]+)\]/m.exec(review.stdout);
    const candidateId = candidateIdMatch![1];

    const refused = await runCli(["corrections", "approve", candidateId], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: dir },
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/conflicts with active rule/);

    const approved = await runCli(["corrections", "approve", candidateId, "--supersedes", oldRuleId], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE, DUO_DIR: dir },
    });
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toMatch(/wrote rule/);
  }, 20000);

  it("fails loudly, naming the id, for an unknown candidate", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);

    const result = await runCli(["corrections", "reject", "not-a-real-id"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not-a-real-id/);
  });
});
