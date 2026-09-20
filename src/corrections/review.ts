import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withDatabase } from "../store/store.js";
import {
  getStandingOrderCandidate,
  listStandingOrderCandidates,
  requirePendingStandingOrderCandidate,
  setStandingOrderCandidateStatus,
  StandingOrderCandidateNotFoundError,
  type StandingOrderCandidate,
} from "../drafting/standing-order-candidates.js";
import { listActiveRules, writeCorrectionRule } from "../derivation/rule-review.js";
import type { Rule } from "../derivation/rules.js";
import {
  CorrectionCandidateNotFoundError,
  getCorrectionCandidate,
  listCorrectionCandidates,
  requirePendingCandidate,
  setCandidateStatus,
  type CorrectionCandidate,
  type CorrectionCandidateKind,
} from "./queue.js";
import { contentWordOverlap } from "./text-similarity.js";

/**
 * #38: the owner's one periodic review over everything the correction loop
 * has queued — #37's style/substance candidates (from an edited draft) and
 * #34's standing-order candidates (from an answered escalation) alike,
 * merged into one list rather than two screens to check. A style
 * candidate's `proposedText` is what would be added to `duo/voice.md`; a
 * substance candidate's is what would become a rule's text.
 */
export interface PendingReviewCandidate {
  readonly id: string;
  readonly kind: CorrectionCandidateKind;
  readonly source: "draft_edit" | "escalation";
  readonly draftId: string;
  readonly question: string;
  /** The original draft text, when there was one — null for an escalation (#34), which had no confident draft to edit. */
  readonly draftText: string | null;
  readonly proposedText: string;
  readonly createdAt: string;
}

function fromCorrectionCandidate(candidate: CorrectionCandidate): PendingReviewCandidate {
  return {
    id: candidate.id,
    kind: candidate.kind,
    source: "draft_edit",
    draftId: candidate.draftId,
    question: candidate.question,
    draftText: candidate.draftText,
    proposedText: candidate.sentText,
    createdAt: candidate.createdAt,
  };
}

function fromStandingOrderCandidate(candidate: StandingOrderCandidate): PendingReviewCandidate {
  return {
    id: candidate.id,
    kind: "substance",
    source: "escalation",
    draftId: candidate.draftId,
    question: candidate.question,
    draftText: null,
    proposedText: candidate.answerText,
    createdAt: candidate.createdAt,
  };
}

// A candidate is only "about" a rule when its question shares at least this
// much of the rule's own vocabulary — otherwise every substance candidate
// would spuriously "relate" to every rule that happens to share a stop-word
// or two. Deliberately low: a question and the policy answering it share
// far fewer literal words than two answers to the same question would.
const RELATED_TOPIC_THRESHOLD = 0.15;
// Below this, a "related" candidate's proposed text and the existing
// rule's text share too little to be the same policy restated — i.e. they
// disagree, not just phrase things differently.
const CONFLICTING_CONTENT_MAX_OVERLAP = 0.3;

/**
 * #38 AC4: "a proposed rule contradicting an active one is flagged."
 * Deterministic, lexical — the same documented-limitation idiom as
 * classify.ts's own heuristic, and reusing its exact similarity primitive
 * rather than inventing a second one.
 */
export function findConflictingActiveRule(candidate: PendingReviewCandidate, activeRules: readonly Rule[]): Rule | undefined {
  if (candidate.kind !== "substance") {
    return undefined;
  }
  for (const rule of activeRules) {
    const relatedness = contentWordOverlap(candidate.question, rule.text);
    if (relatedness < RELATED_TOPIC_THRESHOLD) {
      continue;
    }
    const agreement = contentWordOverlap(candidate.proposedText, rule.text);
    if (agreement < CONFLICTING_CONTENT_MAX_OVERLAP) {
      return rule;
    }
  }
  return undefined;
}

export interface SubstanceConflict {
  readonly candidate: PendingReviewCandidate;
  readonly conflictingRule: Rule;
}

/** A review candidate in its current state — `PendingReviewCandidate` plus what a review action left behind (#173: "the updated candidate returns"). */
export interface ReviewCandidate extends PendingReviewCandidate {
  readonly status: "pending" | "approved" | "rejected";
  readonly reviewedAt: string | null;
}

