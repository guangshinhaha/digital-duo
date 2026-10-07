import type { InferenceProvider } from "../provider/types.js";

/**
 * duo#305: "suggested questions and follow-ups" — up to three follow-up
 * questions after a self-chat answer. Unlike `explain.ts`/`rewrite.ts`,
 * this is ambient and optional (AC3: "chips can be turned off"), never a
 * request the owner explicitly made, so there is no visible "unavailable"
 * state to show: with no configured inference provider, or a response
 * that can't be read as the expected JSON, this quietly returns none
 * rather than throwing — the chips row simply doesn't render, the same
 * way a draft with no sources renders no sources line.
 */
export interface FollowUpSuggestions {
  readonly followUps: readonly string[];
}

const MAX_FOLLOW_UPS = 3;

function buildFollowUpPrompt(question: string, answer: string): string {
  return [
    "An owner just asked their own duo (a private assistant that answers from their own notes) a question, privately, and got the answer below. Suggest short, natural follow-up questions they might want to ask next — the way a good chat app offers follow-up chips.",
    "",
    "Their question:",
    question,
    "",
    "The duo's answer:",
    answer,
    "",
    `Reply with ONLY JSON, nothing else, in exactly this shape: {"followUps": string[]}. Up to ${MAX_FOLLOW_UPS} short questions (a handful of words each, phrased as something the owner would type), fewer or an empty array when nothing genuinely follows from this answer. Never repeat the question just asked.`,
  ].join("\n");
}

interface ParsedFollowUps {
  readonly followUps: readonly string[];
}

/** Same tolerant extraction as `explain.ts`'s `parseExplanation` — a wrapped or fenced JSON blob still reads; anything else is a missing response, never a thrown error. */
function parseFollowUps(raw: string): ParsedFollowUps | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<ParsedFollowUps>;
    if (!Array.isArray(parsed.followUps) || !parsed.followUps.every((item) => typeof item === "string")) {
      return undefined;
    }
    return { followUps: parsed.followUps };
  } catch {
    return undefined;
  }
}

/**
 * Suggests up to three follow-up questions for one self-chat turn
 * (`question`/`answer`, both the owner's own and the duo's own words —
 * never grounded against the corpus again, this only reads the one
 * exchange already on screen). No configured provider, a provider that
 * throws, or a response that doesn't parse all resolve to
 * `{ followUps: [] }` — never an error the caller has to special-case.
 */
export async function suggestFollowUps(question: string, answer: string, inferenceProvider: InferenceProvider | undefined): Promise<FollowUpSuggestions> {
  if (!inferenceProvider || answer.trim().length === 0) {
    return { followUps: [] };
  }
  let raw: string;
  try {
    raw = await inferenceProvider.complete(buildFollowUpPrompt(question, answer));
  } catch {
    return { followUps: [] };
  }
  const parsed = parseFollowUps(raw);
  if (!parsed) {
    return { followUps: [] };
  }
  const cleaned = parsed.followUps.map((item) => item.trim()).filter((item) => item.length > 0);
  return { followUps: [...new Set(cleaned)].slice(0, MAX_FOLLOW_UPS) };
}
