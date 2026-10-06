import type { DuoConfig } from "../config.js";
import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { ClassificationLevel } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { WorkspaceGroundedAttachment } from "../workspace/transport.js";
import {
  computeRecencyDecay,
  computeRetrievalStrength,
  computeSelfReport,
  runSelfConsistencySampling,
  scoreConfidence,
  type ConfidenceResult,
} from "./confidence.js";
import { gatherDraftContext, type DraftContext } from "./context.js";
import { appendDraft, type DraftRecipient, type DraftSource } from "./draft-log.js";
import { deriveRecipientVoice, type RecipientRegister } from "./recipient-voice.js";
import { explainEscalation, noEvidenceEscalationReason, refusedSubjectEscalationReason } from "./escalation.js";
import { buildDraftPrompt, extractiveDraft, pickRepresentativeSample } from "./generate.js";
import { matchesRefusedSubject } from "./relevance-gate.js";
import { readRefusalsFile } from "./refusals.js";

export interface DraftAnswer {
  readonly kind: "draft";
  readonly draftId: string;
  readonly text: string;
  readonly sources: readonly DraftSource[];
  readonly confidence: ConfidenceResult;
  /** The topic this draft's evidence belongs to, if any (see DraftContext.topicId) — what public answering (#43) checks against the T0 trust cell before this draft may ever leave the owner's own eyes. */
  readonly topicId: string | undefined;
  /** Age, in days, of the freshest supporting evidence (see DraftContext.freshestEvidenceAgeDays) — null when there's no evidence at all. Public answering (#44 AC1) states this on every public answer, so the reader sees staleness before trusting it. */
  readonly evidenceAgeDays: number | null;
  /** The freshest supporting evidence's own timestamp (see DraftContext.freshestEvidenceTimestamp) — null exactly when `evidenceAgeDays` is null. A predecessor-duo consultation (#61) states this as the date its answer is "as of". */
  readonly evidenceTimestamp: string | null;
  /** True when this draft was generated with the recipient's learned style in its prompt (duo#262) — what a Why panel reads to say "Tuned for how you write to Wei". Also persisted on the draft row. */
  readonly adaptedForRecipient: boolean;
  /** The detail behind `adaptedForRecipient`, null exactly when it is false. */
  readonly recipientAdaptation: RecipientAdaptation | null;
}

/** What a draft says about the recipient adaptation it used (duo#262): who, learned from how many sends, and which register that came out as. */
export interface RecipientAdaptation {
  readonly recipientId: string;
  readonly recipientName: string | null;
  readonly sampleSize: number;
  readonly register: RecipientRegister;
}

export interface DraftEscalation {
  readonly kind: "escalation";
  readonly draftId: string;
  readonly reason: string;
  /** True when this escalation is a refusal (#34 AC2) rather than a confidence-driven one — set without ever having reasoned about an answer, so a caller can tell "won't" apart from "can't" without parsing `reason`'s text. */
  readonly refused: boolean;
  readonly confidence: ConfidenceResult | undefined;
}

export type DraftPipelineResult = DraftAnswer | DraftEscalation;

/**
 * Every draft this pipeline writes was asked for by the owner — `duo
 * draft`, POST /drafts, the eval harness (#169). A channel adapter asking
 * on someone's behalf is a different caller that appends with its own
 * channel provenance; it must never be silently folded into "owner".
 */
