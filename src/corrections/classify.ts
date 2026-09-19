import type { InferenceProvider } from "../provider/types.js";
import { DraftNotFoundError, getDraft, recordDraftOutcome, type SettableDraftOutcome } from "../drafting/draft-log.js";
import { contentWords, levenshteinDistance, normalizeWhitespace } from "./text-similarity.js";
import { queueCorrectionCandidates, type CorrectionCandidateKind } from "./queue.js";

/**
 * v1-tech-design.md §1.9: naively diffing draft against sent conflates two
 * signals. `"trivial"` is the fourth case the acceptance criteria name
 * explicitly — a one-character or whitespace change produces neither
 * candidate, because noise at this volume would drown the weekly review.
 */
export const EDIT_CLASSIFICATIONS = ["style", "substance", "both", "trivial"] as const;
export type EditClassification = (typeof EDIT_CLASSIFICATIONS)[number];

/**
 * A whitespace-normalized difference of at most one character is a
 * typo/punctuation fix, not a correction worth reviewing (#37 AC: "a
 * one-character or whitespace change produces nothing" — that's the bar
 * the acceptance criteria draw, so it's applied literally here). This does
 * mean a genuinely substantive one-character edit (e.g. "3pm" -> "4pm")
 * reads as trivial too; the AC treats edit *size* as the trivial signal
 * rather than edit *meaning*, and this function does exactly that rather
 * than second-guessing it with content-word comparison.
 */
export function isTrivialEdit(draftText: string, sentText: string): boolean {
  const a = normalizeWhitespace(draftText);
  const b = normalizeWhitespace(sentText);
  return a === b || levenshteinDistance(a, b) <= 1;
}

/** What fraction of `text`'s content words do NOT appear in `reference` — "how much genuinely new content did this introduce." 0 when `text` has no content words of its own (nothing new to introduce). */
function newContentRatio(text: string, reference: string): number {
  const textWords = contentWords(text);
  if (textWords.size === 0) {
    return 0;
  }
  const referenceWords = contentWords(reference);
  let novel = 0;
  for (const word of textWords) {
    if (!referenceWords.has(word)) {
      novel += 1;
    }
  }
  return novel / textWords.size;
}

// Below this, the sent text asserts essentially nothing the draft didn't
// already say — a pure rewording/trim, i.e. style. At or above the upper
// bound, the sent text is substantially new content — the draft's own
// content words barely survived — i.e. substance. Between the two, it's a
// genuine mix: some of the draft's content carried over, but real new
// content was introduced alongside it.
const NEW_CONTENT_STYLE_MAX = 0.2;
const NEW_CONTENT_SUBSTANCE_MIN = 0.6;

/**
 * Deterministic default classifier — the same "documented v1 stand-in"
 * idiom `work-relevance.ts`/`decision-guard.ts` use, rather than requiring
 * a configured LLM for classification to work at all. Measures how much of
 * `sentText`'s content (stop-words and phrasing stripped out) is genuinely
 * new relative to `draftText` — introducing new claims is what makes an
 * edit *substantive*; a low-or-zero rate means the sent version says the
 * same thing, however differently it's phrased.
 *
 * Lexical, not semantic: a full paraphrase that swaps every content word
 * for a synonym reads as "substance" here even when nothing actually
 * changed. Documented rather than fixed — the same limitation
 * `decision-guard.ts`'s own keyword matching already accepts, and
 * `createLlmEditClassifier` exists for exactly the cases where it matters.
 */
export function defaultEditClassifier(_question: string, draftText: string, sentText: string): "style" | "substance" | "both" {
  const introducedRatio = newContentRatio(sentText, draftText);
  if (introducedRatio < NEW_CONTENT_STYLE_MAX) {
    return "style";
  }
  return introducedRatio >= NEW_CONTENT_SUBSTANCE_MIN ? "substance" : "both";
}

export type EditClassifier = (question: string, draftText: string, sentText: string) => Promise<"style" | "substance" | "both">;

/** Wraps the deterministic default in the async EditClassifier shape, so it can stand in wherever a real (LLM-backed) classifier is expected. */
export const defaultAsyncEditClassifier: EditClassifier = (question, draftText, sentText) =>
  Promise.resolve(defaultEditClassifier(question, draftText, sentText));

/**
 * LLM-backed classification, best-effort — never throws; falls back to
 * `defaultEditClassifier` on any failure or an unparseable/unexpected
 * response, same degrade-rather-than-fail shape #23-#26 already use.
 */
export function createLlmEditClassifier(provider: InferenceProvider): EditClassifier {
  return async (question, draftText, sentText) => {
    try {
      const response = await provider.complete(
        [
          "A question was drafted an answer, then the owner edited it before sending. Classify the edit as exactly one word:",
          '"style" — the sent version says the same thing, just phrased, shortened, or toned differently.',
          '"substance" — the sent version answers the question differently; the actual content changed.',
          '"both" — some wording changed AND the actual content changed.',
          "",
          `Question: ${question}`,
          `Draft:    ${draftText}`,
          `Sent:     ${sentText}`,
          "",
          "Answer with exactly one of: style, substance, both. No other text.",
        ].join("\n"),
      );
      const cleaned = response.trim().toLowerCase();
      if (cleaned === "style" || cleaned === "substance" || cleaned === "both") {
        return cleaned;
      }
      return defaultEditClassifier(question, draftText, sentText);
    } catch {
      return defaultEditClassifier(question, draftText, sentText);
    }
  };
}

