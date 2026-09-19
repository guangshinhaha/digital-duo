import type { DuoConfig } from "../config.js";
import { CLASSIFICATION_LEVELS } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { draftReply } from "../drafting/pipeline.js";

/**
 * `docs/concept.md` §4: a duo that outlives a posting is a genuinely new
 * object — "consult my predecessor," a historical record with an
 * increasingly stale view, never "consult me" as if its owner still spoke
 * for the role. #61's whole job is that framing shift, layered entirely on
 * top of #32's existing `draftReply` (the same context/confidence/escalation
 * machinery every other consumer of it uses) — nothing here re-derives
 * evidence or re-scores confidence, it only reframes what draftReply already
 * produced.
 */

/**
 * The successor consulting a predecessor's duo is not the predecessor
 * themselves, and, like #43's public answering, #61 does not build
 * per-asker clearance resolution — so every consultation is filtered to
 * the lowest defined classification level before rule-hit lookup,
 * confidence scoring, or generation ever sees anything above it (the same
 * `clearanceCeiling` parameter #43 added to `gatherDraftContext`/
 * `draftReply` for exactly this "not the owner's own eyes" case). Without
 * this, a successor could read a predecessor's entire personal store —
 * including anything above official_open — merely by pointing this
 * command at their store path: the same classification-boundary bypass
 * #43 caught and fixed for public answering, here for a different
 * non-owner reader.
 */
const PREDECESSOR_CONSULTATION_CLEARANCE_CEILING = CLASSIFICATION_LEVELS[0];

export const STALENESS_LEVELS = ["fresh", "aging", "stale", "very_stale"] as const;
export type StalenessLevel = (typeof STALENESS_LEVELS)[number];

/** Below this many days old, evidence is treated as current enough to need no extra hedge. */
const AGING_AFTER_DAYS = 30;
/** Past this, the position is old enough that "may well be out of date" is the honest read. */
const STALE_AFTER_DAYS = 90;
/**
 * Past this, hedging is strongest — matches #33/#69's existing "material
 * not revisited in about six months starts to look old" convention, reused
 * here rather than picking an unrelated number.
 */
const VERY_STALE_AFTER_DAYS = 180;

/**
 * #61 AC3: staleness increases visibly with time, never staying constant.
 * No dated evidence at all is treated as maximally cautious (`very_stale`)
 * rather than as if it were fresh — an undated position is the *least*
 * trustworthy case, not a neutral one.
 */
export function stalenessLevel(evidenceAgeDays: number | null): StalenessLevel {
  if (evidenceAgeDays === null) {
    return "very_stale";
  }
  if (evidenceAgeDays < AGING_AFTER_DAYS) {
    return "fresh";
  }
  if (evidenceAgeDays < STALE_AFTER_DAYS) {
    return "aging";
  }
  if (evidenceAgeDays < VERY_STALE_AFTER_DAYS) {
    return "stale";
  }
  return "very_stale";
}

