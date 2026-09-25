import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runEvalJevStage2 } from "../src/commands/eval.js";
import { fixtureSha256, loadJevTraces } from "../src/eval/jev-fixtures.js";
import { stage2ReportPath } from "../src/eval/jev-trace-eval.js";
import { ProviderError } from "../src/provider/types.js";
import { choiceResult, createFakeJevProvider, createFailingJevProvider } from "./fixtures/fake-jev-provider.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRuntimeConfig(extra: Record<string, string> = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "jev-stage2-"));
  tempDirs.push(runtimeDir);
  return { config: loadConfig({ DUO_JEV_SPIKE_RUNTIME_DIR: runtimeDir, ...extra }), runtimeDir };
}

const TRACES = loadJevTraces("eval/jev-traces.json");
const TOTAL_STEPS = TRACES.reduce((count, trace) => count + trace.steps.length, 0);

/** The all-correct answer sequence: traces in order, steps in order. */
function perfectTraceScript() {
  return TRACES.flatMap((trace) => trace.steps.map((step) => choiceResult(step.correct)));
}

/**
 * Fabricates the persisted stage-1 report stage 2 gates on. Only the gate
 * fields matter to the replay; the rest mirrors the real shape so the file
 * reads honestly in a failure dump.
 */
function writeStage1Report(runtimeDir: string, quality: { status: string; r5Passed?: boolean }) {
  const report = {
    generatedAt: "2026-09-20T12:00:00.000Z",
    gatewayOrigin: "https://api.typesafe.ai",
    fixtureHashes: { gateLabels: "a".repeat(64), multiwayTasks: "b".repeat(64) },
    refusalsLoaded: 0,
    baseline: {
      total: 47,
      truePositives: 12,
      falsePositives: 0,
      trueNegatives: 35,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
    },
    quality,
  };
  writeFileSync(join(runtimeDir, "stage1-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

describe("runEvalJevStage2 — gated offline navigation replay (R7/R8, AE1/AE3)", () => {
  it("refuses to run with no persisted stage-1 report, naming where it must come from, before any Jev call", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    const fake = createFakeJevProvider(perfectTraceScript());
    await expect(runEvalJevStage2(config, fake)).rejects.toThrow(/duo eval jev stage1/);

    expect(fake.calls).toHaveLength(0); // the gate fires before any request is built
    expect(existsSync(stage2ReportPath(runtimeDir))).toBe(false); // nothing to report from a refusal
  });

  it("refuses the same way on a persisted stage-1 report whose quality failed or did not pass R5", async () => {
    for (const quality of [{ status: "failed", failureSummary: "ProviderError: HTTP 503" }, { status: "complete", r5Passed: false }]) {
      const { config, runtimeDir } = tempRuntimeConfig();
      writeStage1Report(runtimeDir, quality);
      const fake = createFakeJevProvider(perfectTraceScript());
      await expect(runEvalJevStage2(config, fake)).rejects.toThrow(/does not record an R5 pass/);
      expect(fake.calls).toHaveLength(0);
      expect(existsSync(stage2ReportPath(runtimeDir))).toBe(false);
    }
  });

  it("wrong step-4 top pick: the step is marked wrong with its ranking recorded, and the replay continues through step 5", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    writeStage1Report(runtimeDir, { status: "complete", r5Passed: true });

    // tr01 is the first trace and has 5 steps; flip its step index 3 (the
    // fourth pick) to another candidate on the same step's menu.
    const trace = TRACES[0];
    const step = trace.steps[3];
    const wrongId = step.candidates.map((candidate) => candidate.id).find((id) => id !== step.correct)!;
    const ranking = { [wrongId]: 0.55, [step.correct]: 0.4 };
    const script = perfectTraceScript();
    const tr01Before = TRACES.slice(0, 1).reduce((n, t) => n + t.steps.length, 0);
    script[3] = choiceResult(wrongId, { probabilities: ranking, confidence: 0.55 });

    const report = await runEvalJevStage2(config, createFakeJevProvider(script));

    expect(report.status).toBe("complete");
    expect(report.traces[0].id).toBe(trace.id);
    expect(report.traces[0].completed).toBe(false);
    const wrong = report.traces[0].steps.find((item) => item.stepIndex === 3)!;
    expect(wrong.correct).toBe(false);
    expect(wrong.pick).toBe(wrongId);
    expect(wrong.expected).toBe(step.correct);
    expect(wrong.probabilities).toEqual(ranking); // the full ranking survives, not just the pick
    // Continuation (AE3): step 5 still ran and the remaining traces are intact.
    expect(report.traces[0].steps).toHaveLength(tr01Before);
    expect(report.traces[0].steps[4].correct).toBe(true);
    expect(report.completedTraces).toBe(7);
    expect(report.stepAccuracy).toBeCloseTo((TOTAL_STEPS - 1) / TOTAL_STEPS, 12);
  });

  it("out-of-menu answer mid-trace: a wrong pick marked, never an error, and the replay continues", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    writeStage1Report(runtimeDir, { status: "complete", r5Passed: true });

    const script = perfectTraceScript();
    // tr03 (index 2) is a 4-step trace; poison its second step with a pick
    // that is on no menu.
    const beforeTr03 = TRACES.slice(0, 2).reduce((n, t) => n + t.steps.length, 0);
    script[beforeTr03 + 1] = choiceResult("no-such-option");

    const report = await runEvalJevStage2(config, createFakeJevProvider(script));

    expect(report.status).toBe("complete");
    const poisoned = report.traces[2].steps.find((item) => item.stepIndex === 1)!;
    expect(poisoned.outOfMenu).toBe(true);
    expect(poisoned.correct).toBe(false);
    expect(report.traces[2].completed).toBe(false);
    expect(report.traces[2].steps[2].correct).toBe(true); // later steps still replayed
    expect(report.completedTraces).toBe(7);
  });

  it("provider error mid-trace: the run aborts, a partial report with a sanitized failure record persists, and the stage-1 report is untouched", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    writeStage1Report(runtimeDir, { status: "complete", r5Passed: true });
    const stage1Before = readFileSync(join(runtimeDir, "stage1-report.json"), "utf8");

    // Script covers tr01 (5 steps) plus tr02's first step, then runs out —
    // the ProviderError lands on tr02's second step.
    const script = perfectTraceScript().slice(0, 6);
    await expect(runEvalJevStage2(config, createFakeJevProvider(script))).rejects.toThrow(ProviderError);

    const persisted = JSON.parse(readFileSync(stage2ReportPath(runtimeDir), "utf8"));
    expect(persisted.status).toBe("failed");
    expect(persisted.failureSummary).toContain("ProviderError");
    expect(persisted.failureSummary.length).toBeLessThan(200); // sanitized, not a body dump
    // The partial evidence survives: tr01 completed, tr02 recorded up to the abort.
    expect(persisted.traces).toHaveLength(2);
    expect(persisted.traces[0].id).toBe("tr01");
    expect(persisted.traces[0].completed).toBe(true);
    expect(persisted.traces[1].id).toBe("tr02");
    expect(persisted.traces[1].completed).toBe(false);
    expect(persisted.traces[1].steps).toHaveLength(1);
    expect(persisted.totalTraces).toBe(8);
    // KTD6: the stage-1 quality numbers remain exactly as they were.
    expect(readFileSync(join(runtimeDir, "stage1-report.json"), "utf8")).toBe(stage1Before);
  });

  it("all steps correct: 100% step accuracy, 8/8 trace completion, report persisted with lineage", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    writeStage1Report(runtimeDir, { status: "complete", r5Passed: true });

    const report = await runEvalJevStage2(config, createFakeJevProvider(perfectTraceScript()));

    expect(report.status).toBe("complete");
    expect(report.stepAccuracy).toBe(1);
    expect(report.totalSteps).toBe(TOTAL_STEPS);
    expect(report.correctSteps).toBe(TOTAL_STEPS);
    expect(report.completedTraces).toBe(8);
    expect(report.totalTraces).toBe(8);
    expect(report.model).toBe("fake-jev-1");
    expect(report.gatewayOrigin).toBe("https://api.typesafe.ai");
    expect(report.tracesHash).toBe(fixtureSha256("eval/jev-traces.json"));
    expect(report.stage1.generatedAt).toBe("2026-09-20T12:00:00.000Z"); // lineage to the gate's pass

    const persisted = JSON.parse(readFileSync(stage2ReportPath(runtimeDir), "utf8"));
    expect(persisted.stepAccuracy).toBe(1);
    expect(persisted.completedTraces).toBe(8);
  });
});
