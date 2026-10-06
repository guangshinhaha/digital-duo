import type { InferenceProvider } from "../provider/types.js";

/**
 * #263: polishes the OWNER'S OWN typed text — never a duo-generated draft
 * (which already has its own regeneration path through `draftReply`). The
 * composer offers exactly these four, matching the issue's acceptance
 * criteria and Teams Copilot/WhatsApp's own menu shape.
 */
export const REWRITE_INSTRUCTIONS = ["rewrite", "shorter", "warmer", "proofread"] as const;
export type RewriteInstruction = (typeof REWRITE_INSTRUCTIONS)[number];

const INSTRUCTION_PROMPTS: Record<RewriteInstruction, string> = {
  rewrite: "Rewrite it so it reads better — same meaning, roughly the same length.",
  shorter: "Make it noticeably shorter. Keep only what matters; cut everything else.",
  warmer: "Make the tone warmer and friendlier, without changing what it actually says.",
  proofread: "Fix grammar, spelling and punctuation only. Change nothing else — keep the wording as close to the original as the fix allows.",
};

export interface RewriteResult {
  readonly text: string;
}

/**
 * Thrown when there is no safe way to rewrite — see `rewriteOwnerText`'s
 * doc comment for why this has no deterministic fallback the way
 * `extractiveDraft` does for drafting. The route this feeds turns it into
 * a 503 ("can't right now"), never a silent echo of the input, which a
 * caller could easily mistake for an actual rewrite.
 */
export class RewriteUnavailableError extends Error {
  constructor() {
    super("Rewriting needs a configured inference provider.");
    this.name = "RewriteUnavailableError";
  }
}

function buildRewritePrompt(text: string, instruction: RewriteInstruction, voiceText: string): string {
  return [
    "You are polishing a short message this person wrote themselves, in their own voice, for them to review before sending. Never invent facts or add a claim the original text doesn't already make.",
    "",
    "Voice profile:",
    voiceText,
    "",
    `Task: ${INSTRUCTION_PROMPTS[instruction]}`,
    "",
    "Their text:",
    text,
    "",
    "Reply with only the rewritten text — no preamble, no surrounding quotes, no explanation.",
  ].join("\n");
}

/**
 * Rewrites `text` in the owner's own voice (`context.ts`'s `readVoiceText`
 * — the same profile `draftReply` conditions generation on), per
 * `instruction`. Deliberately has no no-provider fallback: unlike
 * `extractiveDraft`'s "copy the closest rule or evidence verbatim" for
 * drafting, there is no safe deterministic stand-in for "rewrite this
 * person's own words" — copying the input back unchanged would silently
 * fail the owner's request rather than visibly declining it, so this
 * throws instead.
 */
export async function rewriteOwnerText(
  text: string,
  instruction: RewriteInstruction,
  voiceText: string,
  inferenceProvider: InferenceProvider | undefined,
): Promise<RewriteResult> {
  if (!inferenceProvider) {
    throw new RewriteUnavailableError();
  }
  const rewritten = await inferenceProvider.complete(buildRewritePrompt(text, instruction, voiceText));
  return { text: rewritten.trim() };
}
