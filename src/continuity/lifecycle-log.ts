import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * #63 AC ("also true when done: every transfer, archival, and deletion is
 * written to the audit log"). A plain, durable JSON-array file — same
 * "read-append-write, no more machinery than this needs" idiom
 * `shared-duo/usage-log.ts` uses — kept in its own directory (see
 * `DEFAULT_LIFECYCLE_LOG_PATH` in src/config.ts), never inside the
 * encrypted store's data directory or `duoDir`: both of those are exactly
 * what `endDuo` (this module's own deletion path) removes, and a log of
 * "this duo was deleted" that lived inside the thing being deleted would
 * be destroyed by the very event it records.
 */
export const LIFECYCLE_EVENT_TYPES = ["archived", "orphan_declared", "transfer_initiated", "transfer_confirmed", "transfer_completed", "ended"] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export interface LifecycleLogEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly eventType: LifecycleEventType;
  /** Who decided or performed this act — always a name, never blank (every writer in this module requires one). */
  readonly actor: string;
  readonly detail: Record<string, unknown>;
}

export class InvalidLifecycleLogError extends Error {}

/** Every entry ever recorded, oldest first. Returns `[]` when the log doesn't exist yet. */
export function loadLifecycleLog(logPath: string): LifecycleLogEntry[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(logPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidLifecycleLogError(`Malformed lifecycle log at "${logPath}": expected a JSON array`);
  }
  return parsed as LifecycleLogEntry[];
}

/** Appends one entry and rewrites the log — the only write this module offers, so the log is append-only by construction (there is no update/delete export). */
export function appendLifecycleEvent(
  logPath: string,
  input: { eventType: LifecycleEventType; actor: string; detail: Record<string, unknown> },
): LifecycleLogEntry {
  const entries = loadLifecycleLog(logPath);
  const entry: LifecycleLogEntry = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
  entries.push(entry);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify(entries, null, 2));
  return entry;
}
