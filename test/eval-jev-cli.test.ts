import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";
import { useTempDir } from "./helpers/temp-dir.js";
import type { JevStage1Report } from "../src/eval/jev-gate-eval.js";
import type { JevStage2Report } from "../src/eval/jev-trace-eval.js";
import { buildJevVerdictMarkdown, recommendJevVerdict, verdictPath } from "../src/eval/jev-verdict.js";

const tempDir = useTempDir();

// The repo's real fixtures, for the one spawned scenario that gets far enough
// to load them (malformed-override test reads the real label set first).
const REPO_GATE_LABELS = fileURLToPath(new URL("../eval/gate-labels.json", import.meta.url));

function stage1Report(
  sections: {
    quality?: JevStage1Report["quality"];
    timing?: JevStage1Report["timing"];
    reference?: JevStage1Report["reference"];
  } = {},
): JevStage1Report {
  return {
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
    } as JevStage1Report["baseline"],
    quality: sections.quality ?? { status: "complete", r5Passed: true },
    jev: {
      model: "jev-latest",
      total: 47,
      answerableCount: 12,
      truePositives: 12,
      falsePositives: 0,
      trueNegatives: 35,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      items: [],
    },
    multiway: { total: 20, correctCount: 19, accuracy: 0.95, outOfMenuCount: 1, items: [] },
    timing:
      sections.timing ??
      {
        status: "complete",
        decisionCount: 20,
        warmupMs: 900,
        meanMsPerDecision: 410,
        medianMsPerDecision: 400,
        totalWallMs: 8200,
        totalInputTokens: 40_000,
        totalDollars: 0.00168,
        dollarsPerDecision: 0.000084,
        pricePerMTok: 0.042,
      },
    reference:
      sections.reference ??
      { status: "complete", total: 67, accuracy: 0.9, parseFailureCount: 2, parseFailureRate: 2 / 67 },
  };
}

function stage2Report(status: "complete" | "failed" = "complete"): JevStage2Report {
  return {
    generatedAt: "2026-09-20T13:00:00.000Z",
    gatewayOrigin: "https://api.typesafe.ai",
    tracesHash: "c".repeat(64),
    stage1: { generatedAt: "2026-09-20T12:00:00.000Z", gatewayOrigin: "https://api.typesafe.ai" },
    status,
    ...(status === "failed" ? { failureSummary: "ProviderError: HTTP 503" } : {}),
    model: "jev-latest",
    totalTraces: 8,
    completedTraces: status === "complete" ? 8 : 1,
    totalSteps: 35,
    correctSteps: status === "complete" ? 35 : 6,
    stepAccuracy: status === "complete" ? 1 : 6 / 35,
    traces: [],
  };
}

function writeReports(runtimeDir: string, stage1: JevStage1Report, stage2?: JevStage2Report) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "stage1-report.json"), `${JSON.stringify(stage1, null, 2)}\n`);
  if (stage2) {
    writeFileSync(join(runtimeDir, "stage2-report.json"), `${JSON.stringify(stage2, null, 2)}\n`);
  }
}