const OWNER_PROVENANCE = { origin: "owner" } as const;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildSources(context: DraftContext, attachments: readonly WorkspaceGroundedAttachment[]): DraftSource[] {
  const sources: DraftSource[] = [];
  if (context.ruleHit) {
    // Same strip as extractiveDraft's rule branch (#155): the label quotes
    // the rule's own text, and the no-provider default rule text is a marked
    // answer copied verbatim — a source label must not echo the raw marking
    // back out any more than the draft body does.
    sources.push({
      kind: "rule",
      id: context.ruleHit.id,
      label: `standing order: ${truncate(stripMarkingLine({ text: context.ruleHit.text, classification: detectClassification(context.ruleHit.text) }), 80)}`,
    });
  }
  for (const attachment of attachments) {
    // #190/#183 §3: the attachment source carries the workspace's own file
    // reference as its id plus a filename/type/preview label — the same
    // truncate(…, 80) idiom the other labels use. No strip is needed here
    // because the door already stripped the text once, at the boundary,
    // before anything downstream (this label included) could echo it.
    sources.push({
      kind: "attachment",
      id: attachment.reference,
      label: `attachment ${attachment.name} (${attachment.mimeType}): ${truncate(attachment.text, 80)}`,
    });
  }
  for (const item of context.evidence) {
    // Same strip as extractiveDraft's evidence branch (#155): public
    // answering passes these labels into the posted answer
    // (renderSourceAttribution), and the public clearance ceiling admits
    // exactly the marked records — an unstripped label would echo the
    // marking on the surface with the widest audience.
    sources.push({
      kind: "evidence",
      id: item.recordId,
      label: `past exchange (similarity ${item.similarity.toFixed(2)}): ${truncate(stripMarkingLine(item), 80)}`,
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
  /** Passed straight through to `gatherDraftContext` — see that function's own doc comment. Omitted by every existing caller (the owner's own `duo draft`, the eval harness); public answering (#43) is the one caller that sets it. */
  publicClearanceCeiling?: ClassificationLevel,
  /**
   * #190/#183: attachments that passed the grounding door — provided
   * material for exactly this draft call, already marking-stripped at the
   * door. The one caller that sets it is public answering, fed by the
   * workspace service; the corpus-clearance ceiling above deliberately
   * does NOT filter them (the asker supplied the file and the room it was
   * shared in can already see it — #183 §6's argument), and they are never
   * written anywhere: not to `threadContext` (which IS persisted on the
   * draft row — the record's stated guard), not to any record or embedding.
   */
  attachments?: readonly WorkspaceGroundedAttachment[],
  /**
   * duo#262: who this reply is addressed to. When set, it is recorded on the
   * draft row (so the owner's eventual send teaches the duo how they write
   * to this person), and once RECIPIENT_ADAPTATION_MIN_SENDS approved sends
   * to them exist, generation is conditioned on that learned style. Omitted
   * by every caller that drafts for no particular person.
   */
  recipient?: DraftRecipient,
): Promise<DraftPipelineResult> {
  // Checked first, before any retrieval or generation: a refused subject
  // escalates "without reasoning about it" (#34 AC2) — there is no
  // internal draft composed and then withheld, because nothing below
  // this point ever runs for a refused question.
  const refusals = readRefusalsFile(duoDir);
  const matchedRefusal = matchesRefusedSubject(question, refusals);
  if (matchedRefusal !== undefined) {
    const reason = refusedSubjectEscalationReason(matchedRefusal);
    const draftId = appendDraft(storePath, passphrase, {
      question,
      threadContext,
      draftText: null,
      escalated: true,
      escalationReason: reason,
      confidenceScore: 0,
      sources: [],
      refused: true,
      escalationThreshold: confidenceConfig.escalationThreshold,
      provenance: OWNER_PROVENANCE,
      recipient: recipient ?? null,
    });
    return { kind: "escalation", draftId, reason, refused: true, confidence: undefined };
  }

  const retrieved = await gatherDraftContext(storePath, passphrase, duoDir, question, embeddingProvider, undefined, publicClearanceCeiling);
  // duo#262: how the owner writes to this recipient, when they named one and
  // there are enough approved sends to them to learn from — otherwise
  // undefined, and the general voice applies unchanged.
  const recipientVoice = recipient !== undefined ? deriveRecipientVoice(storePath, passphrase, recipient) : undefined;
  const context: DraftContext = recipientVoice !== undefined ? { ...retrieved, recipientVoice } : retrieved;
  // Only a generated draft reads the prompt the adaptation lives in; the
  // extractive fallback quotes a rule or evidence verbatim, so it is never
  // "tuned" for anyone and must not claim to be.
  const adaptedForRecipient = recipientVoice !== undefined && inferenceProvider !== undefined;
  const providedAttachments = attachments ?? [];
  const sources = buildSources(context, providedAttachments);

  // Nothing to ground a draft in at all: no rule hit, no retrieved
  // evidence, no attachment. An attachment that passed the door DOES count
  // as grounding here (#183 §3's exact requirement — otherwise a fresh duo
  // escalates every attachment question as groundless), which is the whole
  // of its influence on this pipeline's decisions: the confidence signals
  // below stay corpus-honest, because provided material is kin to a rule
  // hit, not retrieved evidence — retrievalStrength still measures only
  // what the corpus returned, and a duo with an empty corpus still scores
  // like one. Escalate immediately when there is nothing, before ever
  // asking a model to generate anything — buildDraftPrompt tells the model
  // "never invent facts", but a model asked to answer with zero context
  // can still return something confident-sounding and wrong, and #33's
  // default weights only guarantee escalation for this case at the
  // *scoring* step (retrievalStrength + ruleHit's combined weight matches
  // the default threshold exactly) — a reconfigured eval sweep could
  // weaken that guarantee. Checking here instead means a groundless draft
  // is never generated in the first place, under any weight configuration,
  // and it also skips a wasted inference call.
  if (context.ruleHit === undefined && context.evidence.length === 0 && providedAttachments.length === 0) {
    const reason = noEvidenceEscalationReason();
    const draftId = appendDraft(storePath, passphrase, {
      question,
      threadContext,
      draftText: null,
      escalated: true,
      escalationReason: reason,
      confidenceScore: 0,
      sources,
      refused: false,
      escalationThreshold: confidenceConfig.escalationThreshold,
      provenance: OWNER_PROVENANCE,
      recipient: recipient ?? null,
    });
    return { kind: "escalation", draftId, reason, refused: false, confidence: undefined };
  }

  let samples: readonly string[];
  let sampleEmbeddings: readonly (readonly number[])[];
  let selfConsistencyAgreement: number;

  if (inferenceProvider) {
    const prompt = buildDraftPrompt(question, threadContext, context, providedAttachments);
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
    // (no rule, no evidence, no attachment) already returned above.
    samples = [extractiveDraft(context, providedAttachments) as string];
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
      refused: false,
      escalationThreshold: confidenceConfig.escalationThreshold,
      provenance: OWNER_PROVENANCE,
      recipient: recipient ?? null,
    });
    return { kind: "escalation", draftId, reason, refused: false, confidence };
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
    refused: false,
    escalationThreshold: confidenceConfig.escalationThreshold,
    provenance: OWNER_PROVENANCE,
    recipient: recipient ?? null,
    adaptedForRecipient,
  });
  return {
    kind: "draft",
    draftId,
    text,
    sources,
    confidence,
    topicId: context.topicId,
    evidenceAgeDays: context.freshestEvidenceAgeDays,
    evidenceTimestamp: context.freshestEvidenceTimestamp,
    adaptedForRecipient,
    recipientAdaptation:
      adaptedForRecipient && recipientVoice !== undefined
        ? {
            recipientId: recipientVoice.recipient.id,
            recipientName: recipientVoice.recipient.name,
            sampleSize: recipientVoice.sampleSize,
            register: recipientVoice.features.register,
          }
        : null,
  };
}
