import type { DuoConfig } from "../config.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import {
  computeRecencyDecay,
  computeRetrievalStrength,
  computeSelfReport,
  runSelfConsistencySampling,
  scoreConfidence,
  type ConfidenceResult,
} from "./confidence.js";
import { gatherDraftContext, type DraftContext } from "./context.js";
import { appendDraft, type DraftSource } from "./draft-log.js";
import { explainEscalation, noEvidenceEscalationReason } from "./escalation.js";
import { buildDraftPrompt, extractiveDraft, pickRepresentativeSample } from "./generate.js";

export interface DraftAnswer {
  readonly kind: "draft";
  readonly draftId: string;
  readonly text: string;
  readonly sources: readonly DraftSource[];
  readonly confidence: ConfidenceResult;
}

export interface DraftEscalation {
  readonly kind: "escalation";
  readonly draftId: string;
  readonly reason: string;
  readonly confidence: ConfidenceResult | undefined;
}

export type DraftPipelineResult = DraftAnswer | DraftEscalation;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildSources(context: DraftContext): DraftSource[] {
  const sources: DraftSource[] = [];
  if (context.ruleHit) {
    sources.push({ kind: "rule", id: context.ruleHit.id, label: `standing order: ${truncate(context.ruleHit.text, 80)}` });
  }
  for (const item of context.evidence) {
    sources.push({
      kind: "evidence",
      id: item.recordId,
      label: `past exchange (similarity ${item.similarity.toFixed(2)}): ${truncate(item.text, 80)}`,
    });
  }
  return sources;
}

/** Best-effort: asks the model to rate its own confidence in the first draft sample. Never throws — a missing provider or an unparseable response just leaves the self-report signal at its neutral default (computeSelfReport(null)). */
async function getSelfReport(provider: InferenceProvider, question: string, draftText: string): Promise<number> {
  try {
    const response = await provider.complete(
      `You just drafted this reply to "${question}":\n"${draftText}"\nOn a scale of 0 to 100, how confident are you that this is a correct and complete answer? Reply with only the number.`,
    );
    return computeSelfReport(response);
  } catch {
    return computeSelfReport(null);
  }
}

/**
 * The owner's own draft pipeline (v1-tech-design.md §1.7, minus the
 * relevance gate — #31's gate is for inbound Slack mentions; a question
 * the owner types into `duo draft` is, by construction, one they want
 * answered). Gathers context, generates (self-consistency sampling when a
 * provider is configured, else the deterministic extractive fallback),
 * scores composite confidence (#33), and either returns a draft or
 * suppresses it in favor of an honest escalation (#32 AC2) — every call
 * writes exactly one row to the draft log either way, so the correction
 * loop and the eval both have something to read later.
 */
export async function draftReply(
  storePath: string,
  passphrase: string,
  duoDir: string,
  question: string,
  threadContext: string | null,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
  confidenceConfig: DuoConfig["confidence"],
): Promise<DraftPipelineResult> {
  const context = await gatherDraftContext(storePath, passphrase, duoDir, question, embeddingProvider);
  const sources = buildSources(context);

  // Nothing to ground a draft in at all: no rule hit, no retrieved
  // evidence. Escalate immediately, before ever asking a model to
  // generate anything — buildDraftPrompt tells the model "never invent
  // facts", but a model asked to answer with zero context can still
  // return something confident-sounding and wrong, and #33's default
  // weights only guarantee escalation for this case at the *scoring*
  // step (retrievalStrength + ruleHit's combined weight matches the
  // default threshold exactly) — a reconfigured eval sweep could weaken
  // that guarantee. Checking here instead means a groundless draft is
  // never generated in the first place, under any weight configuration,
  // and it also skips a wasted inference call.
  if (context.ruleHit === undefined && context.evidence.length === 0) {
    const reason = noEvidenceEscalationReason();
    const draftId = appendDraft(storePath, passphrase, {
      question,
      threadContext,
      draftText: null,
      escalated: true,
      escalationReason: reason,
      confidenceScore: 0,
      sources,
    });
    return { kind: "escalation", draftId, reason, confidence: undefined };
  }

  let samples: readonly string[];
  let sampleEmbeddings: readonly (readonly number[])[];
  let selfConsistencyAgreement: number;

  if (inferenceProvider) {
    const prompt = buildDraftPrompt(question, threadContext, context);
    const sampling = await runSelfConsistencySampling(
      prompt,
      confidenceConfig.selfConsistencySamples,
      (p) => inferenceProvider.complete(p),
      (text) => embeddingProvider.embed(text),
    );
    samples = sampling.samples;
    sampleEmbeddings = sampling.sampleEmbeddings;
    selfConsistencyAgreement = sampling.agreement;
  } else {
    // extractiveDraft is guaranteed defined here: the groundless case
    // (no rule, no evidence) already returned above.
    samples = [extractiveDraft(context) as string];
    sampleEmbeddings = [];
    selfConsistencyAgreement = 1;
  }

  const selfReport = inferenceProvider ? await getSelfReport(inferenceProvider, question, samples[0]) : computeSelfReport(null);
  const retrievalStrength = computeRetrievalStrength(context.evidence.map((item) => item.similarity));
  const recency = computeRecencyDecay(context.freshestEvidenceAgeDays, confidenceConfig.recencyHalfLifeDays);
  const ruleHitSignal = context.ruleHit ? 1 : 0;

  const confidence = scoreConfidence(
    { selfConsistency: selfConsistencyAgreement, retrievalStrength, ruleHit: ruleHitSignal, recency, selfReport },
    confidenceConfig.weights,
    confidenceConfig.escalationThreshold,
  );

  if (!confidence.passesThreshold) {
    const reason = explainEscalation(confidence, context);
    const draftId = appendDraft(storePath, passphrase, {
      question,
      threadContext,
      draftText: null,
      escalated: true,
      escalationReason: reason,
      confidenceScore: confidence.score,
      sources,
    });
    return { kind: "escalation", draftId, reason, confidence };
  }

  const text = pickRepresentativeSample(samples, sampleEmbeddings);
  const draftId = appendDraft(storePath, passphrase, {
    question,
    threadContext,
    draftText: text,
    escalated: false,
    escalationReason: null,
    confidenceScore: confidence.score,
    sources,
  });
  return { kind: "draft", draftId, text, sources, confidence };
}
