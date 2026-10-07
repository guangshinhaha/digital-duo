import { buildInterruptionPortrait } from "./portrait.js";
import { listRules, type Rule, type RuleReviewStatus, type RuleStatus } from "./rules.js";

/**
 * guangshinhaha/duo#277: "what your duo can and can't answer yet". A topic
 * counts as covered when the owner has approved a standing order for it —
 * `reviewStatus === "approved"` is the one signal the product already
 * treats as "the owner signed off on this" (`docs/concept.md` §6's trust
 * ladder, `derivation/rule-review.ts`'s own doc comment: "what makes a rule
 * active"). Everything else — no rule at all, one still `pending` review,
 * one the owner `rejected` or that was `superseded`, or one derivation
 * could only call `weak_signal`/`inconsistent` — is a gap: the duo may
 * still answer from raw retrieval, but nothing backs that answer as policy
 * the owner stood behind.
 *
 * Deliberately composition-only, the same discipline `duo/knowledge-summary.ts`
 * already holds to (`client-tech-design.md` Part 0: "adding a surface must
 * not add a behaviour") — this reuses the portrait's own topic breakdown
 * (qa_pairs + duo/topics.json, #23/#24) and the rules table's own review
 * state. Nothing here re-clusters, re-scores, or re-judges anything; it
 * only joins two things the daemon already computed.
 */
export interface TopicCoverageEntry {
  readonly topicId: string;
  readonly label: string;
  readonly questionCount: number;
  /** 0..1 of `totalQuestions`, same arithmetic as the portrait's own `TopicShare.share`. */
  readonly share: number;
  /** True exactly when an approved rule stands behind this topic. */
  readonly covered: boolean;
  /** Derivation's own confidence tier for this topic's rule — `"none"` when no rule has ever been induced or asserted for it. */
  readonly ruleStatus: RuleStatus | "none";
  /** The owner's own review decision on that rule — `"none"` alongside `ruleStatus: "none"`. */
  readonly reviewStatus: RuleReviewStatus | "none";
}

export interface TopicCoverageReport {
  readonly totalQuestions: number;
  /** Same threshold and verdict as the portrait (#277 AC1: computed from the owner's own question history, never a separate judgement). */
  readonly tooThin: boolean;
  readonly minimumQuestionsToCharacterize: number;
  /** Share of `totalQuestions` whose topic is covered — the one number a Portrait-style sentence can round into words ("most", "under half"), never rendered as a percentage (`client-design.md` §1.6). */
  readonly coveredShare: number;
  /** Every topic with at least one question, most-asked first — never truncated, same AC3 precedent as the portrait's own breakdown. */
  readonly topics: readonly TopicCoverageEntry[];
  /** The uncovered subset of `topics`, in the same most-asked-first order — what the owner has to teach, ranked by how often it actually comes up. */
  readonly gaps: readonly TopicCoverageEntry[];
}

function shareOf(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/**
 * Builds the coverage report straight from the portrait and the rules
 * table — read-only, two calls, one join. `storePath`/`passphrase`/`duoDir`
 * are the same triple every other derivation read already takes.
 */
export function buildTopicCoverage(storePath: string, passphrase: string, duoDir: string): TopicCoverageReport {
  const portrait = buildInterruptionPortrait(storePath, passphrase, duoDir);
  const rules = listRules(storePath, passphrase);
  const ruleByTopic = new Map<string, Rule>(rules.map((rule) => [rule.topicId, rule]));

  const topics: TopicCoverageEntry[] = portrait.topicBreakdown.map((topic) => {
    const rule = ruleByTopic.get(topic.topicId);
    const covered = rule?.reviewStatus === "approved";
    return {
      topicId: topic.topicId,
      label: topic.label,
      questionCount: topic.count,
      share: topic.share,
      covered,
      ruleStatus: rule?.status ?? "none",
      reviewStatus: rule?.reviewStatus ?? "none",
    };
  });

  const coveredShare = shareOf(
    topics.filter((topic) => topic.covered).reduce((sum, topic) => sum + topic.questionCount, 0),
    portrait.totalQuestions,
  );

  // `topics` is already most-asked-first (the portrait sorts it); filtering preserves that order.
  const gaps = topics.filter((topic) => !topic.covered);

  return {
    totalQuestions: portrait.totalQuestions,
    tooThin: portrait.tooThin,
    minimumQuestionsToCharacterize: portrait.minimumQuestionsToCharacterize,
    coveredShare,
    topics,
    gaps,
  };
}
