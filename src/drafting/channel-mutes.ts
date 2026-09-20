import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `duo/muted-channels.json` — the owner's per-channel proactive-offer mute
 * list (#47 AC3), a checked-in, hand-editable file in the same convention
 * as `duo/directory.json`/`duo/topics.json`: "visible and reversible"
 * (AC3's own wording) is exactly what a plain JSON array in version
 * control gives for free — open the file to see what's muted, delete a
 * line (or run `duo mentions unmute`) to reverse it.
 */
function mutedChannelsFilePath(duoDir: string): string {
  return join(duoDir, "muted-channels.json");
}

/** Returns [] if the file (or the directory) doesn't exist yet — no channel muted is not an error, same convention topics.ts's readTopicsFile uses. */
export function readMutedChannels(duoDir: string): string[] {
  const path = mutedChannelsFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Malformed ${path}: expected a JSON array of channel names`);
  }
  return parsed as string[];
}

function writeMutedChannels(duoDir: string, channels: readonly string[]): void {
  mkdirSync(duoDir, { recursive: true });
  const sorted = [...new Set(channels)].sort();
  writeFileSync(mutedChannelsFilePath(duoDir), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/** Whether `channel` is currently muted, case-insensitively (channel names are typically typed by hand, and "#general" vs "#General" shouldn't be two different settings). */
export function isChannelMuted(duoDir: string, channel: string): boolean {
  const lower = channel.toLowerCase();
  return readMutedChannels(duoDir).some((entry) => entry.toLowerCase() === lower);
}

/** Mutes a channel — idempotent, re-muting an already-muted channel changes nothing. Returns the full, updated list. */
export function muteChannel(duoDir: string, channel: string): string[] {
  const existing = readMutedChannels(duoDir);
  if (isChannelMuted(duoDir, channel)) {
    return existing;
  }
  const updated = [...existing, channel];
  writeMutedChannels(duoDir, updated);
  return updated;
}

/** Unmutes a channel — #47 AC3's "reversible." Returns whether it had actually been muted (so a caller can report "nothing to undo" honestly rather than claiming a no-op as a real change). */
export function unmuteChannel(duoDir: string, channel: string): { wasMuted: boolean; channels: string[] } {
  const existing = readMutedChannels(duoDir);
  const lower = channel.toLowerCase();
  const updated = existing.filter((entry) => entry.toLowerCase() !== lower);
  if (updated.length === existing.length) {
    return { wasMuted: false, channels: existing };
  }
  writeMutedChannels(duoDir, updated);
  return { wasMuted: true, channels: updated };
}

// #172: the same one store grows scope *below* channel level — a thread
// within a channel can be muted on its own. No second file, no second
// vocabulary: a thread entry is stored as `<channel>/<threadId>`, which is
// why "/" is banned in both parts at every write. The CLI's commands and
// the daemon's routes read and write these same entries through these same
// functions — one store, one code path (#172 AC3).

/** Scopes a thread within its channel in the one mute file — structural, so it cannot also be data. */
const THREAD_ENTRY_SEPARATOR = "/";

/** Thrown by every thread-mute write whose channel or thread id contains the separator — the entry would be ambiguous, so it is refused rather than silently re-scoped. */
export class InvalidMuteKeyError extends Error {
  constructor(part: string) {
    super(`Channel and thread ids must not contain "${THREAD_ENTRY_SEPARATOR}" (it scopes a thread within a channel), got ${JSON.stringify(part)}`);
    this.name = "InvalidMuteKeyError";
  }
}

function assertValidMuteKeyPart(part: string): void {
  if (part.includes(THREAD_ENTRY_SEPARATOR)) {
    throw new InvalidMuteKeyError(part);
  }
}

function threadEntry(channel: string, threadId: string): string {
  return `${channel}${THREAD_ENTRY_SEPARATOR}${threadId}`;
}

/** Whether one specific thread is muted — a thread mute never mutes its channel (#172 AC2). */
export function isThreadMuted(duoDir: string, channel: string, threadId: string): boolean {
  const key = threadEntry(channel, threadId).toLowerCase();
  return readMutedChannels(duoDir).some((entry) => entry.toLowerCase() === key);
}

/** Mutes one thread within a channel — idempotent, same as `muteChannel`. Returns the full updated entry list. */
export function muteThread(duoDir: string, channel: string, threadId: string): string[] {
  assertValidMuteKeyPart(channel);
  assertValidMuteKeyPart(threadId);
  const existing = readMutedChannels(duoDir);
  if (isThreadMuted(duoDir, channel, threadId)) {
    return existing;
  }
  const updated = [...existing, threadEntry(channel, threadId)];
  writeMutedChannels(duoDir, updated);
  return updated;
}

/** Unmutes one thread — reversible and honest about nothing-to-undo, same contract as `unmuteChannel`. */
export function unmuteThread(duoDir: string, channel: string, threadId: string): { wasMuted: boolean; channels: string[] } {
  assertValidMuteKeyPart(channel);
  assertValidMuteKeyPart(threadId);
  const existing = readMutedChannels(duoDir);
  const key = threadEntry(channel, threadId).toLowerCase();
  const updated = existing.filter((entry) => entry.toLowerCase() !== key);
  if (updated.length === existing.length) {
    return { wasMuted: false, channels: existing };
  }
  writeMutedChannels(duoDir, updated);
  return { wasMuted: true, channels: updated };
}

/** The drafting policy as one read (#172): the one store, split by scope — channel-level entries, and thread-scoped mutes decoded to `{channel, threadId}`. */
export interface ChannelPolicy {
  readonly muted: string[];
  readonly mutedThreads: { readonly channel: string; readonly threadId: string }[];
}

/**
 * Reads the one mute store as policy, split by scope. Decoding splits each
 * thread entry at its *first* separator: writes ban "/" in both parts, so a
 * hand-edited entry with extra separators degrades to a strange thread id
 * rather than corrupting the channel name.
 */
export function readMutedPolicy(duoDir: string): ChannelPolicy {
  const entries = readMutedChannels(duoDir);
  const muted = entries.filter((entry) => !entry.includes(THREAD_ENTRY_SEPARATOR));
  const mutedThreads = entries
    .filter((entry) => entry.includes(THREAD_ENTRY_SEPARATOR))
    .map((entry) => {
      const separatorAt = entry.indexOf(THREAD_ENTRY_SEPARATOR);
      return { channel: entry.slice(0, separatorAt), threadId: entry.slice(separatorAt + 1) };
    });
  return { muted, mutedThreads };
}
