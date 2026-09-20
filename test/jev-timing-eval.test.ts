import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runEvalJevStage1 } from "../src/commands/eval.js";
import {
  buildReferenceQuestions,
  runJevTimingPass,
  runOllamaReference,
  runOllamaReferenceSection,
} from "../src/eval/jev-timing-eval.js";
import { binaryResult, choiceResult, createFakeJevProvider } from "./fixtures/fake-jev-provider.js";
import { MULTIWAY_TASKS, REAL_LABELS, perfectScript } from "./helpers/jev-eval-scripts.js";
import type { InferenceProvider, TypedDecisionProvider } from "../src/provider/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRuntimeConfig(extra: Record<string, string> = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "jev-timing-"));
  tempDirs.push(runtimeDir);
  return { config: loadConfig({ DUO_JEV_SPIKE_RUNTIME_DIR: runtimeDir, ...extra }), runtimeDir };
}

/** A provider whose calls cost a scripted number of fake-clock milliseconds. */
function clockScriptedProvider(durationsMs: number[], result: () => ReturnType<typeof binaryResult>): {
  provider: TypedDecisionProvider;
  now: () => number;
} {
  let clock = 1_000;
  let call = 0;
  return {
    now: () => clock,
    provider: {
      name: "clock-jev",
      async decide() {
        const duration = durationsMs[Math.min(call, durationsMs.length - 1)] ?? 0;
        call += 1;
        clock += duration; // the injected clock advances by exactly the scripted duration
        return result();
      },
    },
  };
}

describe("runJevTimingPass — warmup excluded, median honest, dollars from the config constant (R6)", () => {
  const FOUR_TASKS = MULTIWAY_TASKS.slice(0, 4);

  it("excludes the untimed warmup from both mean and median; the median averages the two middle values of an even sample", async () => {
    // Warmup (first call) takes 9_000ms; the four measured calls take
    // 100/200/300/400 — an even-count sample whose median is (200+300)/2.
    const { provider, now } = clockScriptedProvider([9_000, 100, 200, 300, 400], () => binaryResult(0.9));
    const section = await runJevTimingPass(provider, FOUR_TASKS, 0.042, now);

    expect(section.status).toBe("complete");
    expect(section.decisionCount).toBe(4);
    expect(section.meanMsPerDecision).toBe(250);
    expect(section.medianMsPerDecision).toBe(250);
    expect(section.totalWallMs).toBe(1_000);
  });

  it("computes per-decision and total dollars from usage × the price constant, and a different constant changes the figure", async () => {
    const usageResults = FOUR_TASKS.map((task) => ({
      answers: [{ kind: "choice" as const, pick: task.correct }],
      model: "fake-jev-1",
      usage: { inputTokens: 100, outputTokens: 0 },
    }));
    let call = 0;
    const provider: TypedDecisionProvider = {
      name: "usage-jev",
      async decide() {
        return usageResults[call++ % usageResults.length];
      },
    };
    const atDefault = await runJevTimingPass(provider, FOUR_TASKS, 0.042, () => 0);
    // 4 × 100 tokens = 400 tokens → 400 × 0.042 / 1_000_000
    expect(atDefault.totalInputTokens).toBe(400);
    expect(atDefault.totalDollars).toBeCloseTo((400 * 0.042) / 1_000_000, 12);
    expect(atDefault.dollarsPerDecision).toBeCloseTo((100 * 0.042) / 1_000_000, 12);
    expect(atDefault.pricePerMTok).toBe(0.042);

    const atOther = await runJevTimingPass(provider, FOUR_TASKS, 0.5, () => 0);
    expect(atOther.totalDollars).not.toBe(atDefault.totalDollars);
    expect(atOther.pricePerMTok).toBe(0.5);
  });
});

