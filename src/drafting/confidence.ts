/**
 * v1-tech-design.md §1.8: model self-reported confidence is poorly
 * calibrated, so it's weighted lowest. Self-consistency — generating
 * several drafts and measuring their agreement — is cheap at this volume
 * and genuinely calibrating; retrieval strength and an explicit rule hit
 * are strong signals that need no extra model call at all.
 *
 * Deliberately split into two halves, each independently testable:
 * - computeXxx functions turn raw evidence (draft samples, retrieved
 *   records, ages) into a single 0..1 signal value.
 * - scoreConfidence composes already-computed signal values into one
 *   score using configured weights (#33's own acceptance criteria: "signal
 *   weights live in configuration, not in code, so the eval harness can
 *   sweep them") — a pure function with no I/O, so a sweep never needs a
 *   live provider or store to run.
 */

export interface ConfidenceWeights {
  readonly selfConsistency: number;
  readonly retrievalStrength: number;
  readonly ruleHit: number;
  readonly recency: number;
  readonly selfReport: number;
}

/** Every signal, already reduced to 0..1 (ruleHit is 0 or 1) — individually visible, per #33 AC1, rather than collapsed into one opaque number before this point. */
export interface ConfidenceSignals {
  readonly selfConsistency: number;
  readonly retrievalStrength: number;
  readonly ruleHit: number;
  readonly recency: number;
  readonly selfReport: number;
}

export interface ConfidenceResult {
  readonly signals: ConfidenceSignals;
  readonly weights: ConfidenceWeights;
  /** The weighted composite, 0..1. Weights are normalized by their own sum, so they don't need to add to exactly 1 for a sweep to scale them freely. */
  readonly score: number;
  readonly passesThreshold: boolean;
  readonly threshold: number;
}

/**
 * Composes pre-computed signal values into one score and a threshold
 * decision. Every signal must already be a plain 0..1 number — this
 * function does no clamping or interpretation of raw evidence, which is
 * what keeps it trivially sweep-able (the eval harness can pass any
 * signal/weight combination straight through).
 */
export function scoreConfidence(
  signals: ConfidenceSignals,
  weights: ConfidenceWeights,
  threshold: number,
): ConfidenceResult {
  const totalWeight =
    weights.selfConsistency + weights.retrievalStrength + weights.ruleHit + weights.recency + weights.selfReport;
  const weightedSum =
    signals.selfConsistency * weights.selfConsistency +
    signals.retrievalStrength * weights.retrievalStrength +
    signals.ruleHit * weights.ruleHit +
    signals.recency * weights.recency +
    signals.selfReport * weights.selfReport;
  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { signals, weights, score, threshold, passesThreshold: score >= threshold };
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

/** Same "mean of every pairwise similarity" shape as src/derivation/rules.ts's consistency measure — one sample trivially agrees with itself. */
function averagePairwiseSimilarity(vectors: readonly (readonly number[])[]): number {
  if (vectors.length <= 1) {
    return 1;
  }
  let total = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarity(vectors[i], vectors[j]);
      count += 1;
    }
  }
  return count === 0 ? 1 : total / count;
}

export interface SelfConsistencyResult {
  readonly samples: readonly string[];
  readonly sampleEmbeddings: readonly (readonly number[])[];
  readonly agreement: number;
  readonly sampleCount: number;
  /** The cost per draft #33's checklist asks to record — wall-clock time spent generating all samples. */
  readonly elapsedMs: number;
}

/**
 * Generates `sampleCount` drafts and measures their agreement by average
 * pairwise cosine similarity over their embeddings — the same
 * "genuinely calibrating" measure v1-tech-design.md §1.8 describes.
 * `generate` and `embed` are injected rather than this module depending on
 * InferenceProvider/EmbeddingProvider directly, so a test can supply fixed
 * samples/vectors and assert a deterministic agreement score. A single
 * sample (e.g. the no-provider extractive fallback, which is always the
 * same text) trivially agrees with itself — score 1 — consistent with
 * rules.ts's averagePairwiseSimilarity precedent.
 */
