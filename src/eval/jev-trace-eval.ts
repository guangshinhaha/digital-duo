import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { choiceOutcome, traceStepRequest } from "./jev-encoding.js";
import type { JevTrace } from "./jev-fixtures.js";
import { readStage1Report, sanitizeFailure, stage1ReportPath, type JevStage1Report } from "./jev-gate-eval.js";
import type { TypedDecisionProvider } from "../provider/types.js";

/**
 * Stage 2 of the Jev spike (plan U6): offline navigation replay over the
 * synthetic traces — per-step choice ranking, per-step accuracy, and
 * per-trace completion. No browser opens and no action-gate module is
 * touched; the only I/O is the trace fixture in and this report out.
 *
 * The replay is gated on an earned stage-1 pass (KTD5): a navigation number
 * is only meaningful next to a quality verdict that already cleared R5.
 */

export interface JevTraceStepItem {
  readonly traceId: string;
  readonly stepIndex: number;
  readonly page: string;
  readonly pick: string;
  readonly expected: string;
  readonly outOfMenu: boolean;
  readonly correct: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export interface JevTraceDetail {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly JevTraceStepItem[];
  /** True only when every step's top pick was correct — one wrong step fails the trace. */
  readonly completed: boolean;
}

export interface JevStage2Report {
  readonly generatedAt: string;
  readonly gatewayOrigin: string;
  /** Hash of the trace fixture this replay scored — which navigation set produced these numbers (KTD5). */
  readonly tracesHash: string;
  /** Lineage to the stage-1 pass this replay was gated on. */
  readonly stage1: { readonly generatedAt: string; readonly gatewayOrigin: string };
  readonly status: "complete" | "failed";
  /** Sanitized failure record for an aborted replay: error class and status, never a raw response body (KTD6). */
  readonly failureSummary?: string;
  readonly model: string;
  readonly totalTraces: number;
  readonly completedTraces: number;
  readonly totalSteps: number;
  readonly correctSteps: number;
  readonly stepAccuracy: number;
  readonly traces: readonly JevTraceDetail[];
}

export interface JevStage2Inputs {
  readonly traces: readonly JevTrace[];
  readonly gatewayOrigin: string;
  readonly tracesHash: string;
  readonly stage1: JevStage1Report;
}

/**
 * The KTD5 gate. Stage 2 runs only on a persisted stage-1 report whose
 * quality section completed and passed R5 — anything else is a refusal that
 * names where the passing report must come from, thrown before a single
 * request is built.
 */
export function requireStage1Pass(runtimeDir: string): JevStage1Report {
  const stage1 = readStage1Report(runtimeDir); // a missing report already names the path and command
  if (stage1.quality.status !== "complete" || stage1.quality.r5Passed !== true) {
    throw new Error(
      `Refusing to run stage 2: the persisted stage-1 report at "${stage1ReportPath(runtimeDir)}" ` +
        `does not record an R5 pass (quality status "${stage1.quality.status}", ` +
        `r5Passed ${stage1.quality.r5Passed === true ? "true" : String(stage1.quality.r5Passed)}) — ` +
        "rerun `duo eval jev stage1` and let it pass first (KTD5).",
    );
  }
  return stage1;
}

function buildReport(
  inputs: JevStage2Inputs,
  traces: readonly JevTraceDetail[],
  model: string,
  status: "complete" | "failed",
  failureSummary?: string,
): JevStage2Report {
  const totalSteps = traces.reduce((count, trace) => count + trace.steps.length, 0);
  const correctSteps = traces.reduce(
    (count, trace) => count + trace.steps.filter((step) => step.correct).length,
    0,
  );
  return {
    generatedAt: new Date().toISOString(),
    gatewayOrigin: inputs.gatewayOrigin,
    tracesHash: inputs.tracesHash,
    stage1: { generatedAt: inputs.stage1.generatedAt, gatewayOrigin: inputs.stage1.gatewayOrigin },
    ...(status === "failed" && failureSummary !== undefined ? { failureSummary } : {}),
    status,
    model,
    totalTraces: inputs.traces.length,
    completedTraces: traces.filter((trace) => trace.completed).length,
    totalSteps,
    correctSteps,
    stepAccuracy: totalSteps === 0 ? 0 : correctSteps / totalSteps,
    traces,
  };
}

/**
 * Thrown when the replay aborts mid-run. Carries the partial report built
 * from every step recorded before the failure so the wrapper can persist it
 * before rethrowing the original provider error (KTD6: the partial evidence
 * outlives the abort; the stage-1 numbers stay valid; the verdict reports
 * "navigation unknown").
 */
export class JevStage2AbortedError extends Error {
  readonly partial: JevStage2Report;
  readonly cause: unknown;

  constructor(partial: JevStage2Report, cause: unknown) {
    super(`Stage-2 replay aborted: ${partial.failureSummary ?? sanitizeFailure(cause)}`);
    this.name = "JevStage2AbortedError";
    this.partial = partial;
    this.cause = cause;
  }
}

/**
 * The pure replay: one Jev call per trace step through the encoding layer.
 * A wrong or out-of-menu top pick marks that step wrong and the replay
 * continues (AE3) — only a provider failure aborts, and then via
 * JevStage2AbortedError carrying the partial report. The in-flight trace is
 * included in the partial with the steps it had recorded.
 */
export async function runJevStage2Replay(
  provider: TypedDecisionProvider,
  inputs: JevStage2Inputs,
): Promise<JevStage2Report> {
  const traces: JevTraceDetail[] = [];
  let model = "unknown";

  for (const trace of inputs.traces) {
    const steps: JevTraceStepItem[] = [];
    try {
      for (const [stepIndex, step] of trace.steps.entries()) {
        const { state, question } = traceStepRequest(trace, step);
        const result = await provider.decide(state, [question]);
        model = result.model;
        const answer = result.answers[0];
        if (answer?.kind !== "choice") {
          throw new Error(`Jev answer for trace "${trace.id}" step ${stepIndex} was not a choice`);
        }
        const outcome = choiceOutcome(answer, step.candidates.map((candidate) => candidate.id));
        steps.push({
          traceId: trace.id,
          stepIndex,
          page: step.page,
          pick: outcome.pick,
          expected: step.correct,
          outOfMenu: outcome.outOfMenu,
          correct: !outcome.outOfMenu && outcome.pick === step.correct,
          ...(outcome.probabilities ? { probabilities: outcome.probabilities } : {}),
          ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
        });
      }
    } catch (error) {
      if (steps.length > 0) {
        traces.push({ id: trace.id, goal: trace.goal, steps, completed: false });
      }
      throw new JevStage2AbortedError(
        buildReport(inputs, traces, model, "failed", sanitizeFailure(error)),
        error,
      );
    }
    traces.push({ id: trace.id, goal: trace.goal, steps, completed: steps.every((step) => step.correct) });
  }

  return buildReport(inputs, traces, model, "complete");
}

export function stage2ReportPath(runtimeDir: string): string {
  return join(runtimeDir, "stage2-report.json");
}

export function persistStage2Report(runtimeDir: string, report: JevStage2Report): string {
  mkdirSync(runtimeDir, { recursive: true }); // recursive mkdir is a no-op on an existing dir
  const path = stage2ReportPath(runtimeDir);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function readStage2Report(runtimeDir: string): JevStage2Report {
  const path = stage2ReportPath(runtimeDir);
  if (!existsSync(path)) {
    throw new Error(`No stage-2 report found at "${path}" — run \`duo eval jev stage2\` first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as JevStage2Report;
}
