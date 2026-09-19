import type { DraftSource } from "../drafting/draft-log.js";

/**
 * What every public answer carries (#44 AC1): named as the owner's duo,
 * explicitly *not* the owner speaking directly (`docs/concept.md` §11 —
 * "the duo never poses as the human"). `detail` is present only for an
 * actual answer — confidence and evidence age describe *an answer*, and
 * saying either of them about a passed-on or refused message (where
 * nothing was actually drawn on) would be meaningless, not honest. Mirrors
 * `src/shared-duo/attribution.ts`'s `attributionLine`/`withAttribution`
 * pair exactly, for the personal duo's public-answering surface instead of
 * the shared duo's.
 */
export interface PublicAttributionDetail {
  /** 0..1, as produced by src/drafting/confidence.ts's scoreConfidence. */
  readonly confidence: number;
  /** Age, in days, of the freshest evidence the answer drew on — null when there was none with a usable timestamp. */
  readonly evidenceAgeDays: number | null;
}

function formatEvidenceAge(evidenceAgeDays: number | null): string {
  if (evidenceAgeDays === null) {
    return "no dated evidence behind it";
  }
  const days = Math.round(evidenceAgeDays);
  return days === 0 ? "evidence from today" : `evidence up to ${days} day(s) old`;
}

export function publicAttributionLine(ownerName: string, detail?: PublicAttributionDetail): string {
  const identity = `— ${ownerName}'s duo speaking here, not ${ownerName} directly.`;
  if (!detail) {
    return identity;
  }
  return `${identity} Confidence: ${detail.confidence.toFixed(2)}. Based on ${formatEvidenceAge(detail.evidenceAgeDays)}.`;
}

/**
 * A source-attribution block distinguishing what's the owner's own stated
 * position (a standing order — `kind: "rule"`) from what was merely
 * retrieved (a past exchange, `kind: "evidence"`, which may quote someone
 * else's own words entirely — v1's retention boundary keeps a colleague's
 * *question* text, not only the owner's answer) — #44 AC3's "the reader
 * can tell what is the owner's position and what is merely retrieved."
 * Returns "" for no sources, so a caller can join it in without producing
 * a stray blank section.
 */
export function renderSourceAttribution(sources: readonly DraftSource[]): string {
  if (sources.length === 0) {
    return "";
  }
  const lines = sources.map(
    (source) => `  - [${source.kind === "rule" ? "the owner's own standing order" : "a retrieved past exchange, not the owner speaking now"}] ${source.label}`,
  );
  return `Sources:\n${lines.join("\n")}`;
}

/**
 * Appends source attribution (when any) and the identity/confidence line
 * to `text`, on their own paragraphs — the one place this composition
 * happens, so every return path in answerPublicly goes through it rather
 * than each remembering to attach it itself (#44 AC2: no parameter
 * anywhere in this module, or in answerPublicly, can produce an
 * unattributed result).
 */
export function withPublicAttribution(
  text: string,
  ownerName: string,
  sources: readonly DraftSource[] = [],
  detail?: PublicAttributionDetail,
): string {
  const sourceBlock = renderSourceAttribution(sources);
  const parts = [text, sourceBlock, publicAttributionLine(ownerName, detail)].filter((part) => part.length > 0);
  return parts.join("\n\n");
}
