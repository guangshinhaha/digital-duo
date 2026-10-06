import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { gatherDraftContext, type DraftContext } from "./context.js";
import type { DraftSource } from "./draft-log.js";

/**
 * Below this retrieved-evidence similarity, a candidate fact is too
 * tenuously related to the owner's text to even put in front of the
 * model — keeps its attention on genuinely topical facts and keeps the
 * call worth making. A standing-order hit (`context.ruleHit`) carries no
 * similarity score of its own and is always eligible: it's a confirmed,
 * owner-approved fact, not a retrieval guess.
 */
const RETRIEVAL_FLOOR = 0.55;

/**
 * #264: how sure the model itself must say it is — out of 100 — that a
 * claim in the owner's text contradicts a specific known fact, before
 * this ever surfaces as a flag. This is deliberately far higher than
 * drafting's own escalation threshold (confidence.ts's composite score):
 * drafting has several independent signals (retrieval strength, self-
 * consistency, recency, an explicit rule hit) to combine, where self-
 * reported confidence is intentionally the lowest-weighted because it's
 * known to be poorly calibrated. Contradiction-detection has no such
 * second signal — cosine similarity tells "about the same thing", never
 * "agrees or disagrees" — so the model's own stated confidence is the
 * ONLY signal available, which is exactly why the bar here sits far
 * above where a single such signal would otherwise sit. This is a v1
 * single-call heuristic, not a calibrated classifier: a wrong flag is
 * worse than a missed one (the issue's own framing), so a future pass
 * should lean toward raising this further — e.g. requiring two
 * independent calls to agree — rather than lowering it for recall.
 */
const FACT_CHECK_CONFIDENCE_THRESHOLD = 90;

export interface FactCheckFlag {
  readonly claim: string;
  readonly concern: string;
  readonly source: DraftSource;
}

export interface FactCheckResult {
  readonly flag: FactCheckFlag | null;
}

interface Candidate {
  readonly source: DraftSource;
  readonly fact: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Same source-label conventions as `pipeline.ts`'s `buildSources` (truncate-to-80, marking stripped first) — one owner reading both a draft's sources and a fact-check's source should see the same shape of label. */
function candidatesOf(context: DraftContext): Candidate[] {
  const candidates: Candidate[] = [];
  if (context.ruleHit) {
    const strippedRule = stripMarkingLine({ text: context.ruleHit.text, classification: detectClassification(context.ruleHit.text) });
    candidates.push({
      source: { kind: "rule", id: context.ruleHit.id, label: `standing order: ${truncate(strippedRule, 80)}` },
      fact: strippedRule,
    });
  }
  for (const item of context.evidence) {
    if (item.similarity < RETRIEVAL_FLOOR) {
      continue;
    }
    const strippedEvidence = stripMarkingLine(item);
    candidates.push({
      source: { kind: "evidence", id: item.recordId, label: `past exchange (similarity ${item.similarity.toFixed(2)}): ${truncate(strippedEvidence, 80)}` },
      fact: strippedEvidence,
    });
  }
  return candidates;
}

function buildFactCheckPrompt(text: string, threadContext: string | null, candidates: readonly Candidate[]): string {
  const facts = candidates.map((candidate, index) => `[${index}] ${candidate.fact}`).join("\n");
  return [
    "You are checking a message someone is about to send, against facts you already know, for exactly ONE specific, concrete contradiction — a wrong date, number, name, or commitment. A different topic, a vague overlap, or something merely unconfirmed is NOT a contradiction, and must not be reported as one.",
    "",
    "Known facts (indexed):",
    facts,
    ...(threadContext ? ["", "Conversation so far:", threadContext] : []),
    "",
    "The message they are about to send:",
    text,
    "",
    'Reply with ONLY JSON, nothing else, in exactly this shape: {"contradiction": boolean, "factIndex": number, "claim": string, "concern": string, "confidence": number}.',
    '"claim" must be copied VERBATIM, character for character, from the message above — never paraphrased or summarized. "factIndex" must be one of the indices shown above. "concern" is one short sentence explaining the contradiction. "confidence" is 0-100: how sure you are this is a real, specific contradiction, not a guess.',
    'If there is no clear contradiction, reply exactly: {"contradiction": false, "factIndex": -1, "claim": "", "concern": "", "confidence": 0}.',
  ].join("\n");
}

interface ParsedVerdict {
  readonly contradiction: boolean;
  readonly factIndex: number;
  readonly claim: string;
  readonly concern: string;
  readonly confidence: number;
}

/** Best-effort JSON extraction: a model that wraps its answer in prose or a code fence despite the instruction still gets read, by taking the first brace-delimited span rather than demanding the whole response be bare JSON. Any failure here is a missing/malformed verdict, never a thrown error. */
function parseVerdict(raw: string): ParsedVerdict | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<ParsedVerdict>;
    if (
      typeof parsed.contradiction !== "boolean" ||
      typeof parsed.factIndex !== "number" ||
      typeof parsed.claim !== "string" ||
      typeof parsed.concern !== "string" ||
      typeof parsed.confidence !== "number"
    ) {
      return undefined;
    }
    return parsed as ParsedVerdict;
  } catch {
    return undefined;
  }
}

