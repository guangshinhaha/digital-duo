import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { WorkspaceGroundedAttachment } from "../workspace/transport.js";
import type { DraftContext } from "./context.js";
import { renderRecipientVoiceSection } from "./recipient-voice.js";
import type { ShapeInstruction } from "./draft-log.js";

/**
 * Renders one door-passed attachment into the prompt's attachment section.
 * The text is already marking-stripped at the door (#190 — the strip
 * happens before the prompt is built, not only after, closing #164's
 * recorded residual for this path), so this adds provenance the model can
 * cite and nothing it could echo as a raw marking.
 */
function attachmentSection(attachments: readonly WorkspaceGroundedAttachment[]): string[] {
  const parts: string[] = [];
  for (const attachment of attachments) {
    parts.push(`--- ${attachment.name} (${attachment.mimeType}) ---`);
    parts.push(attachment.text);
  }
  return parts;
}

/**
 * What each shape chip (guangshinhaha/duo#258) asks of a rewrite, in the
 * same plain imperative the rest of these prompts use. Each one says what
 * to change AND what must stay — a tone change is never licence to add a
 * fact, a promise, or a reason the material doesn't give.
 */
export const SHAPE_INSTRUCTION_TEXT: Readonly<Record<ShapeInstruction, string>> = {
  shorter: "Make it shorter: keep only what answers the question, and drop nothing the asker needs.",
  warmer: "Make it warmer and friendlier in tone, without adding any new fact, promise or reason.",
  more_formal: "Make it more formal and polished in tone, without adding any new fact, promise or reason.",
  more_direct: "Make it more direct: lead with the answer and cut preamble and filler, without overstating anything.",
};

/**
 * The extra candidates a hedged draft offers (guangshinhaha/duo#257),
 * beside the default one. Each is a distinct instruction rather than the
 * same prompt re-run, because sampling one prompt several times is exactly
 * how self-consistency measures *agreement* — near-identical text is the
 * expected result there, and useless as a choice. Chosen for the case they
 * serve: a draft that only just cleared the threshold is weakest on how
 * much to commit to, so one candidate commits to less, briefly, and one
 * says plainly what it isn't sure of.
 */
export const ALTERNATIVE_INSTRUCTIONS: readonly { readonly key: string; readonly text: string }[] = [
  {
    key: "shorter",
    text: "Write a short, plain reply that commits only to what the material above clearly supports.",
  },
  {
    key: "cautious",
    text: "Write a more careful reply: answer what the material above supports, and say plainly what you are not sure of or would need to check.",
  },
];

/** Optional extras for one draft prompt — both omitted by every pre-#257 caller, which keeps that prompt byte-identical. */
export interface DraftPromptOptions {
  /** One candidate's own instruction (ALTERNATIVE_INSTRUCTIONS) — omitted for the default draft. */
  readonly instruction?: string;
  /** Shapes the owner keeps asking for toward this person (readShapePreferences, #258 AC3), most-used first. */
  readonly preferences?: readonly ShapeInstruction[];
}

/** The grounding every drafting prompt shares — voice, standing order, evidence, attachments, thread — so a shape (#258) rewrites against exactly what the draft was written from. */
function groundingSection(
  threadContext: string | null,
  context: DraftContext,
  attachments: readonly WorkspaceGroundedAttachment[],
): string[] {
  const parts: string[] = [];
  parts.push("Voice profile:");
  parts.push(context.voiceText);
  if (context.recipientVoice) {
    // duo#262: right after the general profile it refines, so the model reads
    // "how they write" and then "how they write to this person" together.
    parts.push("");
    parts.push(...renderRecipientVoiceSection(context.recipientVoice));
  }
  if (context.ruleHit) {
    parts.push("");
    parts.push(`A standing order directly covers this: "${context.ruleHit.text}"`);
  }
  if (context.evidence.length > 0) {
    parts.push("");
    parts.push("Past similar exchanges:");
    for (const item of context.evidence) {
      parts.push(`- ${item.text}`);
    }
  }
  if (attachments.length > 0) {
    parts.push("");
    parts.push("Material the asker attached to this question (ground your answer in it where relevant):");
    parts.push(...attachmentSection(attachments));
  }
  if (threadContext) {
    parts.push("");
    parts.push("Preceding thread context (most recent question is what you're answering):");
    parts.push(threadContext);
  }
  return parts;
}

