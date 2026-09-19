import { CLASSIFICATION_LEVELS } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { DuoConfig } from "../config.js";
import type { DraftSource } from "../drafting/draft-log.js";
import type { ConfidenceResult } from "../drafting/confidence.js";
import { draftReply } from "../drafting/pipeline.js";
import { resolveAutonomyForAnswering } from "../trust/demotion.js";
import { withPublicAttribution } from "./attribution.js";
import { appendPublicAnswerLogEntry } from "./public-answer-log.js";

/**
 * The public ceiling every colleague is treated at, uniformly (#43's own
 * out-of-scope note: "answering differently per asker...needs #10" — a
 * *uniform* ceiling is not differentiating by asker, it is the one thing
 * this issue explicitly does not build). The lowest defined level — the
 * same conservative default #49's `effectiveClearance` gives an unresolved
 * asker — since a public answer, unlike a private draft, may be read by
 * anyone in the workspace and there is no directory lookup here to grant
 * any individual colleague more than that.
 */
export const PUBLIC_ANSWER_CLEARANCE_CEILING = CLASSIFICATION_LEVELS[0];

/**
 * Fixed, word-for-word messages the asker sees whenever the duo does not
 * answer publicly — mirrors `src/permissions/answer.ts`'s DECLINE_MESSAGE
 * idiom (one exact string regardless of the underlying reason) so an asker
 * can never distinguish "this topic isn't granted yet" from "there wasn't
 * enough evidence" from wording alone. The refusal message is a distinct
 * string (#43 AC3 asks specifically that a refusal "says plainly that it
 * does not speak for the owner on this," which the generic passed-on
 * wording doesn't say) but, like the passed-on message, never hints at
 * what the answer might have been.
 */
export const PUBLIC_PASSED_ON_MESSAGE = "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.";
export const PUBLIC_REFUSAL_MESSAGE =
  "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.";

export interface PublicAnswered {
  readonly kind: "answered";
  readonly draftId: string;
  readonly logEntryId: string;
  /** The full text posted publicly — the generated answer, its sources, and its attribution (#44 AC1/AC3), already composed; there is nothing left for a caller to append. */
  readonly text: string;
  readonly sources: readonly DraftSource[];
  readonly confidence: ConfidenceResult;
  readonly topicId: string;
  /** Age, in days, of the freshest evidence behind this answer — null when none carried a usable timestamp. Also stated in `text` itself (#44 AC1); exposed here too for a caller that wants it structured. */
  readonly evidenceAgeDays: number | null;
}

export interface PublicPassedOn {
  readonly kind: "passed_on";
  readonly draftId: string;
  readonly logEntryId: string;
  readonly message: string;
  readonly topicId: string | undefined;
  /**
   * Present exactly once, on the first public answer attempt after a
   * demotion on this topic (#55's one-time announcement, threaded through
   * here since public answering is the answering path `resolveAutonomyForAnswering`
   * was built for). It's addressed to the owner, not the asker — surfaced
   * as its own field rather than folded into `message` so a caller can
   * decide where it belongs (e.g. the owner's escalation digest, #46) once
   * a real notification surface exists.
   */
  readonly ownerNotice: string | undefined;
}

export interface PublicDeclinedRefused {
  readonly kind: "declined_refused";
  readonly draftId: string;
  readonly logEntryId: string;
  readonly message: string;
}

export type PublicAnswerOutcome = PublicAnswered | PublicPassedOn | PublicDeclinedRefused;

