import { CLASSIFICATION_LEVELS } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { DuoConfig } from "../config.js";
import type { WorkspaceGroundedAttachment } from "../workspace/transport.js";
import { recordPublicOutcome, type DraftProvenance, type DraftSource } from "../drafting/draft-log.js";
import { notGrantedPassOnReason } from "../drafting/escalation.js";
import type { ConfidenceResult } from "../drafting/confidence.js";
import { draftReply } from "../drafting/pipeline.js";
import { resolveAutonomyForAnswering } from "../trust/demotion.js";
import { awayAnswerContext } from "../trust/away.js";
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
/**
 * The generic failure text an asker sees when answering itself breaks — the
 * 500 body `POST /ask` sends (src/serve/server.ts) and the workspace failure
 * event (src/workspace/payload.ts) both come from this one constant: one
 * asker-visible vocabulary, so a colleague can never tell which transport
 * answered, and internals never reach either surface.
 */
export const PUBLIC_ANSWER_FAILED_MESSAGE = "Something went wrong answering that.";

/**
 * guangshinhaha/duo#315: what a colleague is told when the owner declines
 * their first message to the duo — carried on the declined invitation
 * itself (the leave's `reason`). Fixed words, like the outcomes above, and
 * deliberately reason-free: it never says why, only where to go instead.
 * It names the owner in the third person — the duo never speaks as them.
 */