describe("jev verdict assembler — recommended-verdict mapping (in-process)", () => {
  it("maps a fully passing run to adopt with no conditions", () => {
    const { verdict, conditions } = recommendJevVerdict(stage1Report(), stage2Report());
    expect(verdict).toBe("adopt");
    expect(conditions).toEqual([]);
  });

  it("reserves inconclusive for a quality section that never completed, stating the sanitized failure (KTD6)", () => {
    const { verdict, conditions } = recommendJevVerdict(
      stage1Report({ quality: { status: "failed", failureSummary: "ProviderError: HTTP 503" } }),
      undefined,
    );
    expect(verdict).toBe("inconclusive");
    expect(conditions.join(" ")).toMatch(/ProviderError: HTTP 503/);
  });

  it("maps an R5 failure to don't adopt", () => {
    const { verdict } = recommendJevVerdict(stage1Report({ quality: { status: "complete", r5Passed: false } }), stage2Report());
    expect(verdict).toBe("don't adopt");
  });

  it("flags a stale stage-2 report replayed against an earlier stage-1 — a mixed-run clean adopt is impossible", () => {
    const stale: JevStage2Report = {
      ...stage2Report(),
      stage1: { generatedAt: "2026-09-20T11:00:00.000Z", gatewayOrigin: "https://api.typesafe.ai" },
    };
    const { verdict, conditions } = recommendJevVerdict(stage1Report(), stale);
    expect(verdict).toBe("adopt-with-conditions");
    const joined = conditions.join(" ");
    expect(joined).toMatch(/stale/i);
    expect(joined).toMatch(/duo eval jev stage2/);
  });

  it("keeps an earned quality pass decisive but names every gapped, failed, or degenerate headline (KTD6)", () => {
    const { verdict, conditions } = recommendJevVerdict(
      stage1Report({
        timing: { status: "failed", failureSummary: "ProviderError: HTTP 429" },
        reference: { status: "gap", gapReason: "ProviderConfigError: DUO_PROVIDER is not configured" },
      }),
      stage2Report("failed"),
    );
    expect(verdict).toBe("adopt-with-conditions");
    const joined = conditions.join(" ");
    expect(joined).toMatch(/HTTP 429/);
    expect(joined).toMatch(/DUO_PROVIDER/);
    expect(joined).toMatch(/navigation is unknown/i);

    const degenerate = recommendJevVerdict(
      { ...stage1Report(), jev: { ...stage1Report().jev!, answerableCount: 0 } },
      stage2Report(),
    );
    expect(degenerate.verdict).toBe("adopt-with-conditions");
    expect(degenerate.conditions.join(" ")).toMatch(/zero-prediction/);
  });

  it("assembles the KTD7 preamble from aggregates only", () => {
    const markdown = buildJevVerdictMarkdown(stage1Report(), stage2Report(), "adopt", [], "2026-09-21T01:02:03.000Z");
    for (const expected of [
      /precision 1\.000/,
      /12\/47 mentions answerable/,
      /0 false positives.*single Jev false positive fails the bar/s,
      /0\.950 \(19\/20 tasks/,
      /step accuracy 1\.000 \(35\/35 steps/,
      /8\/8 traces completed/,
      /410 ms/,
      /\$0\.001680/,
      /accuracy 0\.900/,
      /jev-latest/,
      /https:\/\/api\.typesafe\.ai/,
      /2026-09-21T01:02:03\.000Z/,
      /owner makes the final call/,
    ]) {
      expect(markdown).toMatch(expected);
    }
  });
});

describe("duo eval jev (spawned)", () => {
  it("stage1 without DUO_JEV_API_KEY: non-zero exit naming the key, and no report text on stdout", async () => {
    const result = await runCli(["eval", "jev", "stage1"], {
      cwd: tempDir(),
      env: { DUO_JEV_SPIKE_RUNTIME_DIR: join(tempDir(), "runtime") },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/DUO_JEV_API_KEY/);
    // The provider is constructed before anything loads or prints, so a
    // keyless run never builds a request and never emits report lines.
    expect(result.stdout).not.toMatch(/answerable/);
  });

  it("stage2 without a stage-1 report: non-zero exit naming the gate, before the key is even consulted", async () => {
    const result = await runCli(["eval", "jev", "stage2"], {
      cwd: tempDir(),
      env: { DUO_JEV_SPIKE_RUNTIME_DIR: join(tempDir(), "runtime") },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/duo eval jev stage1/);
    expect(result.stdout).not.toMatch(/step accuracy/i);
  });

  it("stage1 with a malformed multi-way fixture: non-zero exit naming the path and entry, nothing sent", async () => {
    const malformed = join(tempDir(), "malformed-tasks.json");
    writeFileSync(
      malformed,
      JSON.stringify({
        provenance: { synthetic: true },
        items: [
          { id: "t1", scenario: "s", goal: "g", candidates: [{ id: "a", description: "d" }, { id: "b", description: "d" }], correct: "a" },
          { id: "t2", scenario: "s", goal: "g", candidates: [{ id: "a", description: "d" }, { id: "b", description: "d" }], correct: "zzz" },
        ],
      }),
      "utf8",
    );
    const result = await runCli(["eval", "jev", "stage1"], {
      cwd: tempDir(),
      env: {
        DUO_JEV_SPIKE_RUNTIME_DIR: join(tempDir(), "runtime"),
        // A dummy key lets the provider construct so the failure is the
        // fixture's, not the key's — the run aborts at load, before any
        // request exists to send.
        DUO_JEV_API_KEY: "test-key-unused-by-this-path",
        DUO_EVAL_GATE_LABELS_PATH: REPO_GATE_LABELS,
        DUO_EVAL_JEV_MULTIWAY_TASKS_PATH: malformed,
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Malformed/);
    expect(result.stderr).toMatch(/malformed-tasks\.json/);
    expect(result.stderr).toMatch(/t2/);
    expect(result.stdout).not.toMatch(/answerable/);
  });

  it("verdict with complete passing reports: writes verdict.md carrying every KTD7 preamble field", async () => {
    const runtime = join(tempDir(), "runtime");
    writeReports(runtime, stage1Report(), stage2Report());

    const result = await runCli(["eval", "jev", "verdict"], {
      cwd: tempDir(),
      env: { DUO_JEV_SPIKE_RUNTIME_DIR: runtime },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Recommendation: adopt\./);

    const file = readFileSync(verdictPath(runtime), "utf8");
    for (const expected of [
      /Recommendation: adopt\./,
      /precision 1\.000/,
      /12\/47 mentions answerable/,
      /0\.950 \(19\/20 tasks/,
      /8\/8 traces completed/,
      /jev-latest/,
      /https:\/\/api\.typesafe\.ai/,
      /2026-/,
      /owner makes the final call/,
    ]) {
      expect(file).toMatch(expected);
    }
  });

  it("verdict with a quality-failed stage-1: inconclusive stating the sanitized failure (KTD6)", async () => {
    const runtime = join(tempDir(), "runtime");
    writeReports(runtime, stage1Report({ quality: { status: "failed", failureSummary: "ProviderError: HTTP 503" } }));

    const result = await runCli(["eval", "jev", "verdict"], {
      cwd: tempDir(),
      env: { DUO_JEV_SPIKE_RUNTIME_DIR: runtime },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/inconclusive/);
    expect(readFileSync(verdictPath(runtime), "utf8")).toMatch(/ProviderError: HTTP 503/);
  });

  it("verdict with a timing-only failure: adopt-with-conditions naming the timing failure and the reference gap (KTD6)", async () => {
    const runtime = join(tempDir(), "runtime");
    writeReports(
      runtime,
      stage1Report({
        timing: { status: "failed", failureSummary: "ProviderError: HTTP 429" },
        reference: { status: "gap", gapReason: "ProviderConfigError: DUO_PROVIDER is not configured" },
      }),
      stage2Report(),
    );

    const result = await runCli(["eval", "jev", "verdict"], {
      cwd: tempDir(),
      env: { DUO_JEV_SPIKE_RUNTIME_DIR: runtime },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/adopt-with-conditions/);
    const file = readFileSync(verdictPath(runtime), "utf8");
    expect(file).toMatch(/HTTP 429/);
    expect(file).toMatch(/DUO_PROVIDER/);
  });
});