describe("Ollama reference — strict prompts, wrong-not-aborted parsing, degrade to a gap (KTD9)", () => {
  it("scores exact option ids as correct and prose as wrong-plus-parse-failure", async () => {
    const questions = buildReferenceQuestions(REAL_LABELS, MULTIWAY_TASKS);
    expect(questions).toHaveLength(67);

    // complete() is awaited per question in order, so a queue maps cleanly.
    const correctQueue = questions.map((question) => `  ${question.correct}  `); // whitespace trimmed on parse
    const correctProvider: InferenceProvider = {
      name: "fake-ollama",
      async complete() {
        return correctQueue.shift() ?? "answerable";
      },
    };
    const perfect = await runOllamaReference(correctProvider, questions);
    expect(perfect.accuracy).toBe(1);
    expect(perfect.parseFailureCount).toBe(0);

    const proseProvider: InferenceProvider = {
      name: "fake-ollama",
      async complete() {
        return "I believe the best option here is the final one."; // never an exact id
      },
    };
    const prosed = await runOllamaReference(proseProvider, questions);
    expect(prosed.accuracy).toBe(0);
    expect(prosed.parseFailureCount).toBe(67);
    expect(prosed.parseFailureRate).toBe(1);
  });

  it("records a named gap on ProviderConfigError instead of failing the run", async () => {
    // Nothing configured: resolveProvider names DUO_PROVIDER (or its model key) — the gap names it.
    const section = await runOllamaReferenceSection(loadConfig({}), REAL_LABELS, MULTIWAY_TASKS);
    expect(section.status).toBe("gap");
    expect(section.gapReason ?? section.failureSummary ?? "").toMatch(/DUO_[A-Z_]+/);
    expect(section.accuracy).toBeUndefined();
  });
});

describe("stage-1 wrapper chaining — timing and reference sections (KTD6)", () => {
  it("a quality pass earns timing and reference sections in the persisted report", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    // No Ollama configured → the reference is a named gap, not a failure.
    // Script: 67 quality answers, then the timing pass's warmup + 20 measured answers.
    const timingAnswers = [choiceResult(MULTIWAY_TASKS[0].correct), ...MULTIWAY_TASKS.map((task) => choiceResult(task.correct))];
    const report = await runEvalJevStage1(config, createFakeJevProvider([...perfectScript(), ...timingAnswers]));

    expect(report.quality.r5Passed).toBe(true);
    expect(report.timing?.status).toBe("complete");
    expect(report.timing?.decisionCount).toBe(20);
    expect(report.reference?.status).toBe("gap");
    const persisted = JSON.parse(readFileSync(join(runtimeDir, "stage1-report.json"), "utf8"));
    expect(persisted.timing.status).toBe("complete");
    expect(persisted.reference.status).toBe("gap");
  });

  it("a mid-pass timing failure marks only the timing section failed — the quality pass stays intact (KTD6)", async () => {
    const { config } = tempRuntimeConfig();
    // Quality succeeds (67 scripted answers), then the timing warmup call
    // hits an exhausted script and throws ProviderError.
    const fake = createFakeJevProvider(perfectScript());
    const report = await runEvalJevStage1(config, fake);
    expect(report.quality.status).toBe("complete");
    expect(report.quality.r5Passed).toBe(true);
    expect(report.timing?.status).toBe("failed");
    expect(report.timing?.failureSummary).toContain("ProviderError");
  });

  it("never invokes the timing pass when R5 failed (AE2)", async () => {
    const { config } = tempRuntimeConfig();
    const script = perfectScript();
    const firstNegative = REAL_LABELS.findIndex((label) => label.expected === "not_answerable");
    script[firstNegative] = binaryResult(0.9); // one FP → R5 fails
    const fake = createFakeJevProvider(script);
    const report = await runEvalJevStage1(config, fake);

    expect(report.quality.r5Passed).toBe(false);
    expect(report.timing).toBeUndefined();
    expect(report.reference).toBeUndefined();
    expect(fake.calls).toHaveLength(67); // exactly the quality calls, nothing more
  });
});
