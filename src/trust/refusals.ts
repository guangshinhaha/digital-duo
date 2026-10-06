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

/**
 * `.name` is set explicitly (unlike a bare `extends Error {}`, which would
 * leave every instance reporting the generic `"Error"`) because
 * digital-duo#287's `statusForError` (`serve/server.ts`) now switches on
 * it to map this to a 400 for the HTTP mutation routes below — a mapping
 * that silently fell through to 500 before this was added, since nothing
 * read `.name` off this class until now.
 */
export class InvalidRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRefusalError";
  }
}

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

// ---------------------------------------------------------------------------
// guangshinhaha/duo#269: owner-editable never-answer rules, from the app —
// add/edit/remove a rule in the owner's own words, over HTTP
// (digital-duo#287). Built against duo PR #339's client, which already
// landed on `main` wired to this contract (`src/profile/Refusals.tsx`,
// `src/components/NeverAnswerOffer.tsx`, `docs/client-tech-design.md`
// §1.4): `POST`/`PUT`/`DELETE /mirror/refusals(/:heading)`, each returning
// the whole `RefusalsListing`, plus a suggestion route off a dismissed
// draft. These sit beside `upsertRefusal`/`confirmNoRefusals` above (the
// CLI's own writes, #29) rather than replacing them — `upsertRefusal`
// keeps the CLI's "a refusal needs a non-empty reason" discipline exactly
// as its own tests pin it; the app's "No thanks" / proactive-offer flow
// genuinely has no reason text to send (`NeverAnswerOffer.tsx` posts
// `{ subject }` alone), so the functions below accept an empty reason
// on purpose rather than loosening the CLI's own contract to allow it.
// ---------------------------------------------------------------------------

export class RefusalNotFoundError extends Error {
  constructor(heading: string) {
    super(`No never-answer rule is recorded for "${heading}".`);
    this.name = "RefusalNotFoundError";
  }
}

export class RefusalConflictError extends Error {
  constructor(heading: string) {
    super(`A never-answer rule already covers "${heading}" — pick a different subject, or edit that one instead.`);
    this.name = "RefusalConflictError";
  }
}

/**
 * The owner's own sentence ("I never answer about budget approvals")
 * reduced to its subject, for the heading a refusal is matched and shown
 * by (`findRefusalByHeading`, `RuleRow`'s own `data-testid="refusal-
 * heading"`). Strips the handful of sentence frames an owner is likely to
 * actually type — "I never/don't/won't answer/discuss/talk about/speak
 * about X", optionally "questions about X" — and falls back to the whole
 * trimmed sentence when none match, which is always a safe fallback: this
 * is a *suggestion* the owner sees and can retype before Save
 * (`client-tech-design.md`: "the subject is read off it"), never recorded
 * silently.
 */
const NEVER_ANSWER_SENTENCE_PREFIX =
  /^(?:i\s+)?(?:never|don'?t|do\s+not|won'?t|will\s+not|can'?t|cannot)\s+(?:answer|discuss|talk\s+about|speak\s+about|say\s+anything\s+about|comment\s+on)\s*(?:questions?\s+)?(?:about|on|regarding|concerning|re:?)?\s*/i;

const MAX_SUBJECT_LENGTH = 80;

function truncateSubject(subject: string): string {
  return subject.length > MAX_SUBJECT_LENGTH ? `${subject.slice(0, MAX_SUBJECT_LENGTH - 3)}...` : subject;
}

export function deriveNeverAnswerSubject(rule: string): string {
  const trimmed = rule.trim().replace(/[.!]+$/, "").trim();
  const stripped = trimmed.replace(NEVER_ANSWER_SENTENCE_PREFIX, "").trim();
  return truncateSubject(stripped.length > 0 ? stripped : trimmed);
}

/**
 * The daemon's starting words for a never-answer rule off a dismissed
 * draft's own question (guangshinhaha/duo#259 → #269) — the "shouldn't
 * answer this" follow-up offer. A light heuristic in the same spirit as
 * `../derivation/topics.ts`'s `defaultTopicLabel`: strips a handful of
 * common question openers and the trailing "?", and otherwise reads the
 * question back verbatim — an honest placeholder the owner edits or
 * approves, never one the duo invents facts for.
 */
// Order matters here: a longer alternative ("how much does") must come
// before any shorter prefix of it ("how much") — regex alternation commits
// to the first alternative whose continuation can succeed at all, not the
// longest match, so a shorter prefix listed first would "win" and leave
// the rest of the opener (e.g. "does") stuck to the subject.
const QUESTION_OPENER =
  /^(?:so\s+)?(?:what\s+do(?:es)?|what'?s|what\s+is|what\s+are|how\s+much\s+do(?:es)?|how\s+many\s+do(?:es)?|how\s+do(?:es)?|how'?s|how\s+is|how\s+are|how\s+much|how\s+many|why\s+do(?:es)?|why'?s|why\s+is|why\s+are|when'?s|when\s+is|when\s+are|where'?s|where\s+is|where\s+are|who'?s|who\s+is|who\s+are|which|can\s+you\s+(?:tell\s+me|share|explain)|could\s+you\s+(?:tell\s+me|share|explain)|do\s+you\s+know|is\s+it\s+true\s+that)\s+/i;

export function suggestNeverAnswerSubject(question: string): string {
  const trimmed = question.trim().replace(/[?]+$/, "").trim();
  const stripped = trimmed.replace(QUESTION_OPENER, "").trim();
  return truncateSubject(stripped.length > 0 ? stripped : trimmed);
}

/**
 * Validates and normalizes the wire shape of a never-answer write
 * (`NeverAnswerInput` in the client's `src/api/types.ts`): either `{ rule }`
 * — the owner's own sentence, whose subject is read off it and the
 * sentence itself kept as the reason — or `{ subject, reason? }` directly.
 * Throws `InvalidRefusalError` for anything else, including a blank
 * subject either way arrives at.
 */
export function parseNeverAnswerInput(raw: unknown): { heading: string; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidRefusalError('Body must be { rule } (a sentence) or { subject, reason? }.');
  }
  const body = raw as { rule?: unknown; subject?: unknown; reason?: unknown };
  if (typeof body.rule === "string") {
    const rule = body.rule.trim();
    if (rule.length === 0) {
      throw new InvalidRefusalError("rule must be a non-empty sentence.");
    }
    return { heading: deriveNeverAnswerSubject(rule), reason: rule };
  }
  if (typeof body.subject === "string") {
    const subject = body.subject.trim();
    if (subject.length === 0) {
      throw new InvalidRefusalError("subject must be non-empty.");
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      throw new InvalidRefusalError("reason, when present, must be a string.");
    }
    return { heading: subject, reason: (body.reason ?? "").trim() };
  }
  throw new InvalidRefusalError('Body must be { rule } (a sentence) or { subject, reason? }.');
}

