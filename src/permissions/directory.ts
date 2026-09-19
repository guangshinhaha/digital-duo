import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLASSIFICATION_LEVELS, type ClassificationLevel } from "../ingest/record.js";

/**
 * One entry in the roster of people who may ask this duo something —
 * mirrors `duo/topics.json`'s "checked-in file is the source of truth"
 * convention (topics.ts). #49 is explicit that *provisioning* clearances
 * is out of scope ("they are read from the source of truth"): in a real
 * deployment this file would be generated from HR/IT's directory; here
 * it's the stand-in for that, hand-maintained like topics.json.
 */
export interface AskerIdentity {
  readonly id: string;
  readonly name: string;
  readonly clearance: ClassificationLevel;
  readonly groups: readonly string[];
}

/** Thrown when `duo/directory.json` exists but isn't a well-formed roster. Names the file and the problem, same shape as topics.ts's malformed-file error. */
export class InvalidDirectoryError extends Error {}

function directoryFilePath(duoDir: string): string {
  return join(duoDir, "directory.json");
}

function isClassificationLevel(value: unknown): value is ClassificationLevel {
  return typeof value === "string" && (CLASSIFICATION_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads `duo/directory.json`. Returns `[]` when the file (or the
 * directory) doesn't exist — a duo with no directory configured yet
 * resolves every asker as unresolved, which is the safe default (#49
 * AC2), not an error.
 */
export function loadDirectory(duoDir: string): AskerIdentity[] {
  const path = directoryFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidDirectoryError(`Malformed ${path}: expected a JSON array of asker identities`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidDirectoryError(`Malformed ${path}: entry at index ${index} is not an object`);
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new InvalidDirectoryError(`Malformed ${path}: entry at index ${index} is missing a non-empty "id"`);
    }
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw new InvalidDirectoryError(`Malformed ${path}: entry "${raw.id}" is missing a non-empty "name"`);
    }
    if (!isClassificationLevel(raw.clearance)) {
      throw new InvalidDirectoryError(
        `Malformed ${path}: entry "${raw.id}" has an invalid "clearance" (expected one of ${CLASSIFICATION_LEVELS.join(", ")})`,
      );
    }
    if (raw.groups !== undefined && (!Array.isArray(raw.groups) || raw.groups.some((g) => typeof g !== "string"))) {
      throw new InvalidDirectoryError(`Malformed ${path}: entry "${raw.id}" has a "groups" that isn't an array of strings`);
    }
    return { id: raw.id, name: raw.name, clearance: raw.clearance, groups: (raw.groups as string[] | undefined) ?? [] };
  });
}

/**
 * Whether an asker resolved to a real directory entry, or couldn't be
 * matched at all. Kept as a discriminated union rather than a nullable
 * identity so a caller can't accidentally read `.clearance` off an
 * unresolved asker without narrowing first.
 */
export type AskerResolution =
  | { readonly resolved: true; readonly identity: AskerIdentity }
  | { readonly resolved: false; readonly askerRef: string };

/**
 * Resolves an asker reference (an id, matched case-insensitively) against
 * a loaded directory. An asker who isn't in the directory at all —
 * including one asking before any directory has been configured — comes
 * back `resolved: false` rather than throwing: #49 AC2 asks for that case
 * to be handled (most restrictive treatment), not refused outright.
 */
export function resolveAsker(askerRef: string, directory: readonly AskerIdentity[]): AskerResolution {
  const match = directory.find((entry) => entry.id.toLowerCase() === askerRef.toLowerCase());
  return match ? { resolved: true, identity: match } : { resolved: false, askerRef };
}

/**
 * The clearance a resolution grants for retrieval filtering: the matched
 * identity's own clearance, or — for an unresolvable asker — the lowest
 * defined level (#49 AC2: "only material requiring no clearance is
 * considered"). Never anything in between; there's no partial trust for a
 * confirmed-nobody.
 */
export function effectiveClearance(resolution: AskerResolution): ClassificationLevel {
  return resolution.resolved ? resolution.identity.clearance : CLASSIFICATION_LEVELS[0];
}
