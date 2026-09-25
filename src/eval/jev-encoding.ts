import type { GateLabelExample, GateLabelValue } from "./gate-labels.js";
import type { JevMultiwayTask, JevTrace, JevTraceStep } from "./jev-fixtures.js";
import type { BinaryQuestion, ChoiceAnswer, BinaryAnswer, ChoiceQuestion } from "../provider/types.js";

/**
 * The pure translation between spike items and TypedDecisionProvider calls
 * (plan U3, KTD4): gate labels, multi-way tasks, and trace steps go in;
 * state-plus-question requests and decoded verdicts come out.
 *
 * Construction is constants-only (KTD10): every state field, instruction,
 * and criterion is built exclusively from fixture fields and the module-level
 * constants below — no DuoConfig value, filesystem read, or store content
 * can enter a request through this layer, which is what makes the R9
 * synthetic-only egress guarantee auditable at one place.
 */

export const BINARY_GATE_INSTRUCTIONS =
  "Is this a genuine question or request the owner would answer directly, rather than an FYI, status update, or chatter to ignore?";

export const MULTIWAY_INSTRUCTIONS =
  "Which candidate best achieves the stated goal for this scenario? Pick exactly one candidate id.";

export const TRACE_STEP_INSTRUCTIONS =
  "Which action best moves toward the goal from this page? Pick exactly one candidate id.";

export interface EncodedRequest {
  readonly state: Readonly<Record<string, unknown>>;
  readonly question: BinaryQuestion | ChoiceQuestion;
}

/** A gate label becomes a yes/no question over exactly the mention text — nothing else enters the state. */
export function gateLabelRequest(label: GateLabelExample): EncodedRequest {
  return {
    state: { mention: label.text },
    question: { kind: "binary", instructions: BINARY_GATE_INSTRUCTIONS },
  };
}

/** A multi-way task becomes a menu-picking question; the criteria map is the candidate list verbatim. */
export function multiwayTaskRequest(task: JevMultiwayTask): EncodedRequest {
  return {
    state: { scenario: task.scenario, goal: task.goal },
    question: {
      kind: "choice",
      instructions: MULTIWAY_INSTRUCTIONS,
      criteria: Object.fromEntries(task.candidates.map((candidate) => [candidate.id, candidate.description])),
    },
  };
}

/** A trace step becomes a menu-picking question over that step's candidates, with the trace's goal for context. */
export function traceStepRequest(trace: JevTrace, step: JevTraceStep): EncodedRequest {
  return {
    state: { goal: trace.goal, page: step.page },
    question: {
      kind: "choice",
      instructions: TRACE_STEP_INSTRUCTIONS,
      criteria: Object.fromEntries(step.candidates.map((candidate) => [candidate.id, candidate.description])),
    },
  };
}

/**
 * Strictly greater than 0.5 → answerable; exactly 0.5 → not answerable. The
 * tie goes to refusal because the gate this measures is an asymmetric
 * precision-first design (AR-1): a coin-flip answer is not evidence of a
 * genuine question.
 */
export function binaryVerdict(answer: BinaryAnswer): GateLabelValue {
  return answer.probability > 0.5 ? "answerable" : "not_answerable";
}

export interface ChoiceOutcome {
  readonly pick: string;
  /** True when the picked id is not among the offered criteria — scored as a wrong pick, never an error (AE3). */
  readonly outOfMenu: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

/** Records a choice answer with its full ranking; out-of-menu picks are marked, not thrown on. */
export function choiceOutcome(answer: ChoiceAnswer, validIds: readonly string[]): ChoiceOutcome {
  return {
    pick: answer.pick,
    outOfMenu: !validIds.includes(answer.pick),
    ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
  };
}
