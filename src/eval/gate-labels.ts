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

/**
 * Thrown by loadGateLabelsForEgress when the label file does not declare
 * itself synthetic: stage 1 sends label text to the hosted gateway, so the
 * Jev path may only load a file carrying `provenance: {synthetic: true}` —
 * the same declaration src/eval/jev-fixtures.ts enforces on its fixtures.
 */
export class GateLabelsNotSyntheticError extends InvalidGateLabelsError {}

function isGateLabelValue(value: unknown): value is GateLabelValue {
  return typeof value === "string" && (GATE_LABEL_VALUES as readonly string[]).includes(value);
}

interface ParsedGateLabelsFile {
  readonly entries: unknown[];
  /**
   * True only when the file is the `{provenance, items}` envelope AND its
   * provenance declared `synthetic: true`. A legacy bare array carries no
   * declaration, so it loads locally but never egresses.
   */
  readonly declaredSynthetic: boolean;
}

function parseGateLabelsFile(path: string): ParsedGateLabelsFile {
  if (!existsSync(path)) {
    throw new InvalidGateLabelsError(
      `No relevance-gate label set found at "${path}". #36's hand-labelled mentions are checked into the ` +
        "repo — create it (or point DUO_EVAL_GATE_LABELS_PATH at the right file) before running the gate eval.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InvalidGateLabelsError(`Malformed ${path}: not valid JSON (${(error as Error).message})`);
  }

  if (Array.isArray(parsed)) {
    return { entries: parsed, declaredSynthetic: false };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root.items)) {
      const provenance = root.provenance;
      const declared =
        typeof provenance === "object" &&
        provenance !== null &&
        (provenance as Record<string, unknown>).synthetic === true;
      return { entries: root.items, declaredSynthetic: declared };
    }
  }
  throw new InvalidGateLabelsError(
    `Malformed ${path}: expected a JSON array of label entries, or an object with "provenance" and "items"`,
  );
}

function validateEntries(path: string, entries: readonly unknown[]): GateLabelExample[] {
  const seenIds = new Set<string>();
  return entries.map((entry, index) => {
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

/**
 * Reads and validates the hand-labelled relevance-gate mention set (#36
 * AC: "the labelled set lives in the repo and is versioned"). Accepts both
 * shapes the repo has shipped: the legacy bare array and the
 * `{provenance, items}` envelope — this loader feeds the *local*
 * deterministic gate eval, which egresses nothing. Every entry is
 * validated up front — a single malformed entry fails the whole load
 * with the offending index named, rather than silently dropping it and
 * quietly skewing the coverage/precision numbers.
 */
export function loadGateLabels(path: string): GateLabelExample[] {
  return validateEntries(path, parseGateLabelsFile(path).entries);
}

/**
 * The egress gate for stage 1 (R9): `duo eval jev stage1` builds gateway
 * requests from each label's text, so it loads through this stricter
 * variant. A file without `provenance: {synthetic: true}` — including the
 * legacy bare-array shape — loads for the local gate eval but can never
 * reach the hosted gateway, so a future real-content label set cannot
 * silently egress by being dropped in the default path.
 */
export function loadGateLabelsForEgress(path: string): GateLabelExample[] {
  const parsed = parseGateLabelsFile(path);
  if (!parsed.declaredSynthetic) {
    throw new GateLabelsNotSyntheticError(
      `Gate labels at "${path}" are not egress-eligible: the file must declare "provenance": {"synthetic": true} — ` +
        "stage 1 sends label text to the hosted gateway, and only invented content may leave the machine (R9, KTD10). " +
        "Real recorded mentions belong in a separate file the Jev path never loads.",
    );
  }
  return validateEntries(path, parsed.entries);
}