/**
 * The graduation from private drafting (docs/v1-spec.md §2): a colleague's
 * question always drafts privately first — `draftReply` is #32/#34's own T1
 * pipeline, run here exactly as `duo draft` runs it, so the correction loop
 * and escalation-answer flow both keep working unchanged — and only *also*
 * gets posted publicly when every one of the following holds:
 *
 * 1. It wasn't a refused subject (#43 AC3) — checked first, inside
 *    `draftReply` itself, before any reasoning about an answer happens.
 * 2. There was enough evidence, all of it within the public clearance
 *    ceiling, to clear the confidence threshold (#43 AC4) — `draftReply` is
 *    called with `PUBLIC_ANSWER_CLEARANCE_CEILING`, so material above it
 *    never reaches the draft that could be exposed here at all, the same
 *    "filtered before generation" shape #49/#50 use for asker-scoped
 *    retrieval, just applied uniformly rather than per asker.
 * 3. The evidence's topic is granted `"auto"` T0 autonomy on the trust grid
 *    (#43 AC1/AC2) — a topic with no evidence, or evidence with no
 *    resolved topic, can never be granted anything, so it always resolves
 *    to "ask" and this case falls through the same "not yet granted" path.
 *
 * Any of those failing means the draft stays exactly what #32 already made
 * it — visible only to the owner — and the asker is told their question has
 * been passed on, worded per which case applied.
 *
 * Every one of the three return paths is composed through `withPublicAttribution`
 * before it is logged or returned (#44 AC1/AC2/AC3) — labelled as the
 * owner's duo speaking, never the owner, with confidence and evidence age
 * stated for an actual answer, and each source named as either the owner's
 * own standing order or merely retrieved. There is no parameter here, and
 * nothing read from configuration, that skips this step for any outcome.
 */
export async function answerPublicly(
  storePath: string,
  passphrase: string,
  duoDir: string,
  question: string,
  askerRef: string,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
  ownerName: string,
): Promise<PublicAnswerOutcome> {
  const pipelineResult = await draftReply(
    storePath,
    passphrase,
    duoDir,
    question,
    null,
    embeddingProvider,
    inferenceProvider,
    confidenceConfig,
    PUBLIC_ANSWER_CLEARANCE_CEILING,
  );

  if (pipelineResult.kind === "escalation") {
    const outcome = pipelineResult.refused ? "declined_refused" : "passed_on";
    const message = withPublicAttribution(pipelineResult.refused ? PUBLIC_REFUSAL_MESSAGE : PUBLIC_PASSED_ON_MESSAGE, ownerName);
    const logEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
      question,
      askerRef,
      topicId: null,
      outcome,
      text: message,
      draftId: pipelineResult.draftId,
    });
    return pipelineResult.refused
      ? { kind: "declined_refused", draftId: pipelineResult.draftId, logEntryId, message }
      : { kind: "passed_on", draftId: pipelineResult.draftId, logEntryId, message, topicId: undefined, ownerNotice: undefined };
  }

  const topicId = pipelineResult.topicId;
  const autonomy = topicId
    ? resolveAutonomyForAnswering(storePath, passphrase, duoDir, topicId, "T0")
    : { level: "ask" as const, stale: false, demotionNotice: undefined };

  // `topicId === undefined` is folded into this same guard (rather than
  // left implicit) so the narrowing below is airtight: resolveAutonomyForAnswering
  // is only ever called above when topicId is defined, and the fallback
  // literal "ask" used otherwise can never equal "auto" — but stating it
  // explicitly here means the "answered" path past this point never has to
  // assume that invariant silently holds.
  if (autonomy.level !== "auto" || topicId === undefined) {
    const message = withPublicAttribution(PUBLIC_PASSED_ON_MESSAGE, ownerName);
    const logEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
      question,
      askerRef,
      topicId: topicId ?? null,
      outcome: "passed_on",
      text: message,
      draftId: pipelineResult.draftId,
    });
    return {
      kind: "passed_on",
      draftId: pipelineResult.draftId,
      logEntryId,
      message,
      topicId,
      ownerNotice: autonomy.demotionNotice,
    };
  }

  const text = withPublicAttribution(pipelineResult.text, ownerName, pipelineResult.sources, {
    confidence: pipelineResult.confidence.score,
    evidenceAgeDays: pipelineResult.evidenceAgeDays,
  });
  const logEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
    question,
    askerRef,
    topicId,
    outcome: "answered",
    text,
    draftId: pipelineResult.draftId,
  });
  return {
    kind: "answered",
    draftId: pipelineResult.draftId,
    logEntryId,
    text,
    sources: pipelineResult.sources,
    confidence: pipelineResult.confidence,
    topicId,
    evidenceAgeDays: pipelineResult.evidenceAgeDays,
  };
}
