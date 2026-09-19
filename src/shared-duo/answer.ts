import type { Duo } from "../duo/entity.js";
import { withAttribution } from "./attribution.js";
import { isDecisionRequest } from "./decision-guard.js";
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

/**
 * What a shared duo answers to a question asking it to decide, approve,
 * or take a position (#70 AC2) — refuses outright, states plainly that
 * it can't decide anything, and routes to the owner, rather than
 * treating the question as a lookup and answering from whatever
 * (possibly on-topic) document happens to match.
 */
function decisionDeclineAnswer(ownerName: string): string {
  return `I can't decide or approve anything on the team's behalf. That's ${ownerName}'s call — I'm passing your question to them.`;
}

/** One document the answer draws from, with whether it's old enough to flag (#69 AC3). */
export interface SharedDuoCitation extends PublishedDocument {
  readonly stale: boolean;
}

function formatCitation(citation: SharedDuoCitation): string {
  const staleNote = citation.stale ? " — this source may be out of date" : "";
  return `${citation.text}\n(source: ${citation.title}, updated ${citation.updatedAt}${staleNote})`;
}

/** Why a declined answer was declined — #71's usage report distinguishes "nothing covers this" from "this isn't something I decide", and #70 AC2 needs its own case tested independently of #68/#69's out-of-scope one. */
export type SharedDuoDeclineReason = "out_of_scope" | "not_a_decision_maker";

export interface SharedDuoAnswer {
  /** The text given back to whoever asked, always ending in the fixed attribution line (#70 AC1, AC3) — there is no way to construct a SharedDuoAnswer whose text lacks it. */
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
  /** Set only when `declined` is true. */
  readonly declineReason?: SharedDuoDeclineReason;
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
 * A decision request (isDecisionRequest) is checked *before* retrieval
 * and always declines, regardless of whether a configured document
 * happens to be on the same topic (#70 AC2) — "sign off on the expense
 * claim" must never be answered from the expense-claims document as if
 * the duo could actually sign off on anything.
 *
 * Every return path is wrapped in withAttribution before being handed
 * back — there is no parameter on this function, and nothing read from
 * the persona file, that could produce an unattributed answer (#70 AC3).
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
  const owner = duo.requireHumanOwner("shared duo escalation");
  let result: SharedDuoAnswer;

  if (isDecisionRequest(question)) {
    result = { text: decisionDeclineAnswer(owner.name), citations: [], declined: true, declineReason: "not_a_decision_maker" };
  } else {
    const matches = await duo.knowledge.retrieve(question);
    if (matches.length === 0) {
      result = { text: outOfScopeAnswer(owner.name), citations: [], declined: true, declineReason: "out_of_scope" };
    } else {
      const citations: SharedDuoCitation[] = matches.map((match) => {
        const document = parsePublishedDocument(match.text);
        return { ...document, stale: isStale(document.updatedAt, asOf) };
      });
      result = { text: citations.map(formatCitation).join("\n\n"), citations, declined: false };
    }
  }

  result = { ...result, text: withAttribution(result.text, owner.name) };

  appendUsageEntry(usageLogPath, {
    question,
    declined: result.declined,
    citedTitles: result.citations.map((citation) => citation.title),
    staleCitation: result.citations.some((citation) => citation.stale),
  });
  return result;
}