/**
 * Reads one review candidate by id across both source tables (draft edits
 * first, the same order `requirePendingReviewCandidate` searches), in
 * whatever state it is in — the read that turns a review action into an
 * updated candidate for the surface that asked for it (#173). Undefined
 * when neither table holds the id.
 */
export function getReviewCandidate(storePath: string, passphrase: string, id: string): ReviewCandidate | undefined {
  const correction = getCorrectionCandidate(storePath, passphrase, id);
  if (correction) {
    return { ...fromCorrectionCandidate(correction), status: correction.status, reviewedAt: correction.reviewedAt };
  }
  const standing = getStandingOrderCandidate(storePath, passphrase, id);
  if (standing) {
    return { ...fromStandingOrderCandidate(standing), status: standing.status, reviewedAt: standing.reviewedAt };
  }
  return undefined;
}

export interface PendingReview {
  readonly candidates: readonly PendingReviewCandidate[];
  readonly conflicts: readonly SubstanceConflict[];
}

/**
 * #38 AC3: "an empty queue says nothing" — an empty `candidates` array is
 * exactly that signal; the CLI prints nothing further when it sees one,
 * rather than a recurring "nothing to review" notification.
 */
export function listPendingReview(storePath: string, passphrase: string, duoDir: string): PendingReview {
  const candidates: PendingReviewCandidate[] = [
    ...listCorrectionCandidates(storePath, passphrase, "pending").map(fromCorrectionCandidate),
    ...listStandingOrderCandidates(storePath, passphrase)
      .filter((candidate) => candidate.status === "pending")
      .map(fromStandingOrderCandidate),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const activeRules = listActiveRules(storePath, passphrase, duoDir);
  const conflicts: SubstanceConflict[] = [];
  for (const candidate of candidates) {
    const conflictingRule = findConflictingActiveRule(candidate, activeRules);
    if (conflictingRule) {
      conflicts.push({ candidate, conflictingRule });
    }
  }

  return { candidates, conflicts };
}

/** Thrown by rejectCandidate/approveCandidate when no pending candidate with the given id exists in either source table. */
export class ReviewCandidateNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending correction candidate with id "${id}"`);
    this.name = "ReviewCandidateNotFoundError";
  }
}

/**
 * #38 AC4: approving a substance candidate that contradicts an active rule
 * is refused outright — no override exists yet (that's #39 AC3's job: a
 * real "supersede" resolution). This makes "asked to choose" a real gate at
 * review time rather than a cosmetic warning next to a write that happens
 * anyway.
 */
export class CandidateConflictError extends Error {
  readonly conflictingRule: Rule;

  constructor(candidate: PendingReviewCandidate, conflictingRule: Rule) {
    super(
      `Candidate "${candidate.id}" (question: "${candidate.question}") conflicts with active rule "${conflictingRule.id}": ` +
        `"${conflictingRule.text}". Resolve the conflict before approving.`,
    );
    this.name = "CandidateConflictError";
    this.conflictingRule = conflictingRule;
  }
}

/** duo/voice.md's own "## Corrections" section — a running, provenance-carrying log of style edits the owner has approved, distinct from the statistical profile #26's `duo derive voice` computes above it. */
function voiceFilePath(duoDir: string): string {
  return join(duoDir, "voice.md");
}

const CORRECTIONS_HEADING = "## Corrections";

/**
 * Appends one style correction to `duo/voice.md`'s "## Corrections"
 * section, creating the file (with a placeholder header noting the full
 * profile comes from `duo derive voice`) and the section if either doesn't
 * exist yet. Never touches anything above the section it owns.
 */
function appendVoiceCorrection(duoDir: string, candidate: PendingReviewCandidate): void {
  const path = voiceFilePath(duoDir);
  const existing = existsSync(path)
    ? readFileSync(path, "utf8")
    : "# Voice profile\n\nRun `duo derive voice` to compute the statistical profile.\n";

  const entry =
    `- (${new Date().toISOString()}) draft "${candidate.draftText}" -> sent "${candidate.proposedText}" ` +
    `(question: "${candidate.question}", draft ${candidate.draftId})`;

  const updated = existing.includes(CORRECTIONS_HEADING)
    ? `${existing.trimEnd()}\n${entry}\n`
    : `${existing.trimEnd()}\n\n${CORRECTIONS_HEADING}\n\n${entry}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, updated, "utf8");
}

