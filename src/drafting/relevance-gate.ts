/**
 * v1-tech-design.md §1.6 / AR-1: the first stage of the draft pipeline, and
 * the highest-severity finding in the adversarial review. Most mentions of
 * the owner are not questions they would answer — FYIs, thread adds,
 * thanks, social chatter — and a duo that drafts on every mention is a spam
 * generator, muted in week one. So this gate is tuned hard toward silence:
 * a missed draft costs nothing (the owner was answering anyway), a
 * spurious draft costs trust in the tool.
 *
 * Deliberately the mirror image of src/ingest/work-relevance.ts's bias:
 * that filter treats "no signal either way" as work-relevant because a
 * missed personal conversation costs a little noise, while a wrongly-
 * dropped work conversation loses content outright. Here the costs are
 * reversed — a missed draft is free, a spurious one is expensive — so an
 * ambiguous mention blocks instead of passing.
 *
 * The precision target is stated here, deliberately asymmetric: recall is
 * not tracked as a target at all, because a false negative costs nothing.
 */
export const RELEVANCE_GATE_TARGET_PRECISION = 0.95;

export type GateReason = "genuine_question" | "noise" | "ambiguous" | "refused_subject";

export interface GateVerdict {
  readonly passes: boolean;
  readonly reason: GateReason;
}

// Acknowledgements, social chatter, and "just so you know" markers — the
// FYI/thread-add/thanks/social cases AC2 names explicitly. Deliberately a
// short, literal list rather than an attempt at general sentiment
// detection: a keyword miss here just means an ambiguous verdict (still
// silence), never a false pass.
const NOISE_MARKERS = [
  "fyi",
  "just fyi",
  "heads up",
  "just letting you know",
  "just so you know",
  "no need to reply",
  "no action needed",
  "adding you to this thread",
  "added you to this thread",
  "looping you in",
  "cc'ing you",
  "cc you",
  "thanks",
  "thank you",
  "thx",
  "cheers",
  "lol",
  "haha",
  "nice one",
  "nice work",
  "good job",
  "great job",
  "well done",
  "congrats",
  "congratulations",
  "welcome aboard",
  "sounds good",
  "got it",
  "no worries",
  "np",
] as const;

// A question word/phrase at the start, or a "?" anywhere, is the signal
// that a mention is actually asking the owner something rather than just
// mentioning them. Kept deliberately simple — a missed question here is a
// false negative, which this gate is designed to tolerate.
const QUESTION_START_PATTERN =
  /^\s*(who|what|when|where|why|how|which|can|could|would|will|should|do|does|did|is|are|was|were)\b/i;

function looksLikeNoise(text: string): boolean {
  const lower = text.toLowerCase();
  return NOISE_MARKERS.some((marker) => lower.includes(marker));
}

function looksLikeQuestion(text: string): boolean {
  return text.includes("?") || QUESTION_START_PATTERN.test(text.trim());
}

/**
 * Whether `text` touches a subject the duo has been told to refuse. A
 * simple containment check against each refusal's own words — the same
 * "documented v1 stand-in for real classification" idiom
 * src/ingest/work-relevance.ts and src/shared-duo/decision-guard.ts both
 * use. Exported so both the gate (block silently) and the draft pipeline
 * (#34: escalate, citing the refusal, without composing an answer first)
 * can share one definition of "refused" rather than risking the two
 * drifting apart.
 */
export function matchesRefusedSubject(text: string, refusals: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  return refusals.find((refusal) => refusal.trim().length > 0 && lower.includes(refusal.trim().toLowerCase()));
}

/**
 * Pure classification, no I/O: given a mention's text and the duo's
 * refusal subjects, decides whether the draft pipeline should continue.
 *
 * Order matters: a refused subject blocks regardless of how question-
 * shaped the mention is (AC4) — checked before noise/question
 * classification, not after, so a question about a refused subject can
 * never accidentally pass as "genuine_question" first. Noise and question
 * signals are then evaluated together: noise alone blocks, a genuine
 * question alone passes, and — the asymmetric-cost case — both or neither
 * signal firing blocks as ambiguous (AC3) rather than passing by default.
 */
export function classifyMention(text: string, refusals: readonly string[] = []): GateVerdict {
  if (matchesRefusedSubject(text, refusals) !== undefined) {
    return { passes: false, reason: "refused_subject" };
  }

  const noisy = looksLikeNoise(text);
  const question = looksLikeQuestion(text);

  if (question && !noisy) {
    return { passes: true, reason: "genuine_question" };
  }
  if (noisy && !question) {
    return { passes: false, reason: "noise" };
  }
  // Either both signals fired (a "thanks, and also — is this due Friday?"
  // mixed message) or neither did (no signal at all): both are exactly the
  // "cannot classify confidently" case AC3 describes, and both block.
  return { passes: false, reason: "ambiguous" };
}
