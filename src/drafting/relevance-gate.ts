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

// Rhetorical/sarcastic-question markers — #137. The question signal above
// only says a mention is question-SHAPED; it can't tell "What's the status
// on the contract?" (asking the owner) from "Why does this always happen
// on a Friday?" (venting) or "Isn't it wild how long that outage went
// on?" (fishing for agreement), and answering the second kind as if it
// were the first is exactly the spurious draft this gate exists to
// suppress — all four of #137's measured false positives were rhetorical
// questions. Each pattern below is a high-precision shape cue for that,
// in the same "documented v1 stand-in for real classification" idiom as
// NOISE_MARKERS: a short marker set, not intent detection, and a marker
// miss just leaves the mention wherever the question/noise signals
// already put it. The set deliberately errs toward matching: a rhetorical
// question left unflagged is the expensive false positive, while a
// genuine question caught here ("Why have we never tested the
// failover?") becomes a false negative, which per the asymmetric design
// above costs nothing. All patterns run against lowercased text with
// curly apostrophes folded onto the ASCII one (see looksRhetorical).
const RHETORICAL_PATTERNS = [
  // Complaint framing: a why-question about something that happens every
  // time or never at all ("why does this always happen...", "why do the
  // notes never mention...").
  /\bwhy\b[^?]*\b(always|never)\b[^?]*\?/,
  // Exasperation: an intensifier directly after the question word ("who
  // even reviews these anymore", "what even is this").
  /\b(who|what|why|how|when|where|which)\s+even\b/,
  // An opinion offered for agreement: a negative question carrying an
  // evaluative word ("isn't it wild how...", "hasn't this week been
  // ridiculous"). Without the evaluative word a negative question stays
  // genuine — "isn't the contract up for renewal?" is really asking.
  /\b(isn't|aren't|wasn't|weren't|doesn't|don't|can't|couldn't|shouldn't|wouldn't|hasn't|haven't)\s+(it|that|this|there)\b[^?]{0,30}\b(wild|crazy|insane|ridiculous|absurd|hilarious|unbelievable|incredible|amazing|classic|typical)\b/,
  // Agreement-seeking tags: a trailing cue that makes the "question" a
  // statement fishing for a yes ("..., right?", "am I right?"). "right?"
  // needs the comma — "which option is right?" is genuinely asking.
  /(,\s*right|am i right|wouldn't you say|don't you think)\?\s*$/,
  // Fixed idioms that are rhetorical in essentially any mention: "can
  // you believe", "who cares", and the shrug "who knows?" (with its own
  // question mark, unlike the genuine "who knows the admin password?").
  /\b(can|could) you believe\b/,
  /\bwho cares\b/,
  /\bwho knows\?/,
] as const;

function looksLikeNoise(text: string): boolean {
  const lower = text.toLowerCase();
  return NOISE_MARKERS.some((marker) => lower.includes(marker));
}

function looksLikeQuestion(text: string): boolean {
  return text.includes("?") || QUESTION_START_PATTERN.test(text.trim());
}

// #137: question-shaped, but venting or fishing for agreement rather
// than asking the owner anything.
function looksRhetorical(text: string): boolean {
  // The apostrophe-bearing patterns above spell ASCII ', so fold the curly
  // single quotes phone/Slack autocorrect produces (#137 review finding:
  // "isn’t it wild…" would otherwise slip through as a genuine question).
  const lower = text.toLowerCase().replace(/[‘’]/g, "'");
  return RHETORICAL_PATTERNS.some((pattern) => pattern.test(lower));
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
 * A rhetorical question (#137) blocks the same way: it carries the
 * question shape but not the question intent, which is not something a
 * keyword gate can settle confidently.
 */
export function classifyMention(text: string, refusals: readonly string[] = []): GateVerdict {
  if (matchesRefusedSubject(text, refusals) !== undefined) {
    return { passes: false, reason: "refused_subject" };
  }

  const noisy = looksLikeNoise(text);
  const question = looksLikeQuestion(text);
  // Only reachable from the genuine-question branch below, so skip the
  // pattern pass entirely on the gate's dominant input: a mention that
  // isn't question-shaped can't be a rhetorical question.
  const rhetorical = question && looksRhetorical(text);

  if (question && !noisy && !rhetorical) {
    return { passes: true, reason: "genuine_question" };
  }
  if (noisy && !question) {
    return { passes: false, reason: "noise" };
  }
  // Either both signals fired (a "thanks, and also — is this due Friday?"
  // mixed message), neither did (no signal at all), or the question was
  // rhetorical (#137: venting or fishing for agreement, not asking):
  // all are exactly the "cannot classify confidently" case AC3 describes,
  // and all block.
  return { passes: false, reason: "ambiguous" };
}