function formatAge(evidenceAgeDays: number): string {
  const days = Math.round(evidenceAgeDays);
  if (days <= 0) {
    return "today";
  }
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The date/age half of every historical answer, worded more cautiously as
 * `level` climbs (#61 AC3). `evidenceTimestamp` gives the actual stated
 * date (#61 AC1: "as at a stated date"); its absence (no dated evidence at
 * all) is folded into the wording rather than silently omitted.
 */
export function stalenessHedge(level: StalenessLevel, evidenceAgeDays: number | null, evidenceTimestamp: string | null): string {
  if (evidenceTimestamp === null || evidenceAgeDays === null) {
    return "as of an undated record — this is likely stale; verify with whoever holds the post now before relying on it";
  }
  const when = `as of ${evidenceTimestamp.slice(0, 10)} (${formatAge(evidenceAgeDays)})`;
  switch (level) {
    case "fresh":
      return when;
    case "aging":
      return `${when} — treat this as dated, not current`;
    case "stale":
      return `${when} — this may well be out of date by now`;
    case "very_stale":
      return `${when} — this is likely stale; verify with whoever holds the post now before relying on it`;
  }
}

/**
 * #61 AC2's live-matter detector: a deterministic keyword heuristic, the
 * same "documented v1 stand-in" idiom `work-relevance.ts`/`decision-
 * guard.ts` use elsewhere in this codebase rather than an LLM dependency for
 * something this simple. Deliberately biased toward over-triggering: the
 * cost of framing an ordinary question as "can't speak to the current
 * position" is one extra sentence, not a wrong answer, so a broad match
 * list is the safe direction here (unlike, say, the relevance gate's
 * interrupt-someone cost).
 */
const LIVE_MATTER_PATTERNS: readonly RegExp[] = [
  /\bcurrent(ly)?\b/i,
  /\bright now\b/i,
  /\bas of (today|now)\b/i,
  /\bthese days\b/i,
  /\bat (the )?(present|moment)\b/i,
  /\bstill\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
];

export function isLiveMatterQuestion(question: string): boolean {
  return LIVE_MATTER_PATTERNS.some((pattern) => pattern.test(question));
}

function quote(text: string): string {
  return `"${text}"`;
}

function composeHistoricalAnswer(predecessorName: string, hedge: string, draftText: string): string {
  return [
    `${predecessorName} has since rotated out of this post — this is a historical record, not a live answer.`,
    `${hedge}, ${predecessorName} answered:`,
    quote(draftText),
  ].join("\n\n");
}

/** #61 AC2: never answers as though current — states plainly that it can't, gives the historical position anyway, and says the position may have changed. */
function composeDeclinedLiveAnswer(predecessorName: string, hedge: string, draftText: string): string {
  return [
    `${predecessorName} has since rotated out of this post, so this duo cannot speak to the current position.`,
    `${hedge}, ${predecessorName} answered:`,
    quote(draftText),
    "That position may have changed since — check with whoever currently holds the post.",
  ].join("\n\n");
}

export type PredecessorConsultationKind = "historical" | "declined_live" | "escalation";

export interface PredecessorConsultation {
  readonly kind: PredecessorConsultationKind;
  readonly text: string;
  readonly draftId: string;
  /** The evidence's own timestamp this answer is stated "as of" — null only for an escalation with nothing dated to ground it. */
  readonly evidenceTimestamp: string | null;
  readonly evidenceAgeDays: number | null;
  /** null only for an escalation with no evidence at all — there is nothing to rate the staleness of. */
  readonly stalenessLevel: StalenessLevel | null;
}

/**
 * Consults a predecessor's duo — the same personal duo `draftReply` already
 * answers from, reframed entirely around #61's own three acceptance
 * criteria rather than as if its owner still spoke for the role. Every
 * return path names `predecessorName` explicitly (the open question this
 * issue itself flags — "who owns the accountability for a predecessor
 * duo's answer" — is resolved here by naming the predecessor plainly and
 * pointing the reader at whoever currently holds the post, rather than
 * implying either one is answering *for* the role in the present tense).
 *
 * An escalation (no grounding at all — #32's own early-escalation case)
 * passes straight through unrenamed: there is no historical position to
 * frame in the first place, so wrapping "nothing to answer from" in
 * staleness language would be misleading, not honest.
 */
export async function consultPredecessorDuo(
  storePath: string,
  passphrase: string,
  duoDir: string,
  predecessorName: string,
  question: string,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
): Promise<PredecessorConsultation> {
  const result = await draftReply(
    storePath,
    passphrase,
    duoDir,
    question,
    null,
    embeddingProvider,
    inferenceProvider,
    confidenceConfig,
    PREDECESSOR_CONSULTATION_CLEARANCE_CEILING,
  );

  if (result.kind === "escalation") {
    return {
      kind: "escalation",
      text: `${predecessorName}'s duo has nothing dated to answer this from: ${result.reason}`,
      draftId: result.draftId,
      evidenceTimestamp: null,
      evidenceAgeDays: null,
      stalenessLevel: null,
    };
  }

  const level = stalenessLevel(result.evidenceAgeDays);
  const hedge = stalenessHedge(level, result.evidenceAgeDays, result.evidenceTimestamp);
  const live = isLiveMatterQuestion(question);

  return {
    kind: live ? "declined_live" : "historical",
    text: live
      ? composeDeclinedLiveAnswer(predecessorName, hedge, result.text)
      : composeHistoricalAnswer(predecessorName, hedge, result.text),
    draftId: result.draftId,
    evidenceTimestamp: result.evidenceTimestamp,
    evidenceAgeDays: result.evidenceAgeDays,
    stalenessLevel: level,
  };
}
