import { loadGateLabels } from "../../src/eval/gate-labels.js";
import { loadJevMultiwayTasks } from "../../src/eval/jev-fixtures.js";
import { binaryResult, choiceResult } from "../fixtures/fake-jev-provider.js";
import type { TypedDecisionResult } from "../../src/provider/types.js";

/**
 * The real checked-in fixtures plus the all-correct answer script over them,
 * shared by the stage-1 quality and timing suites. Loading through the
 * fail-loud loaders (not raw JSON.parse) keeps these tests honest about
 * fixture shape for free.
 */
export const REAL_LABELS = loadGateLabels("eval/gate-labels.json");
export const MULTIWAY_TASKS = loadJevMultiwayTasks("eval/jev-multiway-tasks.json");

/** Labels in order then tasks in order, every top pick correct. */
export function perfectScript(): TypedDecisionResult[] {
  return [
    ...REAL_LABELS.map((label) => binaryResult(label.expected === "answerable" ? 0.9 : 0.2)),
    ...MULTIWAY_TASKS.map((task) => choiceResult(task.correct)),
  ];
}
