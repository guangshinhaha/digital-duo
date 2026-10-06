import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * guangshinhaha/duo#274: the owner's per-room "don't learn from this"
 * marker — `duo/off-the-record.json`, one entry per room, in the exact
 * convention `consent.ts` (`room-consent.json`) and `channel-mutes.ts`
 * (`muted-channels.json`) already use: owner policy that is nobody's to
 * provision but the owner, reviewable and reversible by hand (open the
 * file, see every off-the-record room and when, delete a line to undo).
 *
 * ## What this file is, and is not
 *
 * This is the *marker* only — whether a room is currently off the record.
 * It says nothing about answering: an off-the-record room is not muted and
 * not withdrawn (`consent.ts` owns both of those, independently — a room
 * can be off the record and still fully answerable). What the marker
 * gates is *learning*: `drafting/standing-order-candidates.ts` and
 * `corrections/classify.ts` each consult `isRoomOffTheRecord` before
 * turning anything that happened in a room into a standing-order
 * candidate or a correction candidate, so the marker is the one place
 * both learning paths check — set it once, both doors close.
 *
 * ## Why a `duo/` file and not a store table
 *
 * Same reasoning as `consent.ts`'s own doc comment: nothing here is a
 * secret (a Matrix room id is homeserver-visible), its whole value is
 * being reviewable by hand, and `src/workspace/**` is pinned to never
 * import a store module (the boundary scan). The purge this setting
 * triggers — removing standing-order candidates, correction candidates
 * and rules already derived from the room — is store work, so it lives
 * in `drafting/off-the-record-purge.ts` instead, called from the route
 * that also calls `markRoomOffTheRecord` here.
 *
 * Read fresh per decision, like every other file in this family: the
 * very next question or correction after a toggle sees the owner's latest
 * word, with no cache to invalidate.
 *
 * Room ids are matched exactly, case-sensitively — the same rule
 * `consent.ts` states and for the same reason (a Matrix room id is
 * protocol-issued and stable; a near-identical id is a different room).
 */

/** One room's record in `duo/off-the-record.json`. */
export interface OffTheRecordEntry {
  readonly roomId: string;
  /** ISO-8601 instant the owner marked this room off the record. */
  readonly decidedAt: string;
}

/** Thrown when `duo/off-the-record.json` exists but is not a well-formed record — the same "fail loud, never guess" stance `InvalidRoomConsentError` takes. */
export class InvalidOffTheRecordError extends Error {
  constructor(reason: string) {
    super(`Malformed off-the-record record: ${reason}`);
    this.name = "InvalidOffTheRecordError";
  }
}

function offTheRecordFilePath(duoDir: string): string {
  return join(duoDir, "off-the-record.json");
}

function entryFrom(raw: unknown, index: number): OffTheRecordEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidOffTheRecordError(`entry at index ${index} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.roomId !== "string" || record.roomId.length === 0) {
    throw new InvalidOffTheRecordError(`entry at index ${index} is missing a non-empty "roomId"`);
  }
  if (typeof record.decidedAt !== "string" || record.decidedAt.length === 0) {
    throw new InvalidOffTheRecordError(`entry "${record.roomId}" is missing a non-empty "decidedAt"`);
  }
  return { roomId: record.roomId, decidedAt: record.decidedAt };
}

/**
 * Reads `duo/off-the-record.json`. Returns `[]` when the file (or the
 * directory) doesn't exist yet — no room marked off the record is the
 * safe default, not an error. A file that exists but is malformed throws:
 * silently treating it as "nothing is off the record" would resume
 * learning from a room the owner deliberately excluded.
 */
export function readOffTheRecordRooms(duoDir: string): OffTheRecordEntry[] {
  const path = offTheRecordFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidOffTheRecordError(`expected a JSON array of off-the-record entries in ${path}`);
  }
  return parsed.map(entryFrom);
}

function writeOffTheRecordRooms(duoDir: string, entries: readonly OffTheRecordEntry[]): void {
  mkdirSync(duoDir, { recursive: true });
  const sorted = [...entries].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  writeFileSync(offTheRecordFilePath(duoDir), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/** Whether `roomId` is currently off the record — exact match, see the module doc. */
export function isRoomOffTheRecord(duoDir: string, roomId: string): boolean {
  return readOffTheRecordRooms(duoDir).some((entry) => entry.roomId === roomId);
}

/** The entry for one room, or null when it isn't marked. */
export function offTheRecordEntryFor(duoDir: string, roomId: string): OffTheRecordEntry | null {
  return readOffTheRecordRooms(duoDir).find((entry) => entry.roomId === roomId) ?? null;
}

/**
 * Marks a room off the record — idempotent, same contract as `muteChannel`:
 * re-marking an already off-the-record room changes nothing and keeps the
 * original `decidedAt`. Returns the entry for this room (new or existing).
 */
export function markRoomOffTheRecord(duoDir: string, roomId: string): OffTheRecordEntry {
  const existing = offTheRecordEntryFor(duoDir, roomId);
  if (existing) {
    return existing;
  }
  const entry: OffTheRecordEntry = { roomId, decidedAt: new Date().toISOString() };
  writeOffTheRecordRooms(duoDir, [...readOffTheRecordRooms(duoDir), entry]);
  return entry;
}

/**
 * Takes a room off the off-the-record list — "turning it on purges...", but
 * turning it back *off* only lifts the marker; it never un-purges what was
 * already removed (there is nothing left to restore, same as a rule
 * rejection or a dismissed draft). `wasOn` is false when the room was never
 * marked, the same honest-about-no-op convention `unmuteChannel` uses.
 */
export function clearRoomOffTheRecord(duoDir: string, roomId: string): { readonly wasOn: boolean; readonly rooms: OffTheRecordEntry[] } {
  const existing = readOffTheRecordRooms(duoDir);
  const updated = existing.filter((entry) => entry.roomId !== roomId);
  if (updated.length === existing.length) {
    return { wasOn: false, rooms: existing };
  }
  writeOffTheRecordRooms(duoDir, updated);
  return { wasOn: true, rooms: updated };
}
