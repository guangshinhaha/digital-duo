import type { InferenceProvider } from "../provider/types.js";

/**
 * duo#280/#281 (digital-duo#279): catch-up summaries. Both surfaces —
 * the card above the unread line in a busy conversation (#280) and the
 * one-line sidebar gist under a conversation in the list (#281) — read
 * the same shape of input (the unread messages themselves, oldest first,
 * each already resolved by the client from the homeserver it is signed
 * into) because they are the same mechanic at two sizes: a short digest
 * of what was missed. One route, one prompt, one parse — the same
 * "prompt-and-parse" shape `/compose/rewrite`, `/compose/fact-check` and
 * `/compose/explain` already use (no retrieval, no corpus write, nothing
 * persisted: like those three, this reads nothing and writes nothing).
 *
 * This module never sees a room, an event id, or the homeserver at all —
 * by design, the same separation `/compose/explain` keeps from the
 * workspace (digital-duo has no workspace connection of its own). The
 * client sends plain `{ from, text }` pairs in the order they arrived;
 * what comes back indexes into that same array so the client — which
 * alone knows each message's real event id — can turn a bullet into a
 * link without this module ever needing to know what a "room" is.
 */

export interface CatchUpMessageInput {
  /** A short, already-resolved display label for who sent it — never a user id or an `@duo-` handle verbatim; the client resolves that the same way it renders any message. */
  readonly from: string;
  readonly text: string;
}

export interface CatchUpBullet {
  /** The index into the request's `messages` array this bullet is about — the client's own join back to an event id, never resolved here. */
  readonly index: number;
  readonly text: string;
}

export interface CatchUpResult {
  /** Zero or more points worth surfacing — decisions, open questions, and mentions, per #280's own "How" — each traceable to one message. Empty when nothing in the window was worth a bullet (AC: "never posted into the room" pairs with "never invented into one either"). */
  readonly bullets: readonly CatchUpBullet[];
  /** The single-line gist #281 renders under the conversation's title — always non-empty when there is at least one message, even when `bullets` is empty, because the sidebar has room for exactly one line and no bullets to fall back on. */
  readonly oneLine: string;
}

/**
 * Thrown with no configured inference provider — the same posture
 * `RewriteUnavailableError`/`ExplainUnavailableError` take: there is no
 * safe deterministic stand-in for "summarize what these messages said",
 * and a wrong summary is worse than visibly having none. The route this
 * feeds turns it into a 503, never a silent empty card.
 */
export class CatchUpUnavailableError extends Error {
  constructor() {
    super("Catching up needs a configured inference provider.");
    this.name = "CatchUpUnavailableError";
  }
}

/** Hard ceiling on how many unread messages one call summarizes — #280's own threshold starts this at 15+, but an unread count can run far higher than that; past this many, only the most recent are shown to the model, newest-relevant bias over an exhaustive but diluted one. */
export const CATCH_UP_MAX_MESSAGES = 60;

/** Each message's text is truncated to this many characters before it reaches the prompt — one very long paste must not crowd out the other messages in the window. */
const MESSAGE_TRUNCATE = 400;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildCatchUpPrompt(messages: readonly CatchUpMessageInput[]): string {
  const numbered = messages.map((message, index) => `[${index}] ${message.from}: ${truncate(message.text, MESSAGE_TRUNCATE)}`).join("\n");
  return [
    "A member of a group conversation stepped away and is catching up on the messages below, oldest first, each numbered. Summarize only what matters for someone who hasn't read any of it: decisions made, open questions, and anything that looks aimed at the returning member. Say nothing about messages that are routine chatter with nothing to catch up on.",
    "",
    "Messages:",
    numbered,
    "",
    'Reply with ONLY JSON, nothing else, in exactly this shape: {"bullets": [{"index": number, "text": string}], "oneLine": string}.',
    '"bullets" is zero or more short points, each citing the one numbered message index it is about (never an index not shown above, never a message not in the list) — omit it entirely ([]) if nothing here rises above routine chatter. "oneLine" is a single short sentence gisting the whole window for someone glancing at a chat list, never more than about twelve words, and is required even when "bullets" is empty.',
  ].join("\n");
}

interface ParsedCatchUp {
  readonly bullets: readonly { index: number; text: string }[];
  readonly oneLine: string;
}

/** Best-effort JSON extraction, same tolerance as `fact-check.ts`'s `parseVerdict` and `explain.ts`'s `parseExplanation`. */
function parseCatchUp(raw: string): ParsedCatchUp | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<ParsedCatchUp>;
    if (
      typeof parsed.oneLine !== "string" ||
      !Array.isArray(parsed.bullets) ||
      !parsed.bullets.every((bullet) => typeof bullet === "object" && bullet !== null && typeof bullet.index === "number" && typeof bullet.text === "string")
    ) {
      return undefined;
    }
    return { bullets: parsed.bullets, oneLine: parsed.oneLine };
  } catch {
    return undefined;
  }
}

/**
 * Summarizes `messages` (oldest first) for the owner alone. Throws
 * `CatchUpUnavailableError` with no provider, on a provider failure, or
 * on an unparseable/empty response — never a guessed or partial summary.
 * A bullet whose index doesn't name a real message in the input is
 * dropped, the same "never fabricate a source" rule `explain.ts` applies
 * to its own indices.
 */
export async function summarizeCatchUp(
  messages: readonly CatchUpMessageInput[],
  inferenceProvider: InferenceProvider | undefined,
): Promise<CatchUpResult> {
  if (!inferenceProvider) {
    throw new CatchUpUnavailableError();
  }
  if (messages.length === 0) {
    return { bullets: [], oneLine: "" };
  }
  const windowed = messages.length > CATCH_UP_MAX_MESSAGES ? messages.slice(messages.length - CATCH_UP_MAX_MESSAGES) : messages;
  const offset = messages.length - windowed.length;

  let raw: string;
  try {
    raw = await inferenceProvider.complete(buildCatchUpPrompt(windowed));
  } catch {
    throw new CatchUpUnavailableError();
  }

  const parsed = parseCatchUp(raw);
  if (!parsed || parsed.oneLine.trim().length === 0) {
    throw new CatchUpUnavailableError();
  }

  const bullets = parsed.bullets
    .filter((bullet) => windowed[bullet.index] !== undefined && bullet.text.trim().length > 0)
    .map((bullet) => ({ index: bullet.index + offset, text: bullet.text.trim() }));

  return { bullets, oneLine: parsed.oneLine.trim() };
}
