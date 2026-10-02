import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, getDraft } from "../src/drafting/draft-log.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "test-passphrase";

/** Seeds a confident (non-escalated) draft directly, since a real `duo draft` always escalates on an empty store — #37's classification only matters once there's a draft with real text to diff against. */
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

  it("refuses to record a second outcome on an already-settled draft, naming what it has (#262)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const draftResult = await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const idMatch = /draft id ([\w-]+)/.exec(draftResult.stderr);
    const draftId = idMatch![1];

    const first = await runCli(["draft-outcome", draftId, "discarded"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(first.exitCode).toBe(0);

    const second = await runCli(["draft-outcome", draftId, "sent"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/already recorded as "discarded"/);
  });
});

describe("duo draft-outcome sent — the CLI reaches the same delivery seam as the daemon (#170)", () => {
  it("a channel draft sent from the CLI records an honest delivery failure — the CLI process has no connected adapter", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "how do I get deploy access?",
      threadContext: null,
      draftText: "point them at the runbook",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "channel", channelKind: "slack", askerRef: "directory.json#sam", threadId: null, permalink: null },
    });

    const result = await runCli(["draft-outcome", draftId, "sent"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(result.exitCode).toBe(0);

    // Not an error — the outcome stands and the failure is recorded against
    // the draft, exactly as a daemon-side transport failure would be.
    const draft = getDraft(storePath, PASSPHRASE, draftId);
    expect(draft?.outcome).toBe("sent");
    expect(draft?.delivery).toMatchObject({ state: "failed" });
    if (draft?.delivery?.state === "failed") {
      expect(draft.delivery.reason).toContain("slack");
    }
  });

  it("running `duo draft-outcome sent` again after a failed delivery is a retry, not a second disposition — it is not refused (#262)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "how do I get deploy access?",
      threadContext: null,
      draftText: "point them at the runbook",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "channel", channelKind: "slack", askerRef: "directory.json#sam", threadId: null, permalink: null },
    });

    const first = await runCli(["draft-outcome", draftId, "sent"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(first.exitCode).toBe(0);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toMatchObject({ state: "failed" });

    // The CLI process never has a connected adapter, so this retry fails to
    // deliver again too — the point is only that it is *allowed to try*,
    // rather than refused as an already-settled draft.
    const retry = await runCli(["draft-outcome", draftId, "sent"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(retry.exitCode).toBe(0);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toMatchObject({ state: "failed" });
  });

  it("an owner draft sent from the CLI records no delivery at all", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what do I think about X?",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "owner" },
    });

    const result = await runCli(["draft-outcome", draftId, "sent"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(result.exitCode).toBe(0);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.delivery).toBeNull();
  });
});

describe("duo draft-outcome edited <sentText> — classifies the edit and queues a correction candidate (#37)", () => {
  it("classifies a style-only edit and queues nothing but a voice-profile-shaped candidate", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");

    const result = await runCli(
      ["draft-outcome", draftId, "edited", "meeting tuesday 3pm main office"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/classified as "style"/);
    expect(result.stdout).toMatch(/queued: style/);
  });

  it("classifies a substance edit and queues a standing-order-shaped candidate", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "when is the meeting?", "the meeting is on tuesday at 3pm in the main office");

    const result = await runCli(
      ["draft-outcome", draftId, "edited", "the budget review moved to thursday afternoon"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/classified as "substance"/);
    expect(result.stdout).toMatch(/queued: substance/);
  });

  it("does not classify at all when no sent text is given for a plain edited outcome", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "q", "a draft");

    const result = await runCli(["draft-outcome", draftId, "edited"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/classified/);
  });

  it("still records the outcome, without erroring, against an escalated draft that has no draft text to classify", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
    });

    const result = await runCli(
      ["draft-outcome", draftId, "edited", "some answer"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Recorded draft .* as edited/);
    expect(result.stdout).not.toMatch(/classified/);
  });

  it("reports a trivial edit and queues nothing", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "is that right?", "Yes, that's correct.");

    const result = await runCli(
      ["draft-outcome", draftId, "edited", "Yes, that's correct"],
      { cwd: tempDir(), env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/trivial/);
  });

  it("rejects a whitespace-only sentText for \"edited\" — the daemon route's blank-edit guard also covers this CLI entry point (they share recordDraftOutcomeAndClassify)", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const draftId = seedConfidentDraft(storePath, "is that right?", "Yes, that's correct.");

    const result = await runCli(["draft-outcome", draftId, "edited", "   "], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_PASSPHRASE: PASSPHRASE },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/blank/i);
  });
});

describe("duo draft — a refused subject escalates citing the refusal (#34 AC2)", () => {
  it("cites duo/refusals.md rather than drafting anything", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const duoDir = join(tempDir(), "duo");
    await initStore(storePath, tempDir());
    mkdirSync(duoDir, { recursive: true });
    // duo/refusals.md's one real format (../src/trust/refusals.ts, #53/#29):
    // "## <subject>" headings with a reason body.
    writeFileSync(join(duoDir, "refusals.md"), "## salary\n\nNever speak for me on this.\n", "utf8");

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

describe("duo drafts list — the Review surface's read side (client-tech-design.md G-a)", () => {
  it("says so on an empty store", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["drafts", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No drafts.");
  });

  it("lists a drafted question with its confidence and id", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["drafts", "list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("what is the meaning of life");
    expect(result.stdout).toMatch(/\[[\w-]+\]/);
  });

  it("--pending excludes a draft once its outcome is recorded", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const draftResult = await runCli(["draft", "what is the meaning of life"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    const idMatch = /draft id ([\w-]+)/.exec(draftResult.stderr);
    const draftId = idMatch![1];
    await runCli(["draft-outcome", draftId, "discarded"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });

    const result = await runCli(["drafts", "list", "--pending"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No drafts.");
  });

  it("refuses an unrecognized --outcome value", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["drafts", "list", "--outcome", "not-a-real-outcome"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--outcome must be one of/);
  });
});

describe("duo list — every duo this process can currently reach", () => {
  it("lists only the personal duo when no shared duo is configured", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["list"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("personal");
    expect(result.stdout).not.toContain("shared");
  });

  it("also lists the shared duo once shared-duo/persona.json is configured", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());
    const personaPath = join(tempDir(), "shared-duo", "persona.json");
    mkdirSync(join(tempDir(), "shared-duo"), { recursive: true });
    writeFileSync(
      personaPath,
      JSON.stringify({
        id: "shared-duo",
        owner: { kind: "person", id: "alex", name: "Alex" },
        persona: { voice: "plain" },
        standingOrders: [],
        refusals: [],
        knowledge: { kind: "authored", documents: [] },
      }),
    );

    const result = await runCli(["list"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: storePath, DUO_SHARED_PERSONA_PATH: personaPath },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("personal");
    expect(result.stdout).toContain("shared");
    expect(result.stdout).toContain("Alex");
  });
});