/**
 * `POST /mirror/refusals`: adds a never-answer rule, or — matching
 * `upsertRefusal`'s own case-insensitive-heading convention — edits it in
 * place when the subject already names an existing one
 * (`client-tech-design.md`: "adding an existing subject edits it").
 * Deliberately not `upsertRefusal` itself: that one refuses an empty
 * reason (the CLI's own long-standing contract, pinned by
 * `trust-refusals.test.ts`), which the app's reason-free flows
 * (`NeverAnswerOffer.tsx`) must be able to send.
 */
export function saveNeverAnswerRule(duoDir: string, raw: unknown): Refusal[] {
  const { heading, reason } = parseNeverAnswerInput(raw);
  const existing = readRefusalsFile(duoDir);
  const index = existing.findIndex((refusal) => refusal.heading.toLowerCase() === heading.toLowerCase());
  const updated =
    index === -1 ? [...existing, { heading, reason }] : existing.map((refusal, i) => (i === index ? { heading, reason } : refusal));
  writeRefusalsFile(duoDir, updated);
  return updated;
}

/**
 * `PUT /mirror/refusals/:heading`: renames and rewords one rule in place.
 * 404 (`RefusalNotFoundError`) when `heading` names no recorded rule; 400
 * (`RefusalConflictError`) when the new subject would collide with a
 * *different* existing rule — renaming a rule onto itself (same subject,
 * new reason) is not a conflict with itself.
 */
export function renameNeverAnswerRule(duoDir: string, heading: string, raw: unknown): Refusal[] {
  const existing = readRefusalsFile(duoDir);
  const index = existing.findIndex((refusal) => refusal.heading.toLowerCase() === heading.trim().toLowerCase());
  if (index === -1) {
    throw new RefusalNotFoundError(heading);
  }
  const { heading: newHeading, reason: newReason } = parseNeverAnswerInput(raw);
  const conflictIndex = existing.findIndex((refusal, i) => i !== index && refusal.heading.toLowerCase() === newHeading.toLowerCase());
  if (conflictIndex !== -1) {
    throw new RefusalConflictError(newHeading);
  }
  const updated = existing.map((refusal, i) => (i === index ? { heading: newHeading, reason: newReason } : refusal));
  writeRefusalsFile(duoDir, updated);
  return updated;
}

/**
 * `DELETE /mirror/refusals/:heading`: removes one rule. 404
 * (`RefusalNotFoundError`) when `heading` names no recorded rule.
 * Removing the last one still leaves `decided: true` — the file itself is
 * rewritten (with zero entries), never deleted, the same "reviewed and
 * recorded none" state `confirmNoRefusals` produces (#29 AC2).
 */
export function removeNeverAnswerRule(duoDir: string, heading: string): Refusal[] {
  const existing = readRefusalsFile(duoDir);
  const index = existing.findIndex((refusal) => refusal.heading.toLowerCase() === heading.trim().toLowerCase());
  if (index === -1) {
    throw new RefusalNotFoundError(heading);
  }
  const updated = existing.filter((_, i) => i !== index);
  writeRefusalsFile(duoDir, updated);
  return updated;
}
