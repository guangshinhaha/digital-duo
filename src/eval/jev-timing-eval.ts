import type { DuoConfig } from "../config.js";
import { GATE_LABEL_VALUES, type GateLabelExample } from "./gate-labels.js";
import { multiwayTaskRequest } from "./jev-encoding.js";
import type { JevMultiwayTask } from "./jev-fixtures.js";
import { sanitizeFailure } from "./jev-gate-eval.js";
import { resolveProvider } from "../provider/registry.js";
import {
  ProviderConfigError,
  ProviderError,
  type InferenceProvider,
  type TypedDecisionQuestion,
  type TypedDecisionProvider,
} from "../provider/types.js";

/**
 * Stage 1's timing/cost pass and its Ollama reference (plan U5, R6, KTD9):
 * per-decision milliseconds and dollars for Jev's measured calls, and a
 * same-questions reference through the local completion provider. The
 * reference reports accuracy and parse-failure rate only — R6's
 * milliseconds and dollars attach to Jev's calls, never to the reference.
 */

export interface JevTimingSection {
  readonly status: "complete" | "failed";
  readonly failureSummary?: string;
  readonly decisionCount?: number;
  readonly warmupMs?: number;
  readonly meanMsPerDecision?: number;
  readonly medianMsPerDecision?: number;
  readonly totalWallMs?: number;
  readonly totalInputTokens?: number;
  readonly totalDollars?: number;
  readonly dollarsPerDecision?: number;
  readonly pricePerMTok?: number;
}

export interface JevReferenceSection {
  readonly status: "complete" | "failed" | "gap";
  readonly total: number;
  readonly gapReason?: string;
  readonly failureSummary?: string;
  readonly accuracy?: number;
  readonly parseFailureCount?: number;
  readonly parseFailureRate?: number;
}

export interface ReferenceQuestion {
  /** The synthetic decision text the reference answers from. */
  readonly promptBody: string;
  /** The only acceptable answers, exactly matched after trim. */
  readonly options: readonly string[];
  readonly correct: string;
}

/** One untimed warmup call, then one measured call per task (confidence.ts's timing shape, plus a median). */
export async function runJevTimingPass(
  provider: TypedDecisionProvider,
  tasks: readonly JevMultiwayTask[],
  pricePerMTok: number,
  now: () => number = Date.now,
): Promise<JevTimingSection> {
  if (tasks.length === 0) {
    return { status: "failed", failureSummary: "no multi-way tasks to time" };
  }

  const warmupStart = now();
  await provider.decide(...requestFor(tasks[0]));
  const warmupMs = now() - warmupStart;

  const durations: number[] = [];
  let totalInputTokens = 0;
  const wallStart = now();
  for (const task of tasks) {
    const start = now();
    const result = await provider.decide(...requestFor(task));
    durations.push(now() - start);
    totalInputTokens += result.usage.inputTokens;
  }
  const totalWallMs = now() - wallStart;

  const decisionCount = durations.length;
  const meanMs = durations.reduce((sum, value) => sum + value, 0) / decisionCount;
  const sorted = [...durations].sort((a, b) => a - b);
  const medianMs =
    decisionCount % 2 === 1
      ? sorted[(decisionCount - 1) / 2]
      : (sorted[decisionCount / 2 - 1] + sorted[decisionCount / 2]) / 2;

  const totalDollars = (totalInputTokens * pricePerMTok) / 1_000_000;

  return {
    status: "complete",
    decisionCount,
    warmupMs,
    meanMsPerDecision: meanMs,
    medianMsPerDecision: medianMs,
    totalWallMs,
    totalInputTokens,
    totalDollars,
    dollarsPerDecision: totalDollars / decisionCount,
    pricePerMTok,
  };
}

function requestFor(task: JevMultiwayTask): [Readonly<Record<string, unknown>>, readonly TypedDecisionQuestion[]] {
  const { state, question } = multiwayTaskRequest(task);
  return [state, [question]];
}

/**
 * The same binary and choice questions the Jev run answered, phrased as
 * strict one-option-id prompts for a text completion model (KTD9). Only
 * synthetic fixture content enters these prompts — the same fields the
 * encoding layer sends.
 */
export function buildReferenceQuestions(
  labels: readonly GateLabelExample[],
  tasks: readonly JevMultiwayTask[],
): ReferenceQuestion[] {
  const labelQuestions = labels.map((label) => ({
    promptBody: `Mention: ${label.text}`,
    options: GATE_LABEL_VALUES,
    correct: label.expected,
  }));
  const taskQuestions = tasks.map((task) => ({
    promptBody:
      `Scenario: ${task.scenario}\nGoal: ${task.goal}\nOptions:\n` +
      task.candidates.map((candidate) => `${candidate.id} — ${candidate.description}`).join("\n"),
    options: task.candidates.map((candidate) => candidate.id),
    correct: task.correct,
  }));
  return [...labelQuestions, ...taskQuestions];
}

export function referencePrompt(question: ReferenceQuestion): string {
  return (
    `${question.promptBody}\n` +
    "Answer with exactly one of the following option ids and nothing else: " +
    `${question.options.join(", ")}`
  );
}

/**
 * Runs the reference questions through a completion provider.
 * An answer that is not exactly one option id after trimming counts wrong
 * and is tallied as a parse failure — wrong, never aborted (KTD9).
 */
export async function runOllamaReference(
  provider: InferenceProvider,
  questions: readonly ReferenceQuestion[],
): Promise<JevReferenceSection> {
  let correctCount = 0;
  let parseFailureCount = 0;
  for (const question of questions) {
    const completion = await provider.complete(referencePrompt(question));
    const picked = completion.trim();
    if (question.options.includes(picked)) {
      if (picked === question.correct) {
        correctCount += 1;
      }
    } else {
      parseFailureCount += 1;
    }
  }
  return {
    status: "complete",
    total: questions.length,
    accuracy: questions.length === 0 ? 0 : correctCount / questions.length,
    parseFailureCount,
    parseFailureRate: questions.length === 0 ? 0 : parseFailureCount / questions.length,
  };
}

/**
 * Resolves the completion provider and runs the reference, degrading to a
 * named gap on any configuration problem or reference-path call failure so
 * stage 1 still completes and the verdict records the gap (KTD9).
 */
export async function runOllamaReferenceSection(
  config: DuoConfig,
  labels: readonly GateLabelExample[],
  tasks: readonly JevMultiwayTask[],
): Promise<JevReferenceSection> {
  const questions = buildReferenceQuestions(labels, tasks);
  let provider: InferenceProvider;
  try {
    provider = resolveProvider(config);
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return { status: "gap", total: questions.length, gapReason: `${error.name}: ${error.message}` };
    }
    throw error;
  }
  try {
    return await runOllamaReference(provider, questions);
  } catch (error) {
    if (error instanceof ProviderError) {
      return { status: "gap", total: questions.length, failureSummary: sanitizeFailure(error) };
    }
    throw error;
  }
}
