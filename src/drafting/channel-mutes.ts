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
