import { CLASSIFICATION_LEVELS, type ClassificationLevel, type RecordClassification } from "../ingest/record.js";
import { deleteRecords, listRecords } from "../ingest/record-store.js";

/** The safe-by-default ceiling until policy configures a different one (v1-tech-design.md §2: a pilot corpus is "probably ... Official (Open) only"). */
export const DEFAULT_CLASSIFICATION_CEILING: ClassificationLevel = "official_open";

/** Thrown when a configured classification ceiling isn't one of the known levels. Names the offending value, same shape as ProviderConfigError. */
export class InvalidClassificationCeilingError extends Error {
  constructor(raw: string) {
    super(`Invalid classification ceiling "${raw}": expected one of ${CLASSIFICATION_LEVELS.join(", ")}`);
    this.name = "InvalidClassificationCeilingError";
  }
}

/**
 * Validates a raw configured ceiling value (e.g. DUO_CLASSIFICATION_CEILING).
 * "unknown" is deliberately not accepted here — the ceiling is a policy
 * choice among the *marked* levels; unknown material's visibility is
 * governed separately by isVisibleToClearance, never by the ceiling.
 */
export function parseClassificationCeiling(raw: string): ClassificationLevel {
  if (!(CLASSIFICATION_LEVELS as readonly string[]).includes(raw)) {
    throw new InvalidClassificationCeilingError(raw);
  }
  return raw as ClassificationLevel;
}

function rankOf(level: ClassificationLevel): number {
  return CLASSIFICATION_LEVELS.indexOf(level);
}

/**
 * Ingest-time gate (#48 AC1): whether a record at `classification` may be
 * written to the retained store under `ceiling`. `"unknown"` is
 * deliberately exempt — it's always retained, recorded honestly as
 * unknown (#48 AC2 asks for it to be "recorded as unknown", not silently
 * dropped at ingest the way over-ceiling *marked* material is) and kept
 * out of answers instead, via isVisibleToClearance below.
 */
export function isWithinCeiling(classification: RecordClassification, ceiling: ClassificationLevel): boolean {
  if (classification === "unknown") {
    return true;
  }
  return rankOf(classification) <= rankOf(ceiling);
}

/**
 * Answer-time gate (#48 AC2; the primitive #49/#50's retrieval filtering
 * builds on): whether an asker cleared to `clearance` may see a record at
 * `classification`. Unmarked material never defaults to the most
 * permissive value — the opposite: over-classify when unsure is the
 * standard security posture, so it needs the *same* clearance as the top
 * defined level (nobody has confirmed it's safe to show anyone below
 * that), even though it was exempt from ceiling-based ingest exclusion
 * above.
 */
export function isVisibleToClearance(classification: RecordClassification, clearance: ClassificationLevel): boolean {
  if (classification === "unknown") {
    return rankOf(clearance) >= CLASSIFICATION_LEVELS.length - 1;
  }
  return rankOf(classification) <= rankOf(clearance);
}

export interface EnforceCeilingOutcome {
  /** Records removed from the retained store because they sit above the new ceiling. */
  removed: number;
  /** Ids of the removed records, for reporting. */
  removedIds: readonly string[];
}

/**
 * #48 AC3: when policy lowers the ceiling, the corpus is re-evaluated
 * rather than left reachable under the old, higher one. "unknown" records
 * are exempt (see isWithinCeiling) — a ceiling change is a policy decision
 * about *marked* material only; it never touches the separate, always-
 * strict clearance gate unknown material already sits behind.
 */
export function enforceClassificationCeiling(
  storePath: string,
  passphrase: string,
  ceiling: ClassificationLevel,
): EnforceCeilingOutcome {
  const records = listRecords(storePath, passphrase);
  const removedIds = records.filter((record) => !isWithinCeiling(record.classification, ceiling)).map((record) => record.id);
  if (removedIds.length === 0) {
    return { removed: 0, removedIds: [] };
  }
  const { removed } = deleteRecords(storePath, passphrase, removedIds);
  return { removed, removedIds };
}