/**
 * Finds `claim` inside `text` case-insensitively and returns the exact
 * substring as it actually appears in `text` — never the model's own
 * casing or whitespace, and never anything the owner didn't literally
 * type. `undefined` when the claim isn't actually there, which
 * `checkOwnerText` treats as a sign the whole verdict may be fabricated
 * and discards entirely — source included, never partially trusted.
 */
function verbatimSpan(text: string, claim: string): string | undefined {
  const trimmedClaim = claim.trim();
  if (trimmedClaim.length === 0) {
    return undefined;
  }
  const index = text.toLowerCase().indexOf(trimmedClaim.toLowerCase());
  if (index === -1) {
    return undefined;
  }
  return text.slice(index, index + trimmedClaim.length);
}

/**
 * #264: at most one high-confidence flag for a claim in the owner's own
 * typed text that contradicts something the corpus already knows.
 * Reuses `gatherDraftContext` (context.ts) verbatim — the exact retrieval
 * `draftReply` already runs — so this shares the owner's standing orders
 * and past evidence rather than a second retrieval path of its own.
 *
 * Conservative by construction, end to end (see `FACT_CHECK_CONFIDENCE_THRESHOLD`'s
 * own comment for why the bar is where it is):
 *
 * - No configured inference provider → never flags, unconditionally.
 *   Cosine similarity alone cannot tell "this is about the same thing"
 *   from "this contradicts it" — two dates about the same meeting sit
 *   close in embedding space whether they agree or not — so contradiction
 *   detection needs a model, and there is no safe deterministic fallback
 *   the way drafting's `extractiveDraft` has one for generation.
 * - Only facts retrieved at or above `RETRIEVAL_FLOOR`, or an explicit
 *   confirmed+approved standing order, are even shown to the model.
 * - The model must self-report `FACT_CHECK_CONFIDENCE_THRESHOLD` or higher.
 * - The model's quoted "claim" must appear verbatim in the owner's own
 *   text — anything else is treated as a possible fabrication and the
 *   ENTIRE verdict is discarded, not softened into a vaguer flag.
 * - The source is always one of the retrieved candidates, selected by
 *   index — never free text the model could invent a source from.
 * - A missing provider response, a malformed verdict, or an empty concern
 *   is silently no flag, never a thrown error the composer would have to
 *   handle specially.
 */
export async function checkOwnerText(
  storePath: string,
  passphrase: string,
  duoDir: string,
  text: string,
  threadContext: string | null,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
): Promise<FactCheckResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !inferenceProvider) {
    return { flag: null };
  }

  const context = await gatherDraftContext(storePath, passphrase, duoDir, trimmed, embeddingProvider, 5);
  const candidates = candidatesOf(context);
  if (candidates.length === 0) {
    return { flag: null };
  }

  let raw: string;
  try {
    raw = await inferenceProvider.complete(buildFactCheckPrompt(trimmed, threadContext, candidates));
  } catch {
    return { flag: null };
  }

  const verdict = parseVerdict(raw);
  if (!verdict || !verdict.contradiction || verdict.confidence < FACT_CHECK_CONFIDENCE_THRESHOLD) {
    return { flag: null };
  }
  const candidate = candidates[verdict.factIndex];
  if (!candidate) {
    return { flag: null };
  }
  const span = verbatimSpan(trimmed, verdict.claim);
  if (span === undefined || verdict.concern.trim().length === 0) {
    return { flag: null };
  }

  return { flag: { claim: span, concern: verdict.concern.trim(), source: candidate.source } };
}
