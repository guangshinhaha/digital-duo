import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `duo/refusals.md` — a hand-authored, checked-in list of subjects the
 * personal duo never drafts about, in the same "plain markdown file the
 * owner edits directly" convention `duo/topics.json`/`duo/voice.md`/
 * `duo/rules/*.md` already established. One subject per bullet line
 * (`- subject`); everything else in the file (headings, prose) is ignored,
 * so the owner can annotate it without breaking parsing.
 */
function refusalsFilePath(duoDir: string): string {
  return join(duoDir, "refusals.md");
}

const BULLET_LINE = /^\s*[-*]\s+(.+?)\s*$/;

/**
 * Reads `duo/refusals.md`. Returns [] if the file (or the directory)
 * doesn't exist yet — a duo with nothing refused is the normal starting
 * state, not an error, matching readTopicsFile's convention.
 */
export function readRefusalsFile(duoDir: string): string[] {
  const path = refusalsFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const subjects: string[] = [];
  for (const line of lines) {
    const match = BULLET_LINE.exec(line);
    if (match) {
      subjects.push(match[1]);
    }
  }
  return subjects;
}
