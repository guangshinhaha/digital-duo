import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateLabelExample, GateLabelValue } from "./gate-labels.js";
import { scoreRelevanceGate, type GateEvalReport } from "./gate-eval.js";
import { binaryVerdict, choiceOutcome, gateLabelRequest, multiwayTaskRequest } from "./jev-encoding.js";
import type { JevMultiwayTask } from "./jev-fixtures.js";
import type { JevReferenceSection, JevTimingSection } from "./jev-timing-eval.js";
import type { TypedDecisionProvider } from "../provider/types.js";

/**
 * Stage 1's quality run (plan U4): Jev vs the real deterministic gate on
 * the same 47 hand-labelled mentions, plus multi-way accuracy on the 20
 * authored tasks — the head-to-head R5 is decided on.
 *
 * Scoring conventions copy gate-eval.ts exactly: precision and recall are
 * reported separately, never averaged; precision is 1 when nothing was
 * predicted answerable; false positives are named, never just counted.
 */

export interface JevLabelItem {
  readonly id: string;
  readonly mentionType: string;
  readonly expected: GateLabelValue;
  readonly predicted: GateLabelValue;
  readonly probability: number;
  readonly correct: boolean;
}

export interface JevMultiwayItem {
  readonly id: string;
  readonly pick: string;
  readonly outOfMenu: boolean;
  readonly correct: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export interface JevQualitySection {
  readonly status: "complete" | "failed";
  /** Present only on quality runs that completed; stage 2 and the timing pass gate on it (KTD5/KTD6). */
  readonly r5Passed?: boolean;
  /** Sanitized failure record for an aborted run: error class and status, never a raw response body (KTD6/KTD10). */
  readonly failureSummary?: string;
}

export interface JevStage1Report {
  readonly generatedAt: string;
  /** The effective gateway origin requests went to — recorded so a report never has to be trusted on where it ran. */
  readonly gatewayOrigin: string;
  readonly fixtureHashes: { readonly gateLabels: string; readonly multiwayTasks: string };
  /** How many local refusals the baseline gate saw that Jev did not — the KTD10 parity caveat's data. */
  readonly refusalsLoaded: number;
  readonly baseline: GateEvalReport;
  readonly quality: JevQualitySection;
  readonly jev?: {
    readonly model: string;
    readonly total: number;
    readonly answerableCount: number;
    readonly truePositives: number;
    readonly falsePositives: number;
    readonly trueNegatives: number;
    readonly falseNegatives: number;
    readonly precision: number;
    readonly recall: number;
    readonly items: readonly JevLabelItem[];
  };
  readonly multiway?: {
    readonly total: number;
    readonly correctCount: number;
    readonly accuracy: number;
    readonly outOfMenuCount: number;
    readonly items: readonly JevMultiwayItem[];
  };
  /** Present only on runs whose quality section completed and passed R5 (U5 chains them). */
  readonly timing?: JevTimingSection;
  readonly reference?: JevReferenceSection;
}

export interface JevStage1QualityInputs {
  readonly labels: readonly GateLabelExample[];
  readonly refusals: readonly string[];
  readonly tasks: readonly JevMultiwayTask[];
  readonly gatewayOrigin: string;
  readonly fixtureHashes: { readonly gateLabels: string; readonly multiwayTasks: string };
}

/**
 * The pure quality run: one Jev call per label and per task through the
 * encoding layer, scored against the same labels the deterministic gate
 * scores. Throws whatever the provider threw — persisting the failed
 * section is the command wrapper's job, not this function's.
 */
export async function runJevStage1Quality(
  provider: TypedDecisionProvider,
  inputs: JevStage1QualityInputs,
): Promise<JevStage1Report> {
  const baseline = scoreRelevanceGate(inputs.labels, inputs.refusals);

  const labelItems: JevLabelItem[] = [];
  let model = "unknown";
  for (const label of inputs.labels) {
    const { state, question } = gateLabelRequest(label);
    const result = await provider.decide(state, [question]);
    model = result.model;
    const answer = result.answers[0];
    if (answer?.kind !== "binary") {
      throw new Error(`Jev answer for label ${label.id} was not binary`);
    }
    const predicted = binaryVerdict(answer);
    labelItems.push({
      id: label.id,
      mentionType: label.mentionType,
      expected: label.expected,
      predicted,
      probability: answer.probability,
      correct: predicted === label.expected,
    });
  }

  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  let answerableCount = 0;
  for (const item of labelItems) {
    if (item.predicted === "answerable") {
      answerableCount += 1;
      if (item.expected === "answerable") {
        truePositives += 1;
      } else {
        falsePositives += 1;
      }
    } else if (item.expected === "answerable") {
      falseNegatives += 1;
    } else {
      trueNegatives += 1;
    }
  }
  // Same zero-prediction convention as scoreRelevanceGate — a run that marked
  // nothing answerable made none of the mistakes precision measures.
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);

