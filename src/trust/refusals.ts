import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTopicsFile } from "../derivation/topics.js";

/**
 * `duo/refusals.md` — "hand-written, never derived" (v1-tech-design.md
 * §1.1's directory diagram). One markdown file, `##`-headed sections: each
 * heading names what's refused (a topic label, as an owner would actually
 * write it by hand — a topic id is accepted too, since it's stable and
 * sometimes copy-pasted), and the body beneath it is the reason shown back
 * when a grant conflicts with it (#53 AC3). No writer exists anywhere in
 * this codebase for this file, matching the "hand-written" half of that
 * label — the only way it changes is an owner editing it directly.
 */
export interface Refusal {
  readonly heading: string;
  readonly reason: string;
}

function refusalsFilePath(duoDir: string): string {
  return join(duoDir, "refusals.md");
}

/** Returns [] if the file (or the directory) doesn't exist yet — no refusals written is not an error, same convention topics.ts's readTopicsFile uses for duo/topics.json. */
export function readRefusalsFile(duoDir: string): Refusal[] {
  const path = refusalsFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  const refusals: Refusal[] = [];
  // The preamble before the first "## " heading (e.g. a title, an intro
  // sentence) carries no heading of its own and is dropped.
  const sections = text.split(/^##[ \t]+/m).slice(1);
  for (const section of sections) {
    const newlineIndex = section.indexOf("\n");
    const heading = (newlineIndex === -1 ? section : section.slice(0, newlineIndex)).trim();
    const reason = (newlineIndex === -1 ? "" : section.slice(newlineIndex + 1)).trim();
    if (heading.length > 0) {
      refusals.push({ heading, reason });
    }
  }
  return refusals;
}

/**
 * A refusal "conflicts" with a topic (#53 AC3) when its heading matches the
 * topic's current label or its id, case-insensitively. `topicLabel` is
 * accepted as an optional shortcut for a caller that already has it (e.g.
 * mid-match in grants.ts); otherwise it's looked up from duo/topics.json.
 */
export function findConflictingRefusal(duoDir: string, topicId: string, topicLabel?: string): Refusal | undefined {
  const refusals = readRefusalsFile(duoDir);
  if (refusals.length === 0) {
    return undefined;
  }
  const label = topicLabel ?? readTopicsFile(duoDir).find((topic) => topic.id === topicId)?.label;
  const topicIdLower = topicId.toLowerCase();
  const labelLower = label?.toLowerCase();
  return refusals.find((refusal) => {
    const headingLower = refusal.heading.toLowerCase();
    return headingLower === topicIdLower || (labelLower !== undefined && headingLower === labelLower);
  });
}
