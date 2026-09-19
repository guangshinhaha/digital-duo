import type { Duo } from "../duo/entity.js";
import { isStale, parsePublishedDocument, type PublishedDocument } from "./documents.js";
import { appendUsageEntry } from "./usage-log.js";

/**
 * What a shared duo answers when nothing it was configured with covers
 * the question, naming the owner it escalates to rather than guessing or
 * generalising from adjacent material (#68 AC2). Kept as one fixed
 * template — same "the exact wording is part of the contract" shape
 * #50's DECLINE_MESSAGE uses — with the owner's name interpolated, since
 * unlike the personal-duo decline (#50), naming *who* to ask next is the
 * point here, not something that would leak anything by being specific.
 */
function outOfScopeAnswer(ownerName: string): string {
  return `That isn't covered by the material I was configured with. Ask ${ownerName} directly.`;
}

/** One document the answer draws from, with whether it's old enough to flag (#69 AC3). */
export interface SharedDuoCitation extends PublishedDocument {
  readonly stale: boolean;
}

function formatCitation(citation: SharedDuoCitation): string {
  const staleNote = citation.stale ? " — this source may be out of date" : "";
  return `${citation.text}\n(source: ${citation.title}, updated ${citation.updatedAt}${staleNote})`;
}

export interface SharedDuoAnswer {
  /** The text given back to whoever asked. Exactly outOfScopeAnswer(...) when `declined`. */
  readonly text: string;
  /**
   * Every source the answer draws from — #68 AC1's "every claim traces to
   * one of those sources, cited" plus #69 AC1's "links to the source
   * material and its date". Each citation's `text` is copied unmodified
   * from a document the persona file was configured with, never
   * paraphrased or synthesised, and there is no inference step anywhere in
   * this module that could generalise beyond what a document actually
   * says (#68's own out-of-scope item: "inferring policy positions the
   * sources do not state"). Empty exactly when `declined`.
   */
  readonly citations: readonly SharedDuoCitation[];
  readonly declined: boolean;
}

/**
 * Answers a question from a shared duo's own configured knowledge only.
 * `duo.knowledge` is guaranteed authored-only for any `Duo` that came
 * through `createSharedDuo`/`loadSharedDuo` (assertAuthoredKnowledgeOnly),
 * so this never has a code path into a personal store — there is no
 * `storePath`, no `withDatabase`, nothing from `src/store/` imported
 * anywhere in this module (#68 AC3). Deliberately extractive rather than
 * generated: it quotes the matching documents themselves rather than
 * asking an inference provider to phrase an answer, which is what keeps
 * it from ever inferring a position a source doesn't actually state.
 *
 * Writes exactly one usage-log entry per call, answered or declined
 * (#69 AC2's "passes the question on", AC4's repeated-question gaps) —
 * done here, not by the CLI, so a call from anywhere always logs, the
 * same "the answering function itself owns the log write" shape #50's
 * answerForAsker uses for the personal duo's audit log.
 */
export async function answerSharedDuo(
  duo: Duo,
  question: string,
  usageLogPath: string,
  asOf: Date = new Date(),
): Promise<SharedDuoAnswer> {
  const matches = await duo.knowledge.retrieve(question);
  let result: SharedDuoAnswer;

  if (matches.length === 0) {
    const owner = duo.requireHumanOwner("shared duo escalation");
    result = { text: outOfScopeAnswer(owner.name), citations: [], declined: true };
  } else {
    const citations: SharedDuoCitation[] = matches.map((match) => {
      const document = parsePublishedDocument(match.text);
      return { ...document, stale: isStale(document.updatedAt, asOf) };
    });
    result = { text: citations.map(formatCitation).join("\n\n"), citations, declined: false };
  }

  appendUsageEntry(usageLogPath, {
    question,
    declined: result.declined,
    citedTitles: result.citations.map((citation) => citation.title),
    staleCitation: result.citations.some((citation) => citation.stale),
  });
  return result;
}
