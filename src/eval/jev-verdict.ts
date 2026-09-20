import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuoConfig } from "../config.js";
import { readStage1Report, type JevStage1Report } from "./jev-gate-eval.js";
import { readStage2Report, stage2ReportPath, type JevStage2Report } from "./jev-trace-eval.js";

/**
 * The Jev spike's verdict assembler (plan U7): reads the persisted stage-1
 * and stage-2 reports, maps them to a recommended verdict, and writes
 * `verdict.md` under the configured runtime dir.
 *
 * KTD7 discipline: the markdown is assembled from aggregate fields only —
 * no per-item data, no request bodies, no raw failure dumps — so the file
 * is safe to promote into docs/ by construction. The verdict is marked as
 * the spike's recommendation; the owner makes the final call.
 *
 * KTD6 discipline: "inconclusive" is reserved for a quality section that
 * never completed. Every other gap or failure still yields a decision —
 * adopt-with-conditions with the gap named — because an earned quality
 * pass is not erased by a later section failing.
 */

export type JevVerdictValue = "adopt" | "adopt-with-conditions" | "don't adopt" | "inconclusive";

export interface JevVerdictResult {
  readonly verdict: JevVerdictValue;
  /** The named conditions behind an adopt-with-conditions (empty for adopt). */
  readonly conditions: readonly string[];
  readonly markdown: string;
  readonly path: string;
}

export function verdictPath(runtimeDir: string): string {
  return join(runtimeDir, "verdict.md");
}

/**
 * The recommended-verdict mapping, stated in one place:
 * - quality never completed → inconclusive (the only inconclusive, KTD6);
 * - quality completed but R5 failed → don't adopt;
 * - quality passed but any headline figure is degenerate, gapped, or failed
 *   → adopt-with-conditions, each gap named;
 * - otherwise → adopt.
 */
export function recommendJevVerdict(
  stage1: JevStage1Report,
  stage2: JevStage2Report | undefined,
): { verdict: JevVerdictValue; conditions: readonly string[] } {
  if (stage1.quality.status === "failed") {
    return {
      verdict: "inconclusive",
      conditions: [`Stage-1 quality run never completed: ${stage1.quality.failureSummary ?? "no summary recorded"}.`],
    };
  }
  if (stage1.quality.r5Passed !== true) {
    return {
      verdict: "don't adopt",
      conditions: ["Jev's precision on the same labels fell below the deterministic gate's (R5 failed) — see stage1-report.json."],
    };
  }

  const conditions: string[] = [];
  const jev = stage1.jev;
  if (jev && jev.answerableCount === 0) {
    conditions.push(
      "Degenerate quality run: Jev marked nothing answerable, so precision 1.000 is the zero-prediction convention, not discrimination.",
    );
  }
  const timing = stage1.timing;
  if (!timing) {
    conditions.push("Timing/cost figures are absent — no timing section is recorded on the passing stage-1 report.");
  } else if (timing.status === "failed") {
    conditions.push(`Timing/cost figures are unavailable: ${timing.failureSummary ?? "no summary recorded"}.`);
  }
  const reference = stage1.reference;
  if (reference?.status === "gap") {
    conditions.push(`No local-model reference: ${reference.gapReason ?? "unnamed gap"}.`);
  } else if (reference?.status === "failed") {
    conditions.push(`The local-model reference failed: ${reference.failureSummary ?? "no summary recorded"}.`);
  }
  if (!stage2) {
    conditions.push("Stage 2 (navigation replay) was not run — navigation is unknown.");
  } else if (stage2.status === "failed") {
    conditions.push(`Navigation is unknown: the replay aborted (${stage2.failureSummary ?? "no summary recorded"}).`);
  }

  return { verdict: conditions.length > 0 ? "adopt-with-conditions" : "adopt", conditions };
}

function stage2Line(stage2: JevStage2Report | undefined): string {
  if (!stage2) {
    return "- Stage 2 (navigation replay): not run — navigation unknown.";
  }
  if (stage2.status === "failed") {
    return `- Stage 2 (navigation replay): aborted — ${stage2.failureSummary ?? "no summary recorded"}. Navigation unknown.`;
  }
  return (
    `- Stage 2 (navigation replay): step accuracy ${stage2.stepAccuracy.toFixed(3)} ` +
    `(${stage2.correctSteps}/${stage2.totalSteps} steps), ${stage2.completedTraces}/${stage2.totalTraces} traces completed.`
  );
}

function timingLine(stage1: JevStage1Report): string {
  const timing = stage1.timing;
  if (!timing) {
    return "- Timing/cost: not recorded on this report.";
  }
  if (timing.status === "failed") {
    return `- Timing/cost: unavailable — ${timing.failureSummary ?? "no summary recorded"}.`;
  }
  return (
    `- Timing/cost: mean ${timing.meanMsPerDecision?.toFixed(0)} ms, median ${timing.medianMsPerDecision?.toFixed(0)} ms per decision ` +
    `over ${timing.decisionCount} decision(s); $${timing.totalDollars?.toFixed(6)} total ` +
    `($${timing.dollarsPerDecision?.toFixed(8)} per decision) at $${timing.pricePerMTok}/MTok input, warmup excluded.`
  );
}