export function workspaceDeclineNotice(ownerName: string): string {
  return `Thanks for reaching out. ${ownerName}'s duo won't be answering in this conversation — please message ${ownerName} directly.`;
}

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
 * Who asked, as #160's audit context records it — one structured value in
 * place of the bare `askerRef` string, so a caller must state all three
 * facts rather than leave them implicit. `ref` is the display/handling ref
 * exactly as before; `resolved` is the tri-state lookup outcome (null = no
 * lookup ran — CLI asks per #43, device "owner"); `askLinkId` names the
 * verified ask link by id, never the raw secret. The shared-duo answering
 * path (#159's `answerSharedDuo`) takes this same shape for its usage-log
 * entries, so both branches of `POST /ask` record identical asker context.
 */
export interface AskerContext {
  readonly ref: string;
  readonly resolved: boolean | null;
  readonly askLinkId: string | null;
}

/**
 * The asker context every non-route writer supplies: no link (the CLI
 * never comes through an ask link) and no lookup (#43 never resolves the
 * ref; #69/#71 likewise). Named once here so each call site states the
 * invariant by calling it rather than by repeating a raw literal.
 */
export function cliAskerContext(ref: string): AskerContext {
  return { ref, resolved: null, askLinkId: null };
}

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
  asker: AskerContext,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
  ownerName: string,
  /**
   * #190: attachments that passed the grounding door — the workspace
   * service's one addition to this call. They ground the draft (and appear
   * in its sources, so provenance stays honest) without ever being logged
   * here: the public answer log below records the question and the posted
   * text, never the attachment bytes, which live for the one draft call
   * and are gone (#183 §3).
   */
  attachments?: readonly WorkspaceGroundedAttachment[],
  /**
   * digital-duo#251: called exactly when this resolves to `passed_on` —
   * a draft the owner needs to look at, never for `answered` (already
   * resolved with no owner action) or `declined_refused` (a boundary
   * already set, nothing to decide). Optional and fire-and-forget by
   * design: the CLI (`commands/permissions.ts`) and the MCP connector
   * (`serve/mcp-tools.ts`) omit it — the owner does not need a push about
   * a question they, or Claude on their behalf, just asked from where
   * they already are. `POST /ask` and the workspace answering pipeline
   * (`serve/server.ts`, `serve/workspace-wiring.ts`) are the two callers
   * that pass one, since those are exactly "someone asked while the owner
   * was elsewhere."
   */
  onEscalated?: (draftId: string) => void,
  /**
   * guangshinhaha/duo#314: where the question came from — the workspace
   * answering pipeline passes the conversation and the asker, so a passed-on
   * question's draft knows where the owner's answer belongs. Omitted (the
   * ask-link route, the CLI, the connector) the draft is recorded as the
   * owner's own, exactly as before.
   */
  provenance?: DraftProvenance,
): Promise<PublicAnswerOutcome> {
  // The asker-context fields every one of the three log appends below
  // carries identically — only topicId/outcome/text/draftId vary by branch.
  const askerLogContext = {
    askerRef: asker.ref,
    askLinkId: asker.askLinkId,
    askerResolved: asker.resolved,
    clearanceApplied: PUBLIC_ANSWER_CLEARANCE_CEILING,
  };
  // guangshinhaha/duo#270: "colleagues see a status line on every message
  // while [away mode] runs" (duo PR #339) — read once, appended to
  // whichever of the three outcomes below actually gets composed. Null
  // (the common case: nobody is away) leaves every message exactly as
  // before.
  const away = awayAnswerContext(storePath, passphrase, duoDir);
  const withAwayStatusLine = (text: string): string => (away.statusLine === null ? text : `${text}\n\n${away.statusLine}`);
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
    attachments,
    undefined, // no recipient: the duo answers, nobody's voice is being learned
    provenance === undefined ? {} : { provenance },
  );

  if (pipelineResult.kind === "escalation") {
    const outcome = pipelineResult.refused ? "declined_refused" : "passed_on";
    // guangshinhaha/duo#313/#314: what the asker was told, on the draft row
    // itself, with the pipeline's own reason as the reason it went on.
    recordPublicOutcome(storePath, passphrase, pipelineResult.draftId, outcome, pipelineResult.reason);
    const message = withAwayStatusLine(withPublicAttribution(pipelineResult.refused ? PUBLIC_REFUSAL_MESSAGE : PUBLIC_PASSED_ON_MESSAGE, ownerName));
    const logEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
      question,
      ...askerLogContext,
      topicId: null,
      outcome,
      text: message,
      draftId: pipelineResult.draftId,
    });
    if (pipelineResult.refused) {
      return { kind: "declined_refused", draftId: pipelineResult.draftId, logEntryId, message };
    }
    onEscalated?.(pipelineResult.draftId);
    return { kind: "passed_on", draftId: pipelineResult.draftId, logEntryId, message, topicId: undefined, ownerNotice: undefined };
  }

  const topicId = pipelineResult.topicId;
  const autonomy = topicId
    ? resolveAutonomyForAnswering(storePath, passphrase, duoDir, topicId, "T0")
    : { level: "ask" as const, stale: false, demotionNotice: undefined };

  // guangshinhaha/duo#270: an away period scoped "May do, plus topics I
  // pick" can make a topic auto-answerable for its window even though the
  // trust grid alone still says "ask" — never-answer rules and the
  // classification ceiling are untouched (both are already enforced
  // earlier, inside `draftReply` itself, before any topic or autonomy is
  // even resolved), exactly as `Away.tsx`'s own copy promises the owner
  // ("Never-answer rules and your ceiling still apply").
  const awayAllowsTopic = topicId !== undefined && autonomy.level !== "auto" && away.allowsTopic(topicId);

  // `topicId === undefined` is folded into this same guard (rather than
  // left implicit) so the narrowing below is airtight: resolveAutonomyForAnswering
  // is only ever called above when topicId is defined, and the fallback
  // literal "ask" used otherwise can never equal "auto" — but stating it
  // explicitly here means the "answered" path past this point never has to
  // assume that invariant silently holds.
  if ((autonomy.level !== "auto" && !awayAllowsTopic) || topicId === undefined) {
    // guangshinhaha/duo#314: the draft row holds the duo's attempt here (it
    // was confident), so the reason is the one the row could not say alone.
    recordPublicOutcome(storePath, passphrase, pipelineResult.draftId, "passed_on", notGrantedPassOnReason(topicId));
    const message = withAwayStatusLine(withPublicAttribution(PUBLIC_PASSED_ON_MESSAGE, ownerName));
    const logEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
      question,
      ...askerLogContext,
      topicId: topicId ?? null,
      outcome: "passed_on",
      text: message,
      draftId: pipelineResult.draftId,
    });
    onEscalated?.(pipelineResult.draftId);
    return {
      kind: "passed_on",
      draftId: pipelineResult.draftId,
      logEntryId,
      message,
      topicId,
      ownerNotice: autonomy.demotionNotice,
    };
  }

  recordPublicOutcome(storePath, passphrase, pipelineResult.draftId, "answered", null);
  const text = withAwayStatusLine(
    withPublicAttribution(pipelineResult.text, ownerName, pipelineResult.sources, {
      confidence: pipelineResult.confidence.score,
      evidenceAgeDays: pipelineResult.evidenceAgeDays,
    }),
  );
  const logEntryId = appendPublicAnswerLogEntry(storePath, passphrase, {
    question,
    ...askerLogContext,
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
