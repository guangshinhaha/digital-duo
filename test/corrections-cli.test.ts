import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft } from "../src/drafting/draft-log.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "test-passphrase";

function seedConfidentDraft(storePath: string, question: string, draftText: string): string {
  createEncryptedStore(storePath, PASSPHRASE);
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

  it("fails loudly, naming the id, for an unknown candidate", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);

    const result = await runCli(["corrections", "reject", "not-a-real-id"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not-a-real-id/);
  });
});
