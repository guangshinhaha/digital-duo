import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #192: the owner's record of where this duo is allowed to be reachable —
 * `duo/room-consent.json`, one entry per room. This is the consented act's
 * durable form: nothing in it is provisioned by anyone but the owner (the
 * daemon writes it only as the mechanical consequence of an owner decision
 * made through the allow/refuse/withdraw surface, and a person editing it by
 * hand is the owner at their own machine).
 *
 * ## Why a `duo/` file and not an encrypted-store table
 *
 * Consent is owner policy in exactly the class of `duo/directory.json` (who
 * may ask) and `duo/muted-channels.json` (where the duo speaks): its whole
 * value to the owner is that it is reviewable and reversible by hand — open
 * one file, see every room with who invited and when it was decided, delete
 * a line to undo. The store is where revocable *secrets* live (device/ask
 * tokens) and where state sharing the corpus's lifecycle lives (#189's read
 * events); consent is neither. Nothing here is a secret: room ids, names and
 * inviter ids are homeserver-visible facts — the server knows the duo's
 * memberships better than this file does — and the store's encryption exists
 * to protect the corpus, not policy. A store table would also push this
 * logic across the pinned boundary scan (`src/workspace/**` may not import
 * store modules), splitting one concept across two directories.
 *
 * Reading fresh per decision (the channel-mutes precedent) is what makes
 * withdrawal immediate with no cache to invalidate: the answering gate reads
 * the file, so the very next question sees the owner's latest word.
 *
 * ## Statuses, and why executed exits are deleted
 *
 * `allowed` is the live consent — the gate's answer for "may the duo answer
 * in this room". `refused` and `withdrawn` are decisions whose mechanical
 * consequence (leaving the room, which on Matrix also rejects an invite) is
 * still pending; once the leave lands, the entry is deleted. That deletion
 * is the design, not an oversight: a refusal kept forever would tempt future
 * code to auto-refuse a re-invite, which is exactly the loop the issue
 * forbids — a re-invite must be a fresh decision. With the entry gone, the
 * fresh-decision property is structural: the leave already removed the
 * invite server-side, so only a *new* invite act can re-open the room, and
 * every new invite is held and surfaced to the owner again (#192's
 * "never conscripted").
 *
 * Room ids are matched exactly, case-sensitively: unlike a channel name a
 * person types by hand, a Matrix room id is protocol-issued and stable — a
 * near-identical id is a different room, and treating it as the same one
 * would be a spoofing path, not a convenience.
 */

/** The owner's standing decision for one room. */
export type RoomConsentStatus = "allowed" | "refused" | "withdrawn";

/** One room's record in `duo/room-consent.json` — the decision, plus the provenance the owner saw when making it. */
export interface RoomConsentEntry {
  readonly roomId: string;
  readonly status: RoomConsentStatus;
  /** The room's `m.room.name` as the invite carried it, or null — review provenance, never a key. */
  readonly name: string | null;
  /** Who invited the duo (the invite membership event's sender), or null when the wire did not say. */
  readonly inviterId: string | null;
  /** Joined members at decision time, as the invite's sync slice carried them (heroes-limited on Matrix), or null. */
  readonly joinedMemberCount: number | null;
  /** ISO-8601 instant of the decision this entry records. */
  readonly decidedAt: string;
}

/** Thrown when `duo/room-consent.json` exists but is not a well-formed consent record — names the file and the problem, the same shape as the directory and mutes modules' malformed-file errors. */
export class InvalidRoomConsentError extends Error {
  constructor(reason: string) {
    super(`Malformed room consent record: ${reason}`);
    this.name = "InvalidRoomConsentError";
  }
}

/** Thrown when a withdrawal names a room with no record — there is no consent to withdraw (leaving a room consent never put the duo in is a client-side leave, not a consent act). Maps to 404 on the owner surface. */
export class RoomConsentNotFoundError extends Error {
  constructor(roomId: string) {
    super(`No consent record for room ${JSON.stringify(roomId)} — there is nothing to withdraw`);
    this.name = "RoomConsentNotFoundError";
  }
}

