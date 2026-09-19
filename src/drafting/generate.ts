import type { DraftContext } from "./context.js";

/**
 * Builds the completion prompt for one draft sample. Includes the
 * standing order (if any), the top evidence, the voice profile, and the
 * piped-in thread context (#32 AC4) ahead of the question itself, so the
 * model answers with that context rather than the last line in isolation.
 */
export function buildDraftPrompt(question: string, threadContext: string | null, context: DraftContext): string {
  const parts: string[] = [];
  parts.push("You are drafting a reply in this person's own voice, for them to review before sending. Never invent facts.");
  parts.push("");
  parts.push("Voice profile:");
  parts.push(context.voiceText);
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
  if (threadContext) {
    parts.push("");
    parts.push("Preceding thread context (most recent question is what you're answering):");
    parts.push(threadContext);
  }
  parts.push("");
  parts.push(`Question: ${question}`);
  parts.push("");
  parts.push("Reply with only the draft reply text — no preamble, no explanation.");
  return parts.join("\n");
}

/**
 * No-provider / degrade fallback: the standing order's own text if one
 * directly covers the question, else the single closest piece of past
 * evidence, verbatim — no synthesis, same "degrade rather than fail" shape
 * as src/permissions/answer.ts's extractiveAnswer. Returns undefined only
 * when there's truly nothing to draft from, which is exactly the signal
 * the pipeline uses to skip generation and go straight to composing an
 * escalation.
 */
export function extractiveDraft(context: DraftContext): string | undefined {
  if (context.ruleHit) {
    return context.ruleHit.text;
  }
  const best = context.evidence[0];
  return best?.text;
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
