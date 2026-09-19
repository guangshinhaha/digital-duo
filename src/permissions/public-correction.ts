import { publicAttributionLine } from "./attribution.js";
import { applyCorrection, type DemotionResult } from "../trust/demotion.js";
import { appendPublicAnswerLogEntry, getPublicAnswerLogEntry, type PublicAnswerLogEntry } from "./public-answer-log.js";

/** Thrown when the id given to `correctPublicAnswer` doesn't name any logged exchange at all — a typo, not "the thread is gone" (#45's own distinction: those are different failures with different meanings). */
export class PublicAnswerEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`No public-answer-log entry with id "${id}"`);
    this.name = "PublicAnswerEntryNotFoundError";
  }
}

/** Thrown when the id given names a real entry, but not one that ever asserted an answer (a passed-on or refused exchange never claimed anything, so there is nothing to be *wrong* about — #45's own scope is "a wrong answer posted by the duo"). */
export class NothingToCorrectError extends Error {
  constructor(id: string, outcome: string) {
    super(`Public-answer-log entry "${id}" is "${outcome}", not "answered" — there is no asserted answer to correct.`);
    this.name = "NothingToCorrectError";
  }
}

const THREAD_GONE_NOTICE =
  "The original thread no longer exists, so I couldn't post this there — the correction is recorded here, and the standing order is corrected regardless.";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * What gets posted in the original thread (or would have, had it still
 * existed) — visibly linked to the original answer by quoting it (#45
 * AC1: "visibly linked to the original answer"), never omitting the
 * correction text itself, and always labelled the same way every other
 * public message is (#44) — no confidence or evidence-age detail, since a
 * correction is the owner's own stated fact, not a scored draft.
 */
function composeCorrectionText(original: PublicAnswerLogEntry, correctedText: string, ownerName: string, demotion: DemotionResult | undefined): string {
  const parts = [
    `Correction to an earlier answer ("${truncate(original.text, 120)}"):`,
    correctedText,
  ];
  if (demotion?.demoted) {
    parts.push(`I got that one wrong, so I've dropped this topic back to asking the owner first before answering it publicly again.`);
  }
  parts.push(publicAttributionLine(ownerName));
  return parts.join("\n\n");
}

export interface CorrectPublicAnswerResult {
  readonly correctionEntryId: string;
  readonly originalEntryId: string;
  readonly correctedTopicId: string | null;
  /** The full, labelled correction text — posted in the original thread when `postedInThread` is true, and always recorded regardless (#45 AC2: "not silently dropped"). */
  readonly text: string;
  readonly postedInThread: boolean;
  /** Present only when `postedInThread` is false — what the owner is told instead. */
  readonly threadGoneNotice: string | undefined;
  /** undefined only when the original entry never resolved a topic at all (shouldn't happen for a real "answered" entry — #43's own invariant — but guarded rather than assumed). */
  readonly demotion: DemotionResult | undefined;
  /**
   * Who this codebase can actually identify as having read the original
   * answer, to notify (#45 AC1) — today, only the original asker: there is
   * no reactions/replies tracking anywhere in this codebase (Slack
   * integration, epic `e8`, stays blocked per the wave plan), the same
   * "no per-person identity beyond what's already tracked" limitation
   * #27's interruption portrait documents for threads generally. Named
   * plainly as a v1 stand-in rather than silently pretending to notify
   * readers this codebase has no way to know about.
   */
  readonly notifiedAskerRefs: readonly string[];
}

/**
 * Corrects a public answer already posted (#45): always writes a
 * brand-new, append-only log entry referencing the one it corrects
 * (`correctsEntryId` — the original is never touched, same shape #51's
 * `appendCorrection` uses for `audit_log`) *before* anything about whether
 * posting to the original thread succeeds is even considered, so the
 * correction is never silently dropped (AC2) regardless of that outcome.
 * Demotes the corrected topic's T0 cell immediately via #55's
 * `applyCorrection` (AC3) — "one correction drops the cell a level
 * immediately" (`docs/concept.md` §6) — and states that in the same text
 * that gets posted.
 *
 * `threadStillExists` is a caller-supplied fact this module cannot check
 * itself, the same "runtime fact about the specific instance" idiom
 * `src/actions/reversible.ts`'s `canRevertHere` uses: there is no live
 * channel integration in this codebase (epic `e8` stays blocked) to ask
 * whether a given thread still exists, so whatever surface eventually does
 * post there is what would supply this. Defaults to `true` — assume the
 * thread is still there unless told otherwise (AC2 is the exception case,
 * not the default one).
 */
export function correctPublicAnswer(
  storePath: string,
  passphrase: string,
  duoDir: string,
  originalEntryId: string,
  correctedText: string,
  ownerName: string,
  threadStillExists = true,
): CorrectPublicAnswerResult {
  const original = getPublicAnswerLogEntry(storePath, passphrase, originalEntryId);
  if (!original) {
    throw new PublicAnswerEntryNotFoundError(originalEntryId);
  }
  if (original.outcome !== "answered") {
    throw new NothingToCorrectError(originalEntryId, original.outcome);
  }

  const demotion = original.topicId
    ? applyCorrection(storePath, passphrase, { topicId: original.topicId, tier: "T0", correctionRef: originalEntryId })
    : undefined;

  const text = composeCorrectionText(original, correctedText, ownerName, demotion);

  const correctionEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
    question: original.question,
    askerRef: original.askerRef,
    topicId: original.topicId,
    outcome: "corrected",
    text,
    draftId: original.draftId,
    correctsEntryId: originalEntryId,
  });

  return {
    correctionEntryId,
    originalEntryId,
    correctedTopicId: original.topicId,
    text,
    postedInThread: threadStillExists,
    threadGoneNotice: threadStillExists ? undefined : THREAD_GONE_NOTICE,
    demotion,
    notifiedAskerRefs: [original.askerRef],
  };
}