function roomConsentFilePath(duoDir: string): string {
  return join(duoDir, "room-consent.json");
}

function isRoomConsentStatus(value: unknown): value is RoomConsentStatus {
  return value === "allowed" || value === "refused" || value === "withdrawn";
}

/** Parses one raw entry, refusing anything ambiguous rather than guessing at it. */
function entryFrom(raw: unknown, index: number): RoomConsentEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidRoomConsentError(`entry at index ${index} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.roomId !== "string" || record.roomId.length === 0) {
    throw new InvalidRoomConsentError(`entry at index ${index} is missing a non-empty "roomId"`);
  }
  if (!isRoomConsentStatus(record.status)) {
    throw new InvalidRoomConsentError(
      `entry "${record.roomId}" has an invalid "status" (expected one of allowed, refused, withdrawn)`,
    );
  }
  const decidedAt = typeof record.decidedAt === "string" && record.decidedAt.length > 0 ? record.decidedAt : null;
  if (decidedAt === null) {
    throw new InvalidRoomConsentError(`entry "${record.roomId}" is missing a non-empty "decidedAt"`);
  }
  if (record.joinedMemberCount !== null && record.joinedMemberCount !== undefined && !Number.isInteger(record.joinedMemberCount)) {
    throw new InvalidRoomConsentError(`entry "${record.roomId}" has a "joinedMemberCount" that is not an integer or null`);
  }
  return {
    roomId: record.roomId,
    status: record.status,
    name: typeof record.name === "string" ? record.name : null,
    inviterId: typeof record.inviterId === "string" ? record.inviterId : null,
    joinedMemberCount:
      record.joinedMemberCount === null || record.joinedMemberCount === undefined ? null : (record.joinedMemberCount as number),
    decidedAt,
  };
}

/**
 * Reads `duo/room-consent.json`. Returns `[]` when the file (or the
 * directory) doesn't exist — a duo nothing has been consented to yet is the
 * safe default, not an error. A file that exists but is malformed throws:
 * the owner (or this daemon) wrote something unreadable, and silently
 * treating it as "no rooms consented" would answer away a withdrawal.
 */
export function readRoomConsent(duoDir: string): RoomConsentEntry[] {
  const path = roomConsentFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidRoomConsentError(`expected a JSON array of room consent entries in ${path}`);
  }
  return parsed.map(entryFrom);
}

/** Writes the record sorted by room id with the stable hand-editable formatting the other duo/ files use. */
function writeRoomConsent(duoDir: string, entries: readonly RoomConsentEntry[]): void {
  mkdirSync(duoDir, { recursive: true });
  const sorted = [...entries].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  writeFileSync(roomConsentFilePath(duoDir), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/**
 * Records the owner's decision for one room — an upsert: the latest decision
 * for a room replaces the previous one (a re-allow after a withdrawal, a
 * withdrawal after an allow), because two entries for one room would be two
 * owners' worth of authority where only the owner gets one. Returns the
 * updated record.
 */
export function recordRoomDecision(duoDir: string, entry: RoomConsentEntry): RoomConsentEntry[] {
  const updated = readRoomConsent(duoDir).filter((existing) => existing.roomId !== entry.roomId).concat(entry);
  writeRoomConsent(duoDir, updated);
  return updated;
}

/**
 * Deletes a room's entry — the mark of an *executed* exit: the leave landed,
 * the decision is fully carried out, and keeping it would only invite future
 * code to treat an old refusal as standing authority over a fresh invite.
 * Honest about nothing-to-delete: `entry` is null when the room had no
 * record (the unmute convention).
 */
export function forgetRoomDecision(duoDir: string, roomId: string): { entry: RoomConsentEntry | null; rooms: RoomConsentEntry[] } {
  const existing = readRoomConsent(duoDir);
  const entry = existing.find((candidate) => candidate.roomId === roomId) ?? null;
  if (entry === null) {
    return { entry: null, rooms: existing };
  }
  const updated = existing.filter((candidate) => candidate.roomId !== roomId);
  writeRoomConsent(duoDir, updated);
  return { entry, rooms: updated };
}

/**
 * The standing decision for one room, or null when there is none. Pure, so
 * the question filter's gate is testable without a filesystem: the service
 * hands this over a fresh `readRoomConsent` per decision (immediacy, above).
 * Exact-id matching — see the module doc for why a near-id is not the room.
 */
export function roomDecisionFor(entries: readonly RoomConsentEntry[], roomId: string): RoomConsentStatus | null {
  return entries.find((entry) => entry.roomId === roomId)?.status ?? null;
}

/**
 * guangshinhaha/duo#315: "always allow this person" — the owner's standing
 * yes, given ahead of time, to one colleague's one-to-one conversations
 * with the duo. `duo/always-allow.json`, beside the room record and for the
 * same reasons (owner policy, reviewable and reversible by hand, nothing
 * secret in it). It is still the owner's act: nothing but the owner's
 * explicit "Always allow" writes an entry, and a held invitation from a
 * listed person is then allowed exactly as if the owner had tapped Allow —
 * recorded in `room-consent.json` like any other allow. It covers direct
 * conversations only: a group room carries other people the owner never
 * agreed to, so it is always a fresh decision.
 */
export interface AlwaysAllowEntry {
  /** The colleague's Matrix user id — protocol-issued, matched exactly (the room-id rule, applied to people). */
  readonly userId: string;
  /** ISO-8601 instant the owner gave the standing yes. */
  readonly decidedAt: string;
}

function alwaysAllowFilePath(duoDir: string): string {
  return join(duoDir, "always-allow.json");
}

/** Reads `duo/always-allow.json` — `[]` when absent; a malformed file throws, the room record's own rule (a silent empty list would quietly re-gate people the owner chose). */
export function readAlwaysAllowed(duoDir: string): AlwaysAllowEntry[] {
  const path = alwaysAllowFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidRoomConsentError(`expected a JSON array of always-allowed people in ${path}`);
  }
  return parsed.map((raw: unknown, index) => {
    const record = raw as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null || typeof record.userId !== "string" || record.userId.length === 0) {
      throw new InvalidRoomConsentError(`always-allow entry at index ${index} is missing a non-empty "userId"`);
    }
    if (typeof record.decidedAt !== "string" || record.decidedAt.length === 0) {
      throw new InvalidRoomConsentError(`always-allow entry "${record.userId}" is missing a non-empty "decidedAt"`);
    }
    return { userId: record.userId, decidedAt: record.decidedAt };
  });
}

function writeAlwaysAllowed(duoDir: string, entries: readonly AlwaysAllowEntry[]): void {
  mkdirSync(duoDir, { recursive: true });
  const sorted = [...entries].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  writeFileSync(alwaysAllowFilePath(duoDir), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/** Records the owner's standing yes for one person — an upsert, one entry per person. Returns the updated list. */
export function recordAlwaysAllowed(duoDir: string, userId: string): AlwaysAllowEntry[] {
  const updated = readAlwaysAllowed(duoDir)
    .filter((entry) => entry.userId !== userId)
    .concat({ userId, decidedAt: new Date().toISOString() });
  writeAlwaysAllowed(duoDir, updated);
  return updated;
}

/** Takes the standing yes back. `removed` is false when the person was not on the list (the unmute convention: honest about nothing-to-do). */
export function forgetAlwaysAllowed(duoDir: string, userId: string): { removed: boolean; people: AlwaysAllowEntry[] } {
  const existing = readAlwaysAllowed(duoDir);
  const updated = existing.filter((entry) => entry.userId !== userId);
  if (updated.length === existing.length) {
    return { removed: false, people: existing };
  }
  writeAlwaysAllowed(duoDir, updated);
  return { removed: true, people: updated };
}
