import type { InferenceProvider } from "../provider/types.js";

/**
 * duo#300: one message the caller's own search already turned up — the
 * client's `MessageSearchHit` (`workspace/matrix.ts` on the client), passed
 * through verbatim. This module does no retrieval of its own: it is handed
 * exactly the messages a member's own membership-scoped homeserver search
 * already returned, and answers using only those — never the corpus, never
 * another room, never a message the caller didn't already have (AC3: "answers
 * never use content the member can't access"). Same shape discipline as
 * `rewrite.ts`/`fact-check.ts`: a thin prompt-and-parse module the route calls
 * straight through, not a new pipeline.
 */
export interface SearchAnswerHit {
  readonly id: string;
  readonly text: string;
  readonly from: string;
}

export type SearchAnswerResult =
  | { readonly kind: "answered"; readonly text: string; readonly citedIds: readonly string[] }
  | { readonly kind: "no_answer" };

/** Keeps the prompt — and the bill — bounded; the caller's own search already ranked these, so the first N are its best guess at relevance. */
const MAX_HITS = 12;
const MAX_HIT_CHARS = 500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildPrompt(query: string, hits: readonly SearchAnswerHit[]): string {
  const numbered = hits.map((hit, index) => `[${index}] ${hit.from}: ${truncate(hit.text, MAX_HIT_CHARS)}`).join("\n");
  return [
    "You are answering a question using ONLY the numbered messages below, which the person asking already has permission to read — found by their own search of conversations they're in. Never use any other knowledge, never guess, and never invent a message that isn't listed.",
    "",
    "Messages (indexed):",
    numbered,
    "",
    `Question: ${query}`,
    "",
    'If the messages above answer the question, reply with ONLY JSON in exactly this shape: {"answered": true, "text": string, "citedIndices": number[]}. "text" is a short, direct answer in your own words. "citedIndices" lists every message index you actually drew on — never empty, never a message you didn\'t use.',
    'If the messages do not answer the question, reply with exactly: {"answered": false}.',
  ].join("\n");
}

interface ParsedAnswer {
  readonly answered: boolean;
  readonly text?: string;
  readonly citedIndices?: unknown;
}

/** Best-effort JSON extraction, same discipline as `fact-check.ts`'s `parseVerdict`: a model that wraps its answer in prose despite the instruction still gets read, and any failure here is a missing/malformed answer, never a thrown error. */
function parseAnswer(raw: string): ParsedAnswer | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<ParsedAnswer>;
    if (typeof parsed.answered !== "boolean") {
      return undefined;
    }
    return parsed as ParsedAnswer;
  } catch {
    return undefined;
  }
}

/**
 * Answers `query` from `hits` alone. Returns `no_answer` — never throws —
 * whenever there is nothing safe to show: no provider configured, no hits
 * given, a malformed completion, the model itself saying the messages don't
 * answer the question, or (deliberately the same case) a model that answers
 * but names nothing it drew on — uncited is indistinguishable from guessed,
 * so it is treated as not answered rather than shown without a source.
 */
export async function answerFromSearchHits(
  query: string,
  hits: readonly SearchAnswerHit[],
  inferenceProvider: InferenceProvider | undefined,
): Promise<SearchAnswerResult> {
  if (!inferenceProvider || hits.length === 0) {
    return { kind: "no_answer" };
  }
  const bounded = hits.slice(0, MAX_HITS);
  let raw: string;
  try {
    raw = await inferenceProvider.complete(buildPrompt(query, bounded));
  } catch {
    return { kind: "no_answer" };
  }
  const parsed = parseAnswer(raw);
  if (!parsed || !parsed.answered || typeof parsed.text !== "string" || parsed.text.trim() === "" || !Array.isArray(parsed.citedIndices)) {
    return { kind: "no_answer" };
  }
  const citedIds = [
    ...new Set(
      parsed.citedIndices.filter((index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < bounded.length).map((index) => bounded[index]!.id),
    ),
  ];
  if (citedIds.length === 0) {
    return { kind: "no_answer" };
  }
  return { kind: "answered", text: parsed.text.trim(), citedIds };
}
