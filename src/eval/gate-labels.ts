import { existsSync, readFileSync } from "node:fs";

/**
 * #36: the ground truth a hand-labelled mention is marked with — never
 * derived or auto-labelled by a model (#36's own out-of-scope list: "the
 * labels are the ground truth and are made by hand").
 */
export const GATE_LABEL_VALUES = ["answerable", "not_answerable"] as const;
export type GateLabelValue = (typeof GATE_LABEL_VALUES)[number];

/**
 * One hand-labelled mention. `mentionType` is a free-form category (e.g.
 * "genuine_question", "fyi", "mixed_signal") — not the gate's own
 * GateReason — describing *what kind of real mention this is*, so #36 AC3
 * ("label coverage is reported") can show the distribution across mention
 * shapes, not just a raw pass count.
 */
export interface GateLabelExample {
  readonly id: string;
  readonly text: string;
  readonly mentionType: string;
  readonly expected: GateLabelValue;
}

/** Thrown when the checked-in label file exists but isn't well-formed, or doesn't exist at all — unlike duo/topics.json's "missing means not configured yet", this file ships with the repo, so a missing or malformed one is a real setup problem, not a normal empty state. */
export class InvalidGateLabelsError extends Error {}

function isGateLabelValue(value: unknown): value is GateLabelValue {
  return typeof value === "string" && (GATE_LABEL_VALUES as readonly string[]).includes(value);
}

/**
 * Reads and validates the hand-labelled relevance-gate mention set (#36
 * AC: "the labelled set lives in the repo and is versioned"). Every entry
 * is validated up front — a single malformed entry fails the whole load
 * with the offending index named, rather than silently dropping it and
 * quietly skewing the coverage/precision numbers.
 */
export function loadGateLabels(path: string): GateLabelExample[] {
  if (!existsSync(path)) {
    throw new InvalidGateLabelsError(
      `No relevance-gate label set found at "${path}". #36's hand-labelled mentions are checked into the ` +
        "repo — create it (or point DUO_EVAL_GATE_LABELS_PATH at the right file) before running the gate eval.",
    );
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidGateLabelsError(`Malformed ${path}: expected a JSON array of label entries`);
  }

  const seenIds = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidGateLabelsError(`Malformed ${path}: entry at index ${index} is not an object`);
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new InvalidGateLabelsError(`Malformed ${path}: entry at index ${index} is missing a non-empty "id"`);
    }
    if (seenIds.has(raw.id)) {
      throw new InvalidGateLabelsError(`Malformed ${path}: duplicate entry id "${raw.id}"`);
    }
    seenIds.add(raw.id);
    if (typeof raw.text !== "string" || raw.text.length === 0) {
      throw new InvalidGateLabelsError(`Malformed ${path}: entry "${raw.id}" is missing a non-empty "text"`);
    }
    if (typeof raw.mentionType !== "string" || raw.mentionType.length === 0) {
      throw new InvalidGateLabelsError(`Malformed ${path}: entry "${raw.id}" is missing a non-empty "mentionType"`);
    }
    if (!isGateLabelValue(raw.expected)) {
      throw new InvalidGateLabelsError(
        `Malformed ${path}: entry "${raw.id}" has an invalid "expected" (expected one of ${GATE_LABEL_VALUES.join(", ")})`,
      );
    }
    return { id: raw.id, text: raw.text, mentionType: raw.mentionType, expected: raw.expected };
  });
}
