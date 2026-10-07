import type { DuoConfig } from "../config.js";
import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { ClassificationLevel } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { WorkspaceGroundedAttachment } from "../workspace/transport.js";
import {
  computeRecencyDecay,
  computeRetrievalStrength,
  computeSelfReport,
  isHedged,
  runSelfConsistencySampling,
  scoreConfidence,
  type ConfidenceResult,
  type ConfidenceSignals,
} from "./confidence.js";
import { gatherDraftContext, type DraftContext } from "./context.js";
import {
  appendDraft,
  readShapePreferences,
  recipientKeyOf,
  type DraftProvenance,
  type DraftRecipient,
  type DraftSource,
  type ShapeInstruction,
} from "./draft-log.js";
import { deriveRecipientVoice, type RecipientRegister } from "./recipient-voice.js";
import { explainEscalation, noEvidenceEscalationReason, refusedSubjectEscalationReason } from "./escalation.js";
import { ALTERNATIVE_INSTRUCTIONS, buildDraftPrompt, extractiveDraft, pickRepresentativeSample } from "./generate.js";
import { matchesRefusedSubject } from "./relevance-gate.js";
import { readRefusalsFile } from "./refusals.js";
import { findPinnedAnswer } from "../trust/pinned-answers.js";

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
  /**
   * guangshinhaha/duo#257: every candidate offered for this question when
   * the draft was hedged and more than one genuinely different candidate
   * survived — index 0 is this draft itself (`text`, `confidence`). Empty
   * for a confident draft, for a caller that didn't ask for alternatives,
   * and whenever the extra candidates came back too close to the default
   * to be a real choice.
   */
  readonly alternatives: readonly DraftCandidate[];
}

/** What a draft says about the recipient adaptation it used (duo#262): who, learned from how many sends, and which register that came out as. */
export interface RecipientAdaptation {
  readonly recipientId: string;
  readonly recipientName: string | null;
  readonly sampleSize: number;
  readonly register: RecipientRegister;
}

/** One candidate reply (guangshinhaha/duo#257) — its own text, its own composite confidence, and the sources it may cite (always the draft's one evidence pool). */
export interface DraftCandidate {
  readonly text: string;
  /** null for the default draft; otherwise the key of the ALTERNATIVE_INSTRUCTIONS entry it answered. */
  readonly instruction: string | null;
  readonly confidence: ConfidenceResult;
  readonly sources: readonly DraftSource[];
}

