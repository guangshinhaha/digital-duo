import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runEvalJevStage1 } from "../src/commands/eval.js";
import { loadGateLabels } from "../src/eval/gate-labels.js";
import {
  JevStage1QualityError,
  REFUSALS_PARITY_CAVEAT,
  assertStage1QualityPass,
  readStage1Report,
  stage1ReportPath,
} from "../src/eval/jev-gate-eval.js";
import { binaryResult, choiceResult, createFakeJevProvider, createFailingJevProvider } from "./fixtures/fake-jev-provider.js";
import type { FakeJevProvider } from "./fixtures/fake-jev-provider.js";
import { ProviderError } from "../src/provider/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRuntimeConfig(extra: Record<string, string> = {}) {
  const runtimeDir = mktemp("runtime");
  return {
    config: loadConfig({ DUO_JEV_SPIKE_RUNTIME_DIR: runtimeDir, ...extra }),
    runtimeDir,
  };
}

function mktemp(label: string): string {
  const dir = join(tmpdir(), `jev-stage1-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

const REAL_LABELS = loadGateLabels("eval/gate-labels.json");

/** Scripts the fake to be perfect on the real label set and the real 20 tasks. */
function perfectScript() {
  const labelResults = REAL_LABELS.map((label) =>
    binaryResult(label.expected === "answerable" ? 0.9 : 0.2),
  );
  const MULTIWAY = JSON.parse(readFileSync("eval/jev-multiway-tasks.json", "utf8")) as {
    items: { correct: string }[];
  };
  const taskResults = MULTIWAY.items.map((task) => choiceResult(task.correct));
  return [...labelResults, ...taskResults];
}

describe("runEvalJevStage1 — head-to-head quality run (R3/R4/R5)", () => {
  it("perfect fake: separate precision/recall both 1.000, multi-way accuracy 1.000, R5 passes, report persisted complete", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    const fake = createFakeJevProvider(perfectScript());
    const report = await runEvalJevStage1(config, fake);

    expect(report.quality.status).toBe("complete");
    expect(report.quality.r5Passed).toBe(true);
    expect(report.jev?.precision).toBe(1);
    expect(report.jev?.recall).toBe(1);
    expect(report.jev?.answerableCount).toBe(12);
    expect(report.jev?.total).toBe(REAL_LABELS.length);
    expect(report.multiway?.accuracy).toBe(1);
    expect(report.multiway?.total).toBe(20);
    expect(report.baseline.precision).toBe(1);
    expect(report.baseline.recall).toBe(1);
    expect(report.gatewayOrigin).toBe("https://api.typesafe.ai");
    expect(report.fixtureHashes.gateLabels).toMatch(/^[0-9a-f]{64}$/);

    const persisted = JSON.parse(readFileSync(stage1ReportPath(runtimeDir), "utf8"));
    expect(persisted.quality.r5Passed).toBe(true);
    expect(readStage1Report(runtimeDir).quality.r5Passed).toBe(true);
    expect(() => assertStage1QualityPass(report)).not.toThrow();
  });

  it("exactly one false positive: R5 assertion throws naming the FP id, and the report file is still written", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    const script = perfectScript();
    // Flip one not_answerable label to a confident yes — the sharp KTD8 edge.
    const firstNegative = REAL_LABELS.findIndex((label) => label.expected === "not_answerable");
    script[firstNegative] = binaryResult(0.9);
    const report = await runEvalJevStage1(config, createFakeJevProvider(script));

    expect(report.jev?.falsePositives).toBe(1);
    expect(report.quality.status).toBe("complete");
    expect(report.quality.r5Passed).toBe(false);
    expect(existsSync(stage1ReportPath(runtimeDir))).toBe(true);

    let thrown: JevStage1QualityError | undefined;
    try {
      assertStage1QualityPass(report);
    } catch (error) {
      thrown = error as JevStage1QualityError;
    }
    expect(thrown).toBeInstanceOf(JevStage1QualityError);
    expect(thrown!.message).toContain(REAL_LABELS[firstNegative].id);
    expect(thrown!.message).toMatch(/precision/i);
    expect(thrown!.message).toMatch(/0\.923/);
  });

  it("degenerate all-negative run: precision stays 1.000 by the zero-prediction convention, R5 passes, and answerableCount 0 makes it visible", async () => {
    const { config } = tempRuntimeConfig();
    const allNegative = REAL_LABELS.map(() => binaryResult(0.2));
    const MULTIWAY = JSON.parse(readFileSync("eval/jev-multiway-tasks.json", "utf8")) as { items: { correct: string }[] };
    const tasks = MULTIWAY.items.map((task) => choiceResult(task.correct));
    const report = await runEvalJevStage1(config, createFakeJevProvider([...allNegative, ...tasks]));

    expect(report.jev?.precision).toBe(1);
    expect(report.jev?.answerableCount).toBe(0);
    expect(report.jev?.total).toBe(47);
    expect(report.quality.r5Passed).toBe(true);
    expect(() => assertStage1QualityPass(report)).not.toThrow();
  });

  it("provider failure mid-run: the run aborts, a partial report persists with the quality section failed and a sanitized summary, baseline intact", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    const fake = createFakeJevProvider([binaryResult(0.9)]); // one answer, then exhausted
    await expect(runEvalJevStage1(config, fake)).rejects.toThrow(ProviderError);

    const persisted = JSON.parse(readFileSync(stage1ReportPath(runtimeDir), "utf8"));
    expect(persisted.quality.status).toBe("failed");
    expect(persisted.quality.failureSummary).toContain("ProviderError");
    expect(persisted.quality.failureSummary.length).toBeLessThan(200);
    expect(persisted.baseline.precision).toBe(1);
    expect(persisted.refusalsLoaded).toBe(0);
  });

  it("failing provider from the start behaves the same way", async () => {
    const { config, runtimeDir } = tempRuntimeConfig();
    await expect(runEvalJevStage1(config, createFailingJevProvider())).rejects.toThrow(/unreachable/i);
    const persisted = JSON.parse(readFileSync(stage1ReportPath(runtimeDir), "utf8"));
    expect(persisted.quality.status).toBe("failed");
    expect(persisted.quality.failureSummary).toContain("ProviderError");
  });

  it("baseline parity: the real deterministic gate scores 1.000/1.000 on the current 47 labels", async () => {
    const { config } = tempRuntimeConfig();
    const report = await runEvalJevStage1(config, createFakeJevProvider(perfectScript()));
    expect(report.baseline.total).toBe(47);
    expect(report.baseline.truePositives).toBe(12);
    expect(report.baseline.falsePositives).toBe(0);
    expect(report.baseline.falseNegatives).toBe(0);
  });

  it("canary: local refusals load into the baseline only — neither the refusal headings nor a DUO_OWNER_NAME marker appear in any request body", async () => {
    const duoDir = mktemp("duo");
    writeFileSync(join(duoDir, "refusals.md"), "## CANARY-REFUSAL-HEADING\n\nBecause the canary says so.\n");
    const previousOwner = process.env.DUO_OWNER_NAME;
    process.env.DUO_OWNER_NAME = "CANARY-OWNER-7f3a";
    let fake: FakeJevProvider;
    try {
      const { config } = tempRuntimeConfig({ DUO_DIR: duoDir });
      fake = createFakeJevProvider(perfectScript());
      const report = await runEvalJevStage1(config, fake);
      expect(report.refusalsLoaded).toBe(1);
      expect(REFUSALS_PARITY_CAVEAT(1)).toMatch(/1 local refusal/i);
    } finally {
      if (previousOwner === undefined) {
        delete process.env.DUO_OWNER_NAME;
      } else {
        process.env.DUO_OWNER_NAME = previousOwner;
      }
    }
    // Deep audit of every request the eval built — containment would let a
    // smuggled field hide anywhere outside the matched substring (KTD10).
    expect(fake!.calls.length).toBe(67);
    for (const call of fake!.calls) {
      const serialized = JSON.stringify({ state: call.state, questions: call.questions });
      expect(serialized).not.toContain("CANARY-REFUSAL-HEADING");
      expect(serialized).not.toContain("CANARY-OWNER-7f3a");
    }
  });
});