/** "shorter", "warmer", "more formal and more direct" — how a preference line names the shapes. */
function describePreferences(preferences: readonly ShapeInstruction[]): string {
  const words = preferences.map((preference) => preference.replace("_", " "));
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Builds the completion prompt for one draft sample. Includes the
 * standing order (if any), the top evidence, the voice profile (refined by
 * how the owner writes to this recipient, when known — duo#262), the
 * asker's attachments (#190 — provided material, placed just ahead of the
 * question it rode with), and the piped-in thread context (#32 AC4) ahead
 * of the question itself, so the model answers with that context rather
 * than the last line in isolation. `options` adds one candidate's
 * instruction (#257) and the owner's standing shape preferences toward
 * this person (#258), each just before the closing line.
 */
export function buildDraftPrompt(
  question: string,
  threadContext: string | null,
  context: DraftContext,
  attachments: readonly WorkspaceGroundedAttachment[] = [],
  options: DraftPromptOptions = {},
): string {
  const parts: string[] = [];
  parts.push("You are drafting a reply in this person's own voice, for them to review before sending. Never invent facts.");
  parts.push("");
  parts.push(...groundingSection(threadContext, context, attachments));
  parts.push("");
  parts.push(`Question: ${question}`);
  if (options.preferences && options.preferences.length > 0) {
    parts.push("");
    parts.push(`This person has repeatedly asked for replies like this to be ${describePreferences(options.preferences)} — lean that way.`);
  }
  if (options.instruction) {
    parts.push("");
    parts.push(options.instruction);
  }
  parts.push("");
  parts.push("Reply with only the draft reply text — no preamble, no explanation.");
  return parts.join("\n");
}

/**
 * Builds the prompt that reshapes an existing draft (guangshinhaha/duo#258)
 * — re-entering generation with the draft's own grounding rebuilt from its
 * stored sources (rebuildDraftContext), never a fresh retrieval, so the
 * rewrite can only lean on what the original could cite. The current text
 * is given as the thing to rewrite, and the instruction says what may
 * change; the closing guard says what may not.
 */
export function buildShapePrompt(
  question: string,
  threadContext: string | null,
  context: DraftContext,
  currentDraft: string,
  instruction: ShapeInstruction,
): string {
  const parts: string[] = [];
  parts.push("You are revising a reply drafted in this person's own voice, for them to review before sending. Never invent facts.");
  parts.push("");
  parts.push(...groundingSection(threadContext, context, []));
  parts.push("");
  parts.push(`Question: ${question}`);
  parts.push("");
  parts.push("The current draft:");
  parts.push(currentDraft);
  parts.push("");
  parts.push(SHAPE_INSTRUCTION_TEXT[instruction]);
  parts.push("Keep every fact the current draft states, and add none that isn't in it or in the material above.");
  parts.push("");
  parts.push("Reply with only the revised draft text — no preamble, no explanation.");
  return parts.join("\n");
}

/**
 * No-provider / degrade fallback: the standing order's own text if one
 * directly covers the question, else the asker's first attachment if the
 * question rode with one (#190 — provided material, kin to a rule hit, so
 * it outranks retrieved evidence for the question it rode with), else the
 * single closest piece of past evidence, verbatim except for a leading
 * classification marking (stripMarkingLine, #155) — no synthesis, same
 * "degrade rather than fail" shape as src/permissions/answer.ts's
 * extractiveAnswer, which strips the same marking for the same reason:
 * whoever reads the draft was already allowed the content (by clearance,
 * or by being the owner), so the raw stamp adds nothing but noise. Fixing
 * it here, the one fallback every draftReply surface shares, covers `duo
 * draft`, public answering, and predecessor consultation at once.
 * Attachment text needs no strip here — the door already stripped it once,
 * at the boundary (#190). Returns undefined only when there's truly
 * nothing to draft from, which is exactly the signal the pipeline uses to
 * skip generation and go straight to composing an escalation.
 */
export function extractiveDraft(context: DraftContext, attachments: readonly WorkspaceGroundedAttachment[] = []): string | undefined {
  if (context.ruleHit) {
    // A rule row carries no classification of its own (rules.ts), but the
    // no-provider default rule text is a marked answer copied verbatim — so
    // read the marking back off the rule's own first line, the same read
    // detectClassification made at ingest, and strip only that.
    return stripMarkingLine({ text: context.ruleHit.text, classification: detectClassification(context.ruleHit.text) });
  }
  const attachment = attachments[0];
  if (attachment !== undefined) {
    return attachment.text;
  }
  const best = context.evidence[0];
  return best ? stripMarkingLine(best) : undefined;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
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
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Picks one representative draft text out of several self-consistency
 * samples: the one closest to the group's own centroid, same
 * "deterministic stand-in for the representative answer" idiom
 * src/derivation/rules.ts's mostCentralText uses, rather than always
 * picking the first sample arbitrarily.
 */
export function pickRepresentativeSample(samples: readonly string[], sampleEmbeddings: readonly (readonly number[])[]): string {
  if (samples.length === 0) {
    return "";
  }
  if (samples.length === 1 || sampleEmbeddings.length !== samples.length) {
    return samples[0];
  }
  const dimensions = sampleEmbeddings[0]?.length ?? 0;
  const centroid = new Array(dimensions).fill(0);
  for (const vector of sampleEmbeddings) {
    for (let i = 0; i < dimensions; i++) {
      centroid[i] += vector[i] / sampleEmbeddings.length;
    }
  }
  let bestIndex = 0;
  let bestSimilarity = -Infinity;
  for (let i = 0; i < sampleEmbeddings.length; i++) {
    const similarity = cosineSimilarity(sampleEmbeddings[i], centroid);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = i;
    }
  }
  return samples[bestIndex];
}
