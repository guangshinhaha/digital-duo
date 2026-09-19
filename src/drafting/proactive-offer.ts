import type { DuoConfig } from "../config.js";
import { formatEvidenceAge } from "../permissions/attribution.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { isChannelMuted } from "./channel-mutes.js";
import type { ConfidenceResult } from "./confidence.js";
import type { DraftSource } from "./draft-log.js";
import { runRelevanceGate, type Mention } from "./gate.js";
import type { GateReason } from "./relevance-gate.js";
import { draftReply } from "./pipeline.js";

/**
 * #47: "the duo should watch threads where its owner is mentioned and
 * proactively offer a draft — to the owner only" (`docs/concept.md` §10,
 * naming "nobody invokes it" as a known risk). #31's relevance gate
 * (`runRelevanceGate`) was built explicitly *for* this entry point — "for
 * a future Slack-mention entry point, not an owner-typed CLI question" —
 * and this is that future consumer, still exercised over a hand-supplied
 * `Mention` in the meantime (epic `e8`'s live Slack integration stays
 * blocked, same as everywhere else in this codebase that names it).
 *
 * Every offer is a real, unconditional call into #32/#34's own
 * `draftReply` — never a parallel drafting path — so the correction loop
 * and the `duo draft-outcome`/`duo draft-answer` mechanisms an owner
 * already knows are exactly "the one action to post it" AC1 asks for:
 * there is no separate "send" function here at all (AC's own out-of-scope
 * item: "posting proactively without the owner acting").
 */

export type ProactiveOfferOutcome =
  | { readonly kind: "muted"; readonly channel: string }
  | { readonly kind: "gate_declined"; readonly reason: GateReason; readonly gateLogId: string }
  | { readonly kind: "no_draft"; readonly reason: string; readonly draftId: string; readonly gateLogId: string }
  | {
      readonly kind: "offer";
      readonly draftId: string;
      /** The generated reply, with its evidence age stated on it (#47 AC2) — composed here, not left for a caller to remember to append. */
      readonly text: string;
      readonly sources: readonly DraftSource[];
      readonly confidence: ConfidenceResult;
      readonly evidenceAgeDays: number | null;
      readonly gateLogId: string;
    };

/**
 * Checks the per-channel mute (#47 AC3, before anything else runs at all
 * — a muted channel produces no gate decision, no draft, nothing), then
 * the relevance gate (#31), then drafts exactly as `duo draft` would.
 * `mention.channel` is optional: a mention with no channel (e.g. a DM, or
 * a hand-supplied test mention) can never be muted, since there is
 * nothing to mute it *by*.
 */
export async function offerDraftForMention(
  storePath: string,
  passphrase: string,
  duoDir: string,
  mention: Mention,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
): Promise<ProactiveOfferOutcome> {
  if (mention.channel !== undefined && isChannelMuted(duoDir, mention.channel)) {
    return { kind: "muted", channel: mention.channel };
  }

  const gateOutcome = runRelevanceGate(storePath, passphrase, duoDir, mention);
  if (!gateOutcome.passes) {
    return { kind: "gate_declined", reason: gateOutcome.reason, gateLogId: gateOutcome.logId };
  }

  const result = await draftReply(
    storePath,
    passphrase,
    duoDir,
    mention.text,
    mention.threadContext ?? null,
    embeddingProvider,
    inferenceProvider,
    confidenceConfig,
  );

  if (result.kind === "escalation") {
    return { kind: "no_draft", reason: result.reason, draftId: result.draftId, gateLogId: gateOutcome.logId };
  }

  const text = `${result.text}\n\n(${formatEvidenceAge(result.evidenceAgeDays)} — check before sending.)`;
  return {
    kind: "offer",
    draftId: result.draftId,
    text,
    sources: result.sources,
    confidence: result.confidence,
    evidenceAgeDays: result.evidenceAgeDays,
    gateLogId: gateOutcome.logId,
  };
}
