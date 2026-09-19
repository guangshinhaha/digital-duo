import type { Duo } from "../duo/entity.js";
import type { KnowledgeItem } from "../duo/types.js";

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

export interface SharedDuoAnswer {
  /** The text given back to whoever asked. Exactly outOfScopeAnswer(...) when `declined`. */
  readonly text: string;
  /**
   * Every source the answer draws from, verbatim — #68 AC1's "every claim
   * traces to one of those sources, cited". Each item's `text` is copied
   * unmodified from a document the persona file was configured with, never
   * paraphrased or synthesised, and there is no inference step anywhere in
   * this module that could generalise beyond what a document actually
   * says (the out-of-scope item in #68: "inferring policy positions the
   * sources do not state"). Empty exactly when `declined`.
   */
  readonly citations: readonly KnowledgeItem[];
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
 */
export async function answerSharedDuo(duo: Duo, question: string): Promise<SharedDuoAnswer> {
  const citations = await duo.knowledge.retrieve(question);
  if (citations.length === 0) {
    const owner = duo.requireHumanOwner("shared duo escalation");
    return { text: outOfScopeAnswer(owner.name), citations: [], declined: true };
  }
  return {
    text: citations.map((citation) => citation.text).join("\n\n"),
    citations,
    declined: false,
  };
}