  const multiwayItems: JevMultiwayItem[] = [];
  for (const task of inputs.tasks) {
    const { state, question } = multiwayTaskRequest(task);
    const result = await provider.decide(state, [question]);
    model = result.model;
    const answer = result.answers[0];
    if (answer?.kind !== "choice") {
      throw new Error(`Jev answer for task ${task.id} was not a choice`);
    }
    const outcome = choiceOutcome(answer, task.candidates.map((candidate) => candidate.id));
    multiwayItems.push({
      id: task.id,
      pick: outcome.pick,
      outOfMenu: outcome.outOfMenu,
      correct: !outcome.outOfMenu && outcome.pick === task.correct,
      ...(outcome.probabilities ? { probabilities: outcome.probabilities } : {}),
      ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
    });
  }
  const correctCount = multiwayItems.filter((item) => item.correct).length;

  const report: JevStage1Report = {
    generatedAt: new Date().toISOString(),
    gatewayOrigin: inputs.gatewayOrigin,
    fixtureHashes: inputs.fixtureHashes,
    refusalsLoaded: inputs.refusals.length,
    baseline,
    quality: {
      status: "complete",
      r5Passed:
        truePositives * (baseline.truePositives + baseline.falsePositives) >=
        baseline.truePositives * (truePositives + falsePositives),
    },
    jev: {
      model,
      total: labelItems.length,
      answerableCount,
      truePositives,
      falsePositives,
      trueNegatives,
      falseNegatives,
      precision,
      recall,
      items: labelItems,
    },
    multiway: {
      total: multiwayItems.length,
      correctCount,
      accuracy: multiwayItems.length === 0 ? 0 : correctCount / multiwayItems.length,
      outOfMenuCount: multiwayItems.filter((item) => item.outOfMenu).length,
      items: multiwayItems,
    },
  };
  return report;
}

/** The caveat the CLI prints whenever the baseline saw local refusals Jev did not (KTD10). */
export function REFUSALS_PARITY_CAVEAT(refusalsLoaded: number): string {
  return `Baseline parity caveat: the deterministic gate ran with ${refusalsLoaded} local refusal(s) loaded from duo/refusals.md; Jev received none of them (R9 — refusals never leave the machine).`;
}

/**
 * A failure summary records the error class and status, never a raw
 * response body: for HTTP failures only the text up to the status code
 * survives, so a scrubbed-but-verbose ProviderError message cannot carry
 * gateway output into a persisted report or the verdict (KTD6/KTD10).
 */
export function sanitizeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const httpPrefix = message.match(/^[\s\S]*?HTTP \d+/);
  const summary = httpPrefix ? httpPrefix[0] : message.split("\n")[0].slice(0, 80);
  return `${name}: ${summary}`;
}

export function stage1ReportPath(runtimeDir: string): string {
  return join(runtimeDir, "stage1-report.json");
}

export function persistStage1Report(runtimeDir: string, report: JevStage1Report): string {
  mkdirSync(runtimeDir, { recursive: true }); // recursive mkdir is a no-op on an existing dir
  const path = stage1ReportPath(runtimeDir);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function readStage1Report(runtimeDir: string): JevStage1Report {
  const path = stage1ReportPath(runtimeDir);
  if (!existsSync(path)) {
    throw new Error(`No stage-1 report found at "${path}" — run \`duo eval jev stage1\` first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as JevStage1Report;
}

/**
 * Thrown when Jev's precision lands below the deterministic gate's on the
 * same labels (R5 failed). Names the newly admitted false positives, the
 * same "named, never just counted" rule as PrecisionFloorViolationError.
 */
export class JevStage1QualityError extends Error {
  readonly report: JevStage1Report;

  constructor(report: JevStage1Report) {
    const jev = report.jev;
    const baseline = report.baseline;
    const falsePositiveIds = (jev?.items ?? [])
      .filter((item) => item.expected === "not_answerable" && item.predicted === "answerable")
      .map((item) => item.id);
    super(
      `Jev stage-1 quality gate failed: precision ${(jev?.precision ?? 0).toFixed(3)} ` +
        `(${jev?.truePositives ?? 0}/${(jev?.truePositives ?? 0) + (jev?.falsePositives ?? 0)} answerable calls correct) ` +
        `is below the deterministic gate's ${baseline.precision.toFixed(3)} ` +
        `(${baseline.truePositives}/${baseline.truePositives + baseline.falsePositives}) on the same labels — ` +
        `newly admitted false positive(s): ${falsePositiveIds.join(", ") || "none named"}.`,
    );
    this.name = "JevStage1QualityError";
    this.report = report;
  }
}

/**
 * R5 as an assertion: Jev's precision at or above the deterministic gate's
 * on the same labels. Integer cross-multiplication only —
 * `tpJev·(tpGate+fpGate) ≥ tpGate·(tpJev+fpJev)` — never float division,
 * so no rounding tolerance can soften a miss (KTD8).
 */
export function assertStage1QualityPass(report: JevStage1Report): void {
  if (report.quality.status === "failed" || report.quality.r5Passed !== true) {
    if (report.quality.status === "failed") {
      throw new Error(
        `Jev stage-1 quality run never completed (${report.quality.failureSummary ?? "no summary"}) — inconclusive, not a don't-adopt.`,
      );
    }
    throw new JevStage1QualityError(report);
  }
}
