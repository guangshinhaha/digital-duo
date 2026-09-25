import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Loaders for the Jev spike's hand-authored synthetic fixtures (plan U2,
 * docs/plans/2026-09-20-1759-spike-jev-typed-decisions-plan.md).
 *
 * Both checked-in files carry a `provenance` root field declaring them
 * synthetic-only: everything in them is invented, which is exactly why they
 * are egress-eligible (R9) — no owner or user content leaves this machine in
 * a request built from these fixtures. The loaders enforce that declaration
 * rather than assuming it, because these files are the one place synthetic
 * and real material could silently mix: real recorded navigation must go to
 * a different path, never these egress-audited files (KTD10, R8).
 *
 * Validation discipline copies src/eval/gate-labels.ts: the whole `items`
 * array is validated up front and a single malformed entry fails the whole
 * load with the offending index or id named — no silent drops, because a
 * quietly skewed fixture set would corrupt every number the spike reports.
 */

export class InvalidJevFixtureError extends Error {}

export interface JevFixtureCandidate {
  readonly id: string;
  readonly description: string;
}

/** One multi-way decision task: a scenario, a goal, a menu, one correct pick. */
export interface JevMultiwayTask {
  readonly id: string;
  readonly scenario: string;
  readonly goal: string;
  readonly candidates: readonly JevFixtureCandidate[];
  readonly correct: string;
}

/** One step of a navigation trace: where you are, what you can do, the right move. */
export interface JevTraceStep {
  readonly page: string;
  readonly candidates: readonly JevFixtureCandidate[];
  readonly correct: string;
}

export interface JevTrace {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly JevTraceStep[];
}

/**
 * SHA-256 of a fixture file's exact bytes, so persisted reports record
 * precisely which fixture content produced them (KTD5).
 */
export function fixtureSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readRoot(path: string, envVar: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new InvalidJevFixtureError(
      `No Jev spike fixture found at "${path}" — the fixture ships with the repo; ` +
        `restore it or point ${envVar} at the right file.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InvalidJevFixtureError(`Malformed ${path}: not valid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidJevFixtureError(`Malformed ${path}: expected a JSON object with "provenance" and "items"`);
  }
  return parsed as Record<string, unknown>;
}

function requireItems(path: string, root: Record<string, unknown>): unknown[] {
  const provenance = root.provenance;
  if (typeof provenance !== "object" || provenance === null) {
    throw new InvalidJevFixtureError(`Malformed ${path}: missing the "provenance" object`);
  }
  if ((provenance as Record<string, unknown>).synthetic !== true) {
    throw new InvalidJevFixtureError(
      `Malformed ${path}: provenance must declare "synthetic": true — this file is egress-eligible ` +
        "only because its content is invented; real material belongs elsewhere (KTD10, R8)",
    );
  }
  const items = root.items;
  if (!Array.isArray(items)) {
    throw new InvalidJevFixtureError(`Malformed ${path}: "items" must be an array`);
  }
  if (items.length === 0) {
    throw new InvalidJevFixtureError(`Malformed ${path}: "items" is empty`);
  }
  return items;
}

function requireString(path: string, where: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidJevFixtureError(`Malformed ${path}: ${where} is missing a non-empty "${field}"`);
  }
  return value;
}

function requireCandidates(
  path: string,
  where: string,
  value: unknown,
): readonly JevFixtureCandidate[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new InvalidJevFixtureError(`Malformed ${path}: ${where} needs at least two candidates`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new InvalidJevFixtureError(`Malformed ${path}: ${where} candidate ${index} is not an object`);
    }
    const raw = candidate as Record<string, unknown>;
    const id = requireString(path, `${where} candidate ${index}`, "id", raw.id);
    if (seen.has(id)) {
      throw new InvalidJevFixtureError(`Malformed ${path}: ${where} has a duplicate candidate id "${id}"`);
    }
    seen.add(id);
    const description = requireString(path, `${where} candidate "${id}"`, "description", raw.description);
    return { id, description };
  });
}

function requireCorrectIn(path: string, where: string, correct: unknown, candidates: readonly JevFixtureCandidate[]): string {
  if (typeof correct !== "string" || !candidates.some((c) => c.id === correct)) {
    throw new InvalidJevFixtureError(
      `Malformed ${path}: ${where} has a "correct" ("${String(correct)}") that is not one of its candidate ids`,
    );
  }
  return correct;
}

/**
 * Reads and validates the synthetic multi-way task set. Every entry is
 * validated before any is returned — one malformed task fails the load.
 */
export function loadJevMultiwayTasks(path: string): JevMultiwayTask[] {
  const root = readRoot(path, "DUO_EVAL_JEV_MULTIWAY_TASKS_PATH");
  const items = requireItems(path, root);

  const seenIds = new Set<string>();
  return items.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new InvalidJevFixtureError(`Malformed ${path}: entry at index ${index} is not an object`);
    }
    const raw = item as Record<string, unknown>;
    const id = requireString(path, `entry at index ${index}`, "id", raw.id);
    if (seenIds.has(id)) {
      throw new InvalidJevFixtureError(`Malformed ${path}: duplicate entry id "${id}"`);
    }
    seenIds.add(id);
    const scenario = requireString(path, `entry "${id}"`, "scenario", raw.scenario);
    const goal = requireString(path, `entry "${id}"`, "goal", raw.goal);
    const candidates = requireCandidates(path, `entry "${id}"`, raw.candidates);
    const correct = requireCorrectIn(path, `entry "${id}"`, raw.correct, candidates);
    return { id, scenario, goal, candidates, correct };
  });
}

/**
 * Reads and validates the synthetic navigation traces. Each step is checked
 * on its own — a step whose `correct` action is not among that step's
 * candidates is rejected at load, naming the trace and the step index.
 */
export function loadJevTraces(path: string): JevTrace[] {
  const root = readRoot(path, "DUO_EVAL_JEV_TRACES_PATH");
  const items = requireItems(path, root);

  const seenIds = new Set<string>();
  return items.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new InvalidJevFixtureError(`Malformed ${path}: entry at index ${index} is not an object`);
    }
    const raw = item as Record<string, unknown>;
    const id = requireString(path, `entry at index ${index}`, "id", raw.id);
    if (seenIds.has(id)) {
      throw new InvalidJevFixtureError(`Malformed ${path}: duplicate entry id "${id}"`);
    }
    seenIds.add(id);
    const goal = requireString(path, `entry "${id}"`, "goal", raw.goal);
    const steps = raw.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new InvalidJevFixtureError(`Malformed ${path}: trace "${id}" has no steps`);
    }
    const parsedSteps = steps.map((step, stepIndex) => {
      if (typeof step !== "object" || step === null) {
        throw new InvalidJevFixtureError(`Malformed ${path}: trace "${id}" step ${stepIndex} is not an object`);
      }
      const rawStep = step as Record<string, unknown>;
      const page = requireString(path, `trace "${id}" step ${stepIndex}`, "page", rawStep.page);
      const candidates = requireCandidates(path, `trace "${id}" step ${stepIndex}`, rawStep.candidates);
      const correct = requireCorrectIn(path, `trace "${id}" step ${stepIndex}`, rawStep.correct, candidates);
      return { page, candidates, correct };
    });
    return { id, goal, steps: parsedSteps };
  });
}
