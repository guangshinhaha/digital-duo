/**
 * A deterministic keyword heuristic — the same "documented v1 stand-in for
 * real classification" idiom src/ingest/work-relevance.ts uses — that
 * detects a question asking the shared duo to decide, approve, or take a
 * position on the team's behalf, rather than to look something up. #70
 * AC2 is unconditional: "given a question asking it to decide or approve
 * something ... it declines" regardless of whether the configured
 * material happens to cover the topic — so answerSharedDuo checks this
 * before retrieval, not after, and a decision request never reaches
 * duo.knowledge.retrieve() at all.
 */
const DECISION_PATTERN =
  /\b(decide|decision|approve|approval|authoriz\w*|sign[\s-]?off|green[\s-]?light|go[\s-]?ahead|rubber[\s-]?stamp|overrule)\b/i;

export function isDecisionRequest(question: string): boolean {
  return DECISION_PATTERN.test(question);
}
