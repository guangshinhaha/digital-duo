import { classifyMention } from "../drafting/relevance-gate.js";
import type { GateLabelExample, GateLabelValue } from "./gate-labels.js";

/** One labelled example, scored against the gate's real verdict. */
export interface GateEvalItem extends GateLabelExample {
  readonly actual: GateLabelValue;
  readonly correct: boolean;
}

/** Below this many labelled examples, a mention type's own score is too thin to trust — #36 AC3. */
export const MIN_LABELS_PER_MENTION_TYPE = 3;

export interface GateEvalReport {
  readonly total: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  /**
   * TP / (TP + FP). When nothing was predicted "answerable" at all
   * (TP + FP === 0), reported as a perfect 1 rather than an undefined
   * 0/0 — a gate that predicted nothing made none of the mistakes
   * precision measures, the same "no positive predictions, no false
   * positives possible" reasoning the gate's own asymmetric design rests
   * on (v1-tech-design.md §1.6: a missed draft costs nothing).
   */
  readonly precision: number;
  /** TP / (TP + FN); 0, never NaN, when the label set has no "answerable" examples at all. */
  readonly recall: number;
  /** Named explicitly, per #36 AC2 ("names the newly admitted false positives") — never just a count. */
  readonly falsePositiveExamples: readonly GateEvalItem[];
  readonly falseNegativeExamples: readonly GateEvalItem[];
  /** How many labelled examples exist per mentionType — #36 AC3. */
  readonly coverageByMentionType: Readonly<Record<string, number>>;
  /** mentionTypes with fewer than MIN_LABELS_PER_MENTION_TYPE examples — flagged so a good aggregate score isn't mistaken for a good score on an under-represented mention shape. */
  readonly underrepresentedMentionTypes: readonly string[];
  readonly items: readonly GateEvalItem[];
}

/**
 * Runs the real relevance gate (classifyMention — the same function
 * src/drafting/gate.ts calls in production, not a stand-in) over a
 * hand-labelled set and scores it. Precision and recall are reported
 * separately, never averaged into one figure (#36 AC1's own "never a
 * single figure that hides a precision failure") since this gate's whole
 * design is an asymmetric bet on precision over recall (AR-1).
 */
export function scoreRelevanceGate(labels: readonly GateLabelExample[], refusals: readonly string[] = []): GateEvalReport {
  const items: GateEvalItem[] = labels.map((label) => {
    const verdict = classifyMention(label.text, refusals);
    const actual: GateLabelValue = verdict.passes ? "answerable" : "not_answerable";
    return { ...label, actual, correct: actual === label.expected };
  });

  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  for (const item of items) {
    if (item.expected === "answerable" && item.actual === "answerable") {
      truePositives += 1;
    } else if (item.expected === "not_answerable" && item.actual === "answerable") {
      falsePositives += 1;
    } else if (item.expected === "not_answerable" && item.actual === "not_answerable") {
      trueNegatives += 1;
    } else {
      falseNegatives += 1;
    }
  }

  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);

  const coverageByMentionType: Record<string, number> = {};
  for (const item of items) {
    coverageByMentionType[item.mentionType] = (coverageByMentionType[item.mentionType] ?? 0) + 1;
  }
  const underrepresentedMentionTypes = Object.entries(coverageByMentionType)
    .filter(([, count]) => count < MIN_LABELS_PER_MENTION_TYPE)
    .map(([mentionType]) => mentionType)
    .sort();

  return {
    total: items.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision,
    recall,
    falsePositiveExamples: items.filter((item) => item.expected === "not_answerable" && item.actual === "answerable"),
    falseNegativeExamples: items.filter((item) => item.expected === "answerable" && item.actual === "not_answerable"),
    coverageByMentionType,
    underrepresentedMentionTypes,
    items,
  };
}

/**
 * Thrown when a run's precision drops below the stated floor (#36 AC2:
 * "fails against the stated precision floor and names the newly admitted
 * false positives"). A real Error, not a boolean result the caller might
 * silently discard — the CLI's `duo eval gate` surfaces this by exiting
 * non-zero, the closest this CI-less repo has to "fails loudly".
 */
export class PrecisionFloorViolationError extends Error {
  readonly floor: number;
  readonly precision: number;
  readonly falsePositives: readonly GateEvalItem[];

  constructor(floor: number, precision: number, falsePositives: readonly GateEvalItem[]) {
    const named =
      falsePositives.length === 0
        ? "none named"
        : falsePositives.map((item) => `"${item.text}" (${item.id}, mentionType "${item.mentionType}")`).join("; ");
    super(
      `Relevance-gate precision ${precision.toFixed(3)} is below the stated floor ${floor} — newly admitted false positive(s): ${named}.`,
    );
    this.name = "PrecisionFloorViolationError";
    this.floor = floor;
    this.precision = precision;
    this.falsePositives = falsePositives;
  }
}

/** Throws PrecisionFloorViolationError when `report.precision` sits below `floor`; otherwise a no-op. */
export function assertPrecisionFloor(report: GateEvalReport, floor: number): void {
  if (report.precision < floor) {
    throw new PrecisionFloorViolationError(floor, report.precision, report.falsePositiveExamples);
  }
}