function referenceLine(stage1: JevStage1Report): string {
  const reference = stage1.reference;
  if (!reference) {
    return "- Local reference (Ollama): not recorded on this report.";
  }
  if (reference.status === "gap") {
    return `- Local reference (Ollama): gap — ${reference.gapReason ?? "unnamed gap"}.`;
  }
  if (reference.status === "failed") {
    return `- Local reference (Ollama): failed — ${reference.failureSummary ?? "no summary recorded"}.`;
  }
  return (
    `- Local reference (Ollama): accuracy ${reference.accuracy?.toFixed(3)} over ${reference.total} question(s), ` +
    `${reference.parseFailureCount} unparseable answer(s) (${(reference.parseFailureRate ?? 0).toFixed(3)}).`
  );
}

/** Assembles verdict.md from aggregates only (KTD7). */
export function buildJevVerdictMarkdown(
  stage1: JevStage1Report,
  stage2: JevStage2Report | undefined,
  verdict: JevVerdictValue,
  conditions: readonly string[],
  writtenAt: string,
): string {
  const jev = stage1.jev;
  const multiway = stage1.multiway;
  const baseline = stage1.baseline;
  const lines: string[] = [
    "# Jev typed-decision spike — verdict",
    "",
    `**Recommendation: ${verdict}.** This is the spike's recommendation; the owner makes the final call.`,
    "",
    `Written ${writtenAt} · Gateway origin: ${stage1.gatewayOrigin} · Model: ${jev?.model ?? stage2?.model ?? "unknown"}`,
    "",
    "## How to read these numbers",
    "",
    "- The comparator is the deterministic relevance gate scored on the same hand-labelled mentions: " +
      `precision ${baseline.precision.toFixed(3)} (${baseline.truePositives}/${baseline.truePositives + baseline.falsePositives} ` +
      `answerable calls correct, ${baseline.falsePositives} false positives). Matching it means matching that precision on ` +
      "those labels — at zero gate false positives, a single Jev false positive fails the bar (R5, compared by integer " +
      "cross-multiplication, never float division).",
  ];
  if (jev) {
    lines.push(
      `- Jev marked ${jev.answerableCount}/${jev.total} mentions answerable: precision ${jev.precision.toFixed(3)}, ` +
        `recall ${jev.recall.toFixed(3)} (${jev.truePositives} TP / ${jev.falsePositives} FP / ${jev.falseNegatives} FN).`,
    );
  }
  if (multiway) {
    lines.push(
      `- Multi-way task accuracy: ${multiway.accuracy.toFixed(3)} (${multiway.correctCount}/${multiway.total} tasks, ` +
        `${multiway.outOfMenuCount} out-of-menu picks).`,
    );
  }
  lines.push(stage2Line(stage2), timingLine(stage1), referenceLine(stage1));
  if (stage1.refusalsLoaded > 0) {
    lines.push(
      `- Baseline parity caveat: the deterministic gate ran with ${stage1.refusalsLoaded} local refusal(s) loaded from ` +
        "duo/refusals.md; Jev received none of them (refusals never leave the machine).",
    );
  }
  lines.push(
    "",
    "## Conditions",
    "",
    ...(conditions.length > 0
      ? conditions.map((condition) => `- ${condition}`)
      : ["- None — every headline figure is present and non-degenerate."]),
    "",
    "## Provenance",
    "",
    `- stage1-report.json — gate-labels fixture ${stage1.fixtureHashes.gateLabels.slice(0, 12)}…, ` +
      `multi-way fixture ${stage1.fixtureHashes.multiwayTasks.slice(0, 12)}…, generated ${stage1.generatedAt}.`,
  );
  if (stage2) {
    lines.push(`- stage2-report.json — traces fixture ${stage2.tracesHash.slice(0, 12)}…, generated ${stage2.generatedAt}.`);
  } else {
    lines.push("- stage2-report.json — absent.");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Implements `duo eval jev verdict`: reads the persisted reports and writes
 * verdict.md. Stage 1 must exist (its absence names the command that
 * produces it); a missing stage 2 is a named condition, not an error.
 */
export function runJevVerdict(config: DuoConfig, now: () => Date = () => new Date()): JevVerdictResult {
  const runtimeDir = config.jev.runtimeDir;
  const stage1 = readStage1Report(runtimeDir); // throws naming `duo eval jev stage1` when missing
  const stage2 = existsSync(stage2ReportPath(runtimeDir)) ? readStage2Report(runtimeDir) : undefined;

  const { verdict, conditions } = recommendJevVerdict(stage1, stage2);
  const markdown = buildJevVerdictMarkdown(stage1, stage2, verdict, conditions, now().toISOString());
  const path = verdictPath(runtimeDir);
  writeFileSync(path, markdown);
  return { verdict, conditions, markdown, path };
}
