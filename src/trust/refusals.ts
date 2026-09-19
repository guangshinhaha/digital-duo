import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTopicsFile } from "../derivation/topics.js";

/**
 * `duo/refusals.md` — "hand-written, never derived" (v1-tech-design.md
 * §1.1's directory diagram). One markdown file, `##`-headed sections: each
 * heading names what's refused (a topic label, as an owner would actually
 * write it by hand — a topic id is accepted too, since it's stable and
 * sometimes copy-pasted), and the body beneath it is the reason shown back
 * when a grant conflicts with it (#53 AC3) or a derived rule does (#29
 * AC3, see ../derivation/rule-review.ts). "Hand-written" describes how the
 * owner *authors* a refusal — never derived from the corpus — not that no
 * code may ever write the file: #29 (the Mirror's own refusal-capture
 * screen, below) is that code, and every other module keeps reading this
 * file exactly as before.
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

/** The same match `findConflictingRefusal` makes against a topic, but against a plain label string directly — for a topic that doesn't exist yet (see rule-review.ts's writeRuleByHand, which must check *before* minting one). */
export function findRefusalByHeading(duoDir: string, heading: string): Refusal | undefined {
  const headingLower = heading.trim().toLowerCase();
  return readRefusalsFile(duoDir).find((refusal) => refusal.heading.toLowerCase() === headingLower);
}

function renderRefusalsMarkdown(refusals: readonly Refusal[]): string {
  const intro = [
    "# Refusals",
    "",
    "Subjects this duo must never speak for you on — the one part of the",
    "Mirror deliberately not derived from your history (docs/concept.md §10).",
    "Edit this file directly, or use `duo mirror refusals add`/`duo mirror",
    "refusals confirm-none`.",
    "",
  ].join("\n");
  if (refusals.length === 0) {
    return `${intro}\n(No refusals recorded — reviewed and deliberately left empty.)\n`;
  }
  return `${intro}\n${refusals.map((refusal) => `## ${refusal.heading}\n\n${refusal.reason}\n`).join("\n")}`;
}

/**
 * Writes the whole file from a complete list of refusals — the one place
 * `duo/refusals.md` is ever written by code (see the module doc above).
 * Writing with an empty list is a legitimate, meaningful call: it's how
 * `confirmNoRefusals` below records "asked, and there genuinely are none"
 * as a file that exists, distinct from a file that was never created at
 * all (#29 AC2).
 */
export function writeRefusalsFile(duoDir: string, refusals: readonly Refusal[]): void {
  mkdirSync(duoDir, { recursive: true });
  writeFileSync(refusalsFilePath(duoDir), renderRefusalsMarkdown(refusals), "utf8");
}

/** Whether the owner has ever made *any* decision about refusals — recorded one, or explicitly recorded none. The file simply existing is the record (#29 AC2): a file that was never created at all means "never asked". */
export function hasRefusalsDecision(duoDir: string): boolean {
  return existsSync(refusalsFilePath(duoDir));
}

export class InvalidRefusalError extends Error {}

/**
 * Adds a refusal, or — if a refusal with the same heading (case-
 * insensitively) already exists — replaces its reason, so re-running
 * `duo mirror refusals add` on the same subject edits it in place rather
 * than duplicating it (#29 AC1).
 */
export function upsertRefusal(duoDir: string, heading: string, reason: string): Refusal[] {
  const trimmedHeading = heading.trim();
  const trimmedReason = reason.trim();
  if (trimmedHeading.length === 0) {
    throw new InvalidRefusalError("A refusal needs a non-empty subject (heading).");
  }
  if (trimmedReason.length === 0) {
    throw new InvalidRefusalError("A refusal needs a non-empty reason.");
  }
  const existing = readRefusalsFile(duoDir);
  const index = existing.findIndex((refusal) => refusal.heading.toLowerCase() === trimmedHeading.toLowerCase());
  const updated =
    index === -1
      ? [...existing, { heading: trimmedHeading, reason: trimmedReason }]
      : existing.map((refusal, i) => (i === index ? { heading: trimmedHeading, reason: trimmedReason } : refusal));
  writeRefusalsFile(duoDir, updated);
  return updated;
}

/**
 * Records the deliberate choice of zero refusals (#29 AC2). Refuses when
 * refusals already exist, rather than silently discarding them — clearing
 * an existing list this bluntly would be a surprising way to lose
 * hand-written text the owner cares about; removing one is a hand-edit to
 * the file itself, which this module has always left available.
 */
export function confirmNoRefusals(duoDir: string): void {
  const existing = readRefusalsFile(duoDir);
  if (existing.length > 0) {
    throw new InvalidRefusalError(
      `${existing.length} refusal(s) are already recorded; confirming "none" would discard them. ` +
        "Remove them by hand-editing duo/refusals.md first if that's really what you want.",
    );
  }
  writeRefusalsFile(duoDir, []);
}

/** Thrown by requireRefusalsDecision — the "finish onboarding" gate (#29 AC2). Names exactly what to do, since the whole point is that skipping this silently is not allowed. */
export class RefusalsNotDecidedError extends Error {
  constructor() {
    super(
      "No decision about refusals has been recorded yet. Record at least one with " +
        '`duo mirror refusals add "<subject>" "<reason>"`, or confirm there truly are none with ' +
        "`duo mirror refusals confirm-none`.",
    );
    this.name = "RefusalsNotDecidedError";
  }
}

/**
 * The onboarding gate itself: throws unless the owner has made *some*
 * decision (AC2). Meant to be called at the boundary of "finishing
 * onboarding" — #30's calibration, the last screen in the Mirror sequence,
 * is that boundary; this primitive is what it calls.
 */
export function requireRefusalsDecision(duoDir: string): void {
  if (!hasRefusalsDecision(duoDir)) {
    throw new RefusalsNotDecidedError();
  }
}
