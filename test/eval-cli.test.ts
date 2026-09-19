import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

async function initStore(storePath: string, cwd: string): Promise<void> {
  const result = await runCli(["init"], { cwd, env: { DUO_STORE_PATH: storePath } });
  expect(result.exitCode).toBe(0);
}

describe("duo eval offline (#35)", () => {
  it("refuses to run without an initialized store, naming duo init", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const result = await runCli(["eval", "offline"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo init/);
  });

  it("refuses an empty store's corpus as too short, naming the span needed — no Ollama required", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const result = await runCli(["eval", "offline"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/shorter than/i);
    expect(result.stderr).toMatch(/day\(s\)/);
  });

  it("rejects a non-numeric --sample or --seed with a clear message, rather than silently coercing it", async () => {
    const storePath = join(tempDir(), "data", "duo.db");
    await initStore(storePath, tempDir());

    const badSample = await runCli(["eval", "offline", "--sample", "abc"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(badSample.exitCode).not.toBe(0);
    expect(badSample.stderr).toMatch(/--sample/);

    const badSeed = await runCli(["eval", "offline", "--seed", "abc"], { cwd: tempDir(), env: { DUO_STORE_PATH: storePath } });
    expect(badSeed.exitCode).not.toBe(0);
    expect(badSeed.stderr).toMatch(/--seed/);
  });
});

describe("duo eval gate (#36)", () => {
  it("refuses when no label set exists at the configured path", async () => {
    const result = await runCli(["eval", "gate"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: join(tempDir(), "data", "duo.db"), DUO_EVAL_GATE_LABELS_PATH: join(tempDir(), "nope.json") },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/nope\.json/);
  });

  it("prints precision, recall, and coverage by mention type, and exits 0 when the floor is met", async () => {
    const labelsPath = join(tempDir(), "labels.json");
    writeFileSync(
      labelsPath,
      JSON.stringify([
        { id: "q1", mentionType: "genuine_question", expected: "answerable", text: "can you review this by EOD?" },
        { id: "t1", mentionType: "thanks", expected: "not_answerable", text: "thanks so much!" },
      ]),
      "utf8",
    );

    const result = await runCli(["eval", "gate"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: join(tempDir(), "data", "duo.db"), DUO_EVAL_GATE_LABELS_PATH: labelsPath },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/precision 1\.000/);
    expect(result.stdout).toMatch(/recall 1\.000/);
    expect(result.stdout).toMatch(/genuine_question: 1/);
    expect(result.stdout).toMatch(/thanks: 1/);
    expect(result.stdout).toMatch(/floor.*met/i);
  });

  it("fails loudly, naming the false positive, when precision drops below the configured floor (#36 AC2)", async () => {
    const labelsPath = join(tempDir(), "labels.json");
    writeFileSync(
      labelsPath,
      JSON.stringify([
        { id: "q1", mentionType: "genuine_question", expected: "answerable", text: "can you review this by EOD?" },
        // A question-shaped mention hand-labelled as not really answerable — a real false positive against classifyMention's keyword heuristic.
        { id: "r1", mentionType: "rhetorical_question", expected: "not_answerable", text: "Why does this always happen?" },
      ]),
      "utf8",
    );

    const result = await runCli(["eval", "gate"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: join(tempDir(), "data", "duo.db"), DUO_EVAL_GATE_LABELS_PATH: labelsPath },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/precision/i);
    expect(result.stderr).toMatch(/r1/);
    // AC3: coverage is still printed even though the run fails on the floor.
    expect(result.stdout).toMatch(/genuine_question: 1/);
    expect(result.stdout).toMatch(/rhetorical_question: 1/);
  });

  it("flags an under-represented mention type", async () => {
    const labelsPath = join(tempDir(), "labels.json");
    writeFileSync(
      labelsPath,
      JSON.stringify([
        { id: "t1", mentionType: "thanks", expected: "not_answerable", text: "thanks!" },
        { id: "t2", mentionType: "thanks", expected: "not_answerable", text: "cheers!" },
        { id: "t3", mentionType: "thanks", expected: "not_answerable", text: "no worries!" },
        { id: "f1", mentionType: "fyi", expected: "not_answerable", text: "fyi, done." },
      ]),
      "utf8",
    );

    const result = await runCli(["eval", "gate"], {
      cwd: tempDir(),
      env: { DUO_STORE_PATH: join(tempDir(), "data", "duo.db"), DUO_EVAL_GATE_LABELS_PATH: labelsPath },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/under-represented/i);
    expect(result.stdout).toMatch(/fyi/);
  });
});