export interface EditClassificationResult {
  readonly classification: EditClassification;
}

/** Classifies one draft/sent pair — trivial edits are decided deterministically before the classifier ever runs, so a missing/unreachable provider never turns a typo fix into a queued candidate by accident. */
export async function classifyEdit(
  question: string,
  draftText: string,
  sentText: string,
  classifier: EditClassifier = defaultAsyncEditClassifier,
): Promise<EditClassificationResult> {
  if (isTrivialEdit(draftText, sentText)) {
    return { classification: "trivial" };
  }
  const classification = await classifier(question, draftText, sentText);
  return { classification };
}

/** Thrown when classification is attempted against a draft that was escalated (no draftText to diff against) — that flow is #34's `queueStandingOrderCandidate`, not this one. */
export class NoDraftTextError extends Error {
  constructor(draftId: string) {
    super(`Draft "${draftId}" has no draft text to diff against (it was escalated) — use the escalation-answer flow instead`);
    this.name = "NoDraftTextError";
  }
}

export interface ClassifyAndQueueResult {
  readonly classification: EditClassification;
  /** Which kind(s) of candidate ended up queued — empty for "trivial", and also empty (though classification is still reported) when queuing was a no-op: a rejected duplicate, or an already-queued candidate for this exact draft. */
  readonly queuedKinds: readonly CorrectionCandidateKind[];
}

/**
 * Thrown by `recordDraftOutcomeAndClassify` for an "edited" outcome whose
 * `sentText` is blank or whitespace-only. Checked here, once, rather than
 * separately in each caller (the daemon's HTTP route, `duo draft-outcome`):
 * an empty `sentText` scores as near-zero content in
 * `defaultEditClassifier`'s `newContentRatio` and gets classified as a
 * trivial "style" tweak — silently recording that the owner made a
 * wording change when they actually deleted the entire answer, and
 * corrupting the correction loop's training data either way this was
 * reached.
 */
export class BlankEditError extends Error {
  constructor(draftId: string) {
    super(`Draft "${draftId}": an "edited" outcome needs real text, not a blank or whitespace-only sentText`);
    this.name = "BlankEditError";
  }
}

/**
 * The orchestration entry point (#37): looks the draft up by id, classifies
 * the edit, and queues whatever candidates the classification implies.
 * Never writes to `duo/rules/` or `duo/voice.md` itself — that's #38's
 * batched review, per v1-tech-design.md §1.9 ("queue it; do not write
 * immediately").
 */
export async function classifyAndQueueEdit(
  storePath: string,
  passphrase: string,
  draftId: string,
  sentText: string,
  classifier?: EditClassifier,
): Promise<ClassifyAndQueueResult> {
  const draft = getDraft(storePath, passphrase, draftId);
  if (!draft) {
    throw new DraftNotFoundError(draftId);
  }
  if (draft.draftText === null) {
    throw new NoDraftTextError(draftId);
  }

  const { classification } = await classifyEdit(draft.question, draft.draftText, sentText, classifier);
  if (classification === "trivial") {
    return { classification, queuedKinds: [] };
  }

  const kinds: CorrectionCandidateKind[] = classification === "both" ? ["style", "substance"] : [classification];
  const results = queueCorrectionCandidates(
    storePath,
    passphrase,
    kinds.map((kind) => ({ kind, draftId, question: draft.question, draftText: draft.draftText as string, sentText })),
  );
  const queuedKinds = kinds.filter((_kind, index) => results[index].queued);
  return { classification, queuedKinds };
}

/**
 * The full "record an outcome" orchestration (#32 AC3 + #37), with an
 * explicit passphrase rather than one resolved from `config`/`env` — the
 * shape `client-tech-design.md` §1.2 calls for, so `duo serve` can call
 * this directly with the passphrase it already holds in memory instead of
 * going through `resolveOrCreatePassphrase`'s disk fallback.
 *
 * Records the outcome unconditionally first: whatever happens to
 * classification below, the outcome itself must never be lost.
 * `classifyAndQueueEdit` can only ever add to the queue, never touch that
 * row, so there is nothing here for a later classification failure to roll
 * back. An escalated draft has no `draftText` to diff against —
 * `NoDraftTextError` is swallowed rather than surfaced, since
 * classification genuinely doesn't apply there, not a failure the caller
 * should see as one.
 */
export async function recordDraftOutcomeAndClassify(
  storePath: string,
  passphrase: string,
  draftId: string,
  outcome: SettableDraftOutcome,
  sentText: string | undefined,
  classifier?: EditClassifier,
): Promise<ClassifyAndQueueResult | undefined> {
  if (outcome === "edited" && sentText !== undefined && sentText.trim().length === 0) {
    throw new BlankEditError(draftId);
  }
  recordDraftOutcome(storePath, passphrase, draftId, outcome, sentText);
  if (outcome !== "edited" || sentText === undefined) {
    return undefined;
  }
  try {
    return await classifyAndQueueEdit(storePath, passphrase, draftId, sentText, classifier);
  } catch (error) {
    if (error instanceof NoDraftTextError) {
      return undefined;
    }
    throw error;
  }
}
