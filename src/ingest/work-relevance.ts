/**
 * A deterministic v1 stand-in for the "is this work-relevant?" judgement
 * AR-11 (v1-tech-design.md) calls for before personal chat history ever
 * reaches derivation: exportable AI chat history is often personal use,
 * and that dilutes derivation if it isn't filtered out first. Real
 * classification will eventually route through the inference provider
 * (v1-tech-design.md §1.5's LLM-described passes); until that's built,
 * a small keyword heuristic keeps ingest fully offline, deterministic,
 * and testable without Ollama running.
 *
 * Biased toward keeping content: a tie, or no signal either way, counts
 * as work-relevant. A missed personal conversation costs a little noise
 * in later derivation; a wrongly-dropped work conversation costs the
 * content outright, with no way to recover it later. Asymmetric costs,
 * so the default should favor the cheaper mistake — same reasoning as the
 * relevance gate's silence bias (v1-tech-design.md §1.6), just aimed the
 * other way because the two costs here are the other way around.
 */
const WORK_SIGNALS = [
  "meeting",
  "deadline",
  "policy",
  "ticket",
  "client",
  "budget",
  "spec",
  "report",
  "release",
  "incident",
  "on-call",
  "runbook",
  "sprint",
  "stakeholder",
  "roadmap",
  "invoice",
  "compliance",
  "audit",
  "colleague",
  "manager",
  "project",
  "deploy",
  "outage",
  "escalate",
  "approval",
  "postmortem",
] as const;

const PERSONAL_SIGNALS = [
  "recipe",
  "birthday",
  "vacation",
  "girlfriend",
  "boyfriend",
  "workout",
  "diet",
  "movie night",
  "in-laws",
  "wedding",
  "honeymoon",
  "dating",
  "gym session",
  "netflix",
  "hangover",
] as const;

function countMatches(text: string, signals: readonly string[]): number {
  const lower = text.toLowerCase();
  return signals.reduce((count, signal) => (lower.includes(signal) ? count + 1 : count), 0);
}

/** True unless personal-life signal words in `text` outnumber work signal words. */
export function isWorkRelevant(text: string): boolean {
  return countMatches(text, WORK_SIGNALS) >= countMatches(text, PERSONAL_SIGNALS);
}