export async function runSelfConsistencySampling(
  prompt: string,
  sampleCount: number,
  generate: (prompt: string) => Promise<string>,
  embed: (text: string) => Promise<readonly number[]>,
): Promise<SelfConsistencyResult> {
  const start = Date.now();
  const samples: string[] = [];
  for (let i = 0; i < Math.max(1, sampleCount); i++) {
    samples.push(await generate(prompt));
  }
  const elapsedMs = Date.now() - start;

  // Character-for-character identical samples are unambiguous full
  // agreement — checked before ever embedding anything, both because it's
  // strictly cheaper and because it's *more* correct than the embedding
  // path: a sample with no signal any embedding model can pick up on
  // (e.g. very short, or outside the model's vocabulary) would otherwise
  // embed to a degenerate all-zero vector, whose cosine similarity to
  // itself is conventionally undefined and this module treats as 0 — the
  // opposite of what identical text actually means.
  if (samples.every((sample) => sample === samples[0])) {
    return { samples, sampleEmbeddings: [], agreement: 1, sampleCount: samples.length, elapsedMs };
  }

  let sampleEmbeddings: (readonly number[])[] = [];
  let agreement = 1;
  try {
    sampleEmbeddings = await Promise.all(samples.map((sample) => embed(sample)));
    agreement = averagePairwiseSimilarity(sampleEmbeddings);
  } catch {
    // Embedding the samples failed (e.g. the embedding service is down) —
    // this is a best-effort measurement, so it degrades to a neutral value
    // rather than failing the whole draft over a signal that isn't even
    // the primary output.
    agreement = 0.5;
  }

  return { samples, sampleEmbeddings, agreement, sampleCount: samples.length, elapsedMs };
}

/** Retrieval-strength signal: how much, and how similar, past supporting evidence is. `MIN_STRONG_EVIDENCE_COUNT` matches src/derivation/rules.ts's own support threshold — the same "3 supporting instances" bar used to promote a rule to `confirmed`. */
const MIN_STRONG_EVIDENCE_COUNT = 3;

export function computeRetrievalStrength(evidenceSimilarities: readonly number[]): number {
  if (evidenceSimilarities.length === 0) {
    return 0;
  }
  const averageSimilarity = evidenceSimilarities.reduce((sum, value) => sum + value, 0) / evidenceSimilarities.length;
  const countFactor = Math.min(1, evidenceSimilarities.length / MIN_STRONG_EVIDENCE_COUNT);
  return clamp01(averageSimilarity * countFactor);
}

/**
 * Recency-decay signal: exponential half-life over the age, in days, of
 * the freshest supporting evidence. `ageDays === null` (no evidence at
 * all, or an evidence source that carries no timestamp) is treated as
 * neutral (1) — there's nothing to decay, so this signal should not itself
 * suppress the score; that's retrievalStrength's job (AC3: "old evidence
 * lowers confidence *relative to* identical but recent support" — decay
 * only matters when there's something to compare against).
 */
export function computeRecencyDecay(ageDays: number | null, halfLifeDays: number): number {
  if (ageDays === null || halfLifeDays <= 0) {
    return 1;
  }
  return clamp01(Math.pow(0.5, ageDays / halfLifeDays));
}

/**
 * Self-report signal: the model's own stated confidence, parsed from free
 * text. Deliberately tolerant of a few common shapes ("82", "82%", "high")
 * and defaults to a neutral 0.5 for anything else — this signal carries
 * the lowest weight precisely because it's known to be poorly calibrated,
 * so a parse failure degrading to neutral (rather than 0 or 1) is the
 * honest choice.
 */
export function computeSelfReport(rawText: string | null): number {
  if (rawText === null) {
    return 0.5;
  }
  const trimmed = rawText.trim().toLowerCase();
  const numberMatch = /(\d+(\.\d+)?)/.exec(trimmed);
  if (numberMatch) {
    const value = Number(numberMatch[1]);
    // A bare "0.8" is already 0..1; "82" or "82%" is 0..100.
    return clamp01(value <= 1 ? value : value / 100);
  }
  if (trimmed.includes("high") || trimmed.includes("very confident")) {
    return 0.85;
  }
  if (trimmed.includes("low") || trimmed.includes("not confident") || trimmed.includes("unsure")) {
    return 0.2;
  }
  if (trimmed.includes("medium") || trimmed.includes("moderate")) {
    return 0.5;
  }
  return 0.5;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