/** Optional pipeline behaviour, off unless a caller asks — every pre-#257 caller passes nothing and drafts exactly as before. */
export interface DraftReplyOptions {
  /**
   * guangshinhaha/duo#257: offer up to three candidates when the draft is
   * hedged. Only the owner-facing `POST /drafts` asks — a public answer
   * posts one reply, and the eval and calibration harnesses must not pay
   * for (or be scored on) candidates nobody chooses between.
   */
  readonly offerAlternatives?: boolean;
  /**
   * guangshinhaha/duo#314: where the question came from, when it was not
   * the owner. Public answering over the workspace passes the conversation
   * and the asker (a `channel` provenance), so the passed-on draft knows
   * which room to answer in and who asked. Omitted, the draft is the
   * owner's own — every pre-#314 caller, unchanged.
   */
  readonly provenance?: DraftProvenance;
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

/**
 * guangshinhaha/duo#285: "your duo is drafting" — a signal fired at
 * `draftReply`'s own entry (see below), before the refusal check and
 * everything after it, so every caller is heard from identically. A plain
 * listener set, not an event-bus dependency threaded through eight call
 * sites: nobody has to pass anything for this to exist, so every pre-#285
 * caller (the CLI's `duo draft`, the eval harness, calibration, the MCP
 * connector, `offerDraftForMention`) runs exactly as before — a `for`
 * loop over an empty set costs nothing worth measuring. The one
 * subscriber today is `serve/server.ts`, which turns a workspace-channel
 * provenance into a `draft-drafting` push over `/ws`
 * (`docs/client-tech-design.md` §1.4's `GET /ws` row) — see
 * `onDraftingStarted` below.
 */
const draftingStartedListeners = new Set<(provenance: DraftProvenance) => void>();

/**
 * Subscribes to every `draftReply` call's own "I'm about to compose a
 * draft for this provenance" signal (guangshinhaha/duo#285). Returns the
 * unsubscribe. A listener that throws is caught and dropped on the floor —
 * fire-and-forget means a subscriber's own bug must never interrupt
 * drafting, which is the one thing this signal must never risk being
 * blamed for.
 */
export function onDraftingStarted(listener: (provenance: DraftProvenance) => void): () => void {
  draftingStartedListeners.add(listener);
  return () => draftingStartedListeners.delete(listener);
}

function emitDraftingStarted(provenance: DraftProvenance): void {
  for (const listener of draftingStartedListeners) {
    try {
      listener(provenance);
    } catch {
      // See onDraftingStarted's own doc comment.
    }
  }
}

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

/** Lower-cased, whitespace-collapsed — two candidates equal under this are the same reply, whatever the model's spacing. */
function normalizeForComparison(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Two candidates closer than this (cosine over their embeddings) are the
 * same reply reworded — not a choice worth putting in front of the owner.
 * Deliberately strict: a "shorter" or "more careful" rewrite of the same
 * answer still embeds close to it, and those ARE the choices #257 wants;
 * only a candidate that ignored its instruction lands above this line.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.98;

/**
 * guangshinhaha/duo#257: generates the extra candidates for a hedged
 * draft — one call per ALTERNATIVE_INSTRUCTIONS entry, each with its own
 * instruction over the very same grounding (so every candidate cites the
 * one evidence pool, never new justification for a different tone), each
 * scored with the draft's shared signals plus its own self-report. A
 * candidate is dropped when it fails the escalation threshold on its own
 * (it would never have been shown alone), when it reads the same as one
 * already kept, or when the model call fails — alternatives are an extra,
 * so a failure costs only the extra. Returns the full candidate list with
 * the default first, or just the default when nothing distinct survived.
 */
async function generateAlternatives(
  primary: DraftCandidate,
  promptFor: (instruction: string) => string,
  question: string,
  sharedSignals: Omit<ConfidenceSignals, "selfReport">,
  inferenceProvider: InferenceProvider,
  embeddingProvider: EmbeddingProvider,
  confidenceConfig: DuoConfig["confidence"],
): Promise<DraftCandidate[]> {
  const embedSafely = async (text: string): Promise<readonly number[] | undefined> => {
    try {
      return await embeddingProvider.embed(text);
    } catch {
      return undefined;
    }
  };
  const kept: DraftCandidate[] = [primary];
  const keptEmbeddings: (readonly number[] | undefined)[] = [await embedSafely(primary.text)];

  for (const alternative of ALTERNATIVE_INSTRUCTIONS) {
    let text: string;
    try {
      text = (await inferenceProvider.complete(promptFor(alternative.text))).trim();
    } catch {
      continue;
    }
    if (text.length === 0 || kept.some((candidate) => normalizeForComparison(candidate.text) === normalizeForComparison(text))) {
      continue;
    }
    const embedding = await embedSafely(text);
    if (embedding && keptEmbeddings.some((other) => other !== undefined && cosine(other, embedding) >= NEAR_DUPLICATE_SIMILARITY)) {
      continue;
    }
    const selfReport = await getSelfReport(inferenceProvider, question, text);
    const confidence = scoreConfidence({ ...sharedSignals, selfReport }, confidenceConfig.weights, confidenceConfig.escalationThreshold);
    if (!confidence.passesThreshold) {
      continue;
    }
    kept.push({ text, instruction: alternative.key, confidence, sources: primary.sources });
    keptEmbeddings.push(embedding);
  }
  return kept;
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
  options: DraftReplyOptions = {},
): Promise<DraftPipelineResult> {
  // guangshinhaha/duo#314: the owner's own draft unless the caller says
  // whose question this is (public answering over the workspace).
  const provenance: DraftProvenance = options.provenance ?? OWNER_PROVENANCE;
  // guangshinhaha/duo#285: fired before anything else — the refusal check
  // included — so a subscriber hears about every call this function is
  // about to make a decision on, not only the ones that end in an actual
  // draft. See emitDraftingStarted's own doc comment for why this is safe
  // for every one of this function's callers.
  emitDraftingStarted(provenance);
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
      provenance,
      recipient: recipient ?? null,
    });
    return { kind: "escalation", draftId, reason, refused: true, confidence: undefined };
  }

  // duo#275: a pinned answer is the owner's own exact wording for this
  // question/topic — an explicit, owner-authored override that outranks
  // every derived standing order and every retrieved piece of evidence.
  // Checked next, still before any retrieval or generation runs: unlike a
  // rule hit (which only ever influences confidence scoring) a pinned
  // answer wins outright the moment its pattern matches, so it must never
  // be computed from, or second-guessed by, anything retrieval would turn
  // up. The text is quoted verbatim — never a generation target, never
  // passed through an inference provider — which is the whole point of
  // "pin exact wording".
  const pinned = findPinnedAnswer(storePath, passphrase, question);
  if (pinned !== undefined) {
    const sources: DraftSource[] = [{ kind: "pinned", id: pinned.id, label: `pinned answer: ${truncate(pinned.pattern, 80)}` }];
    // Maximal, deliberately: every signal at 1 so the composite score is
    // 1 regardless of how confidenceConfig.weights are tuned, and
    // `passesThreshold` can never flip false for a pin — the owner's own
    // exact words are not a confidence estimate, they are a decision
    // already made.
    const confidence = scoreConfidence(
      { selfConsistency: 1, retrievalStrength: 1, ruleHit: 1, recency: 1, selfReport: 1 },
      confidenceConfig.weights,
      confidenceConfig.escalationThreshold,
    );
    const draftId = appendDraft(storePath, passphrase, {
      question,
      threadContext,
      draftText: pinned.answerText,
      escalated: false,
      escalationReason: null,
      confidenceScore: confidence.score,
      sources,
      refused: false,
      escalationThreshold: confidenceConfig.escalationThreshold,
      provenance,
      recipient: recipient ?? null,
    });
    return {
      kind: "draft",
      draftId,
      text: pinned.answerText,
      sources,
      confidence,
      topicId: undefined,
      evidenceAgeDays: null,
      evidenceTimestamp: null,
      adaptedForRecipient: false,
      recipientAdaptation: null,
      alternatives: [],
    };
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
      provenance,
      recipient: recipient ?? null,
    });
    return { kind: "escalation", draftId, reason, refused: false, confidence: undefined };
  }

  let samples: readonly string[];
  let sampleEmbeddings: readonly (readonly number[])[];
  let selfConsistencyAgreement: number;

  // guangshinhaha/duo#258 AC3: shapes the owner keeps asking for toward
  // this person lean every later draft to them. The person is the named
  // recipient when the caller gave one (duo#262), else the asker for a
  // colleague's question (#314's channel provenance), else the owner themself.
  const recipientKey = recipientKeyOf(provenance, recipient ?? null);
  const preferences: readonly ShapeInstruction[] = recipientKey !== undefined ? readShapePreferences(storePath, passphrase, recipientKey) : [];

  if (inferenceProvider) {
    const prompt = buildDraftPrompt(question, threadContext, context, providedAttachments, { preferences });
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

  const sharedSignals = { selfConsistency: selfConsistencyAgreement, retrievalStrength, ruleHit: ruleHitSignal, recency };
  const confidence = scoreConfidence({ ...sharedSignals, selfReport }, confidenceConfig.weights, confidenceConfig.escalationThreshold);

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
      provenance,
      recipient: recipient ?? null,
    });
    return { kind: "escalation", draftId, reason, refused: false, confidence };
  }

  const text = pickRepresentativeSample(samples, sampleEmbeddings);

  // guangshinhaha/duo#257: a hedged draft — shown, but only just — is
  // exactly when one guess is weakest, so (when asked, and when there is a
  // model to ask) it comes with up to two alternatives. A confident draft
  // never does: one good answer is not improved by two more to read.
  let alternatives: DraftCandidate[] = [];
  if (options.offerAlternatives && inferenceProvider && isHedged(confidence)) {
    const candidates = await generateAlternatives(
      { text, instruction: null, confidence, sources },
      (instruction) => buildDraftPrompt(question, threadContext, context, providedAttachments, { instruction, preferences }),
      question,
      sharedSignals,
      inferenceProvider,
      embeddingProvider,
      confidenceConfig,
    );
    alternatives = candidates.length > 1 ? candidates : [];
  }

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
    provenance,
    recipient: recipient ?? null,
    adaptedForRecipient,
    alternatives: alternatives.map((candidate) => ({
      text: candidate.text,
      instruction: candidate.instruction,
      confidenceScore: candidate.confidence.score,
      sources: candidate.sources,
    })),
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
    alternatives,
  };
}