/**
 * Looks a pending candidate up across both source tables, requiring it to
 * still be pending in whichever one holds it — the one precondition every
 * review action needs, resolved once here rather than by each caller.
 */
function requirePendingReviewCandidate(
  storePath: string,
  passphrase: string,
  id: string,
): { candidate: PendingReviewCandidate; source: "draft_edit" | "escalation" } {
  try {
    const candidate = withDatabase(storePath, passphrase, false, (db) => requirePendingCandidate(db, id));
    return { candidate: fromCorrectionCandidate(candidate), source: "draft_edit" };
  } catch (error) {
    if (!(error instanceof CorrectionCandidateNotFoundError)) {
      throw error;
    }
  }
  try {
    const candidate = withDatabase(storePath, passphrase, false, (db) => requirePendingStandingOrderCandidate(db, id));
    return { candidate: fromStandingOrderCandidate(candidate), source: "escalation" };
  } catch (error) {
    if (error instanceof StandingOrderCandidateNotFoundError) {
      throw new ReviewCandidateNotFoundError(id);
    }
    throw error;
  }
}

/** #38 AC2: rejecting persists — neither source table's row is ever reset back to pending by anything in this codebase, so a rejected candidate never resurfaces. */
export function rejectCandidate(storePath: string, passphrase: string, id: string): void {
  const { source } = requirePendingReviewCandidate(storePath, passphrase, id);
  withDatabase(storePath, passphrase, true, (db) => {
    if (source === "draft_edit") {
      requirePendingCandidate(db, id);
      setCandidateStatus(db, id, "rejected");
    } else {
      requirePendingStandingOrderCandidate(db, id);
      setStandingOrderCandidateStatus(db, id, "rejected");
    }
  });
}

export interface ApproveCandidateResult {
  readonly kind: CorrectionCandidateKind;
  readonly rule: Rule | undefined;
}

export interface ApproveCandidateOptions {
  /**
   * #39 AC3: the id of the active rule this substance candidate replaces.
   * Required to approve a candidate `findConflictingActiveRule` flags —
   * without it, approval is refused (CandidateConflictError) rather than
   * silently accumulating two contradictory rules (#38 AC4). Honored even
   * when no conflict was auto-detected: the lexical heuristic is
   * approximate, and the owner may know two rules conflict when it didn't
   * catch that.
   */
  readonly supersedesRuleId?: string;
}

/**
 * #38 AC1 / #39 AC1/AC3: approving writes the change to `duo/rules/`
 * (substance) or `duo/voice.md` (style), with provenance, and only then
 * marks the candidate approved. A substance candidate that conflicts with
 * an active rule is refused (CandidateConflictError) unless
 * `options.supersedesRuleId` names the rule it replaces, in which case that
 * rule is retired (marked `superseded`, pointing at its replacement)
 * instead of left active alongside the new one.
 */
export function approveCandidate(
  storePath: string,
  passphrase: string,
  duoDir: string,
  id: string,
  options: ApproveCandidateOptions = {},
): ApproveCandidateResult {
  const { candidate, source } = requirePendingReviewCandidate(storePath, passphrase, id);

  if (candidate.kind === "style") {
    appendVoiceCorrection(duoDir, candidate);
    withDatabase(storePath, passphrase, true, (db) => {
      requirePendingCandidate(db, id);
      setCandidateStatus(db, id, "approved");
    });
    return { kind: "style", rule: undefined };
  }

  if (options.supersedesRuleId === undefined) {
    const activeRules = listActiveRules(storePath, passphrase, duoDir);
    const conflict = findConflictingActiveRule(candidate, activeRules);
    if (conflict) {
      throw new CandidateConflictError(candidate, conflict);
    }
  }

  const rule = writeCorrectionRule(
    storePath,
    passphrase,
    duoDir,
    candidate.question,
    candidate.proposedText,
    candidate.draftId,
    candidate.question,
    options.supersedesRuleId,
  );
  withDatabase(storePath, passphrase, true, (db) => {
    if (source === "draft_edit") {
      requirePendingCandidate(db, id);
      setCandidateStatus(db, id, "approved");
    } else {
      requirePendingStandingOrderCandidate(db, id);
      setStandingOrderCandidateStatus(db, id, "approved");
    }
  });
  return { kind: "substance", rule };
}
