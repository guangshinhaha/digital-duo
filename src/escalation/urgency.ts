/**
 * v1-tech-design.md-style v1 stand-in (same idiom as
 * src/ingest/work-relevance.ts, src/drafting/relevance-gate.ts,
 * src/shared-duo/decision-guard.ts): a deterministic keyword heuristic,
 * documented as one rather than an LLM dependency this codebase can
 * already do without.
 *
 * #46's own open question flags the real risk directly: "asker-declared
 * urgency will be over-claimed." Resolved conservatively — this
 * deliberately does *not* trust anyone simply saying "urgent"/"asap"/
 * "emergency"/"now" about their own question, since that framing is
 * exactly what gets over-claimed by an asker who wants to jump the queue.
 * It looks instead for *objective* severity signals — something actually
 * broken, compromised, or inaccessible — true independent of how
 * insistently it's phrased, which is what keeps urgent genuinely rare
 * (#46 AC3: "and are rare") rather than "everything anyone calls urgent."
 */
export type UrgencyLevel = "urgent" | "normal";

const URGENT_SIGNALS = [
  "production is down",
  "prod is down",
  "production down",
  "system is down",
  "systems are down",
  "site is down",
  "service is down",
  "outage",
  "security breach",
  "security incident",
  "data breach",
  "compromised",
  "leaked credentials",
  "credentials leaked",
  "customers can't access",
  "customers cannot access",
  "everyone is locked out",
  "cannot access anything",
  "data loss",
  "losing data",
] as const;

/**
 * Classifies free text (a question, optionally with its thread context) as
 * urgent or normal. Pure, no I/O, so it can run over any escalated draft's
 * stored text without touching the store itself.
 */
export function classifyUrgency(text: string): UrgencyLevel {
  const lower = text.toLowerCase();
  return URGENT_SIGNALS.some((signal) => lower.includes(signal)) ? "urgent" : "normal";
}
