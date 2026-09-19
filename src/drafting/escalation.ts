import type { ConfidenceResult } from "./confidence.js";
import type { DraftContext } from "./context.js";

/**
 * Composes a plain-English explanation of why a question is being
 * escalated rather than drafted — #32 AC2 ("explains what it lacked"),
 * sharpened by #34 AC1 into naming which specific signal was weak and what
 * evidence would have helped, rather than a single opaque "confidence too
 * low." Each signal check below is independent, so more than one can (and
 * often will) apply to the same escalation.
 */
export function explainEscalation(confidence: ConfidenceResult, context: DraftContext): string {
  const weak: string[] = [];

  if (confidence.signals.ruleHit === 0) {
    weak.push("no standing order directly covers this — answering it yourself and recording the answer would create one");
  }

  if (confidence.signals.retrievalStrength < 0.5) {
    weak.push(
      context.evidence.length === 0
        ? "no similar past exchange was found in the corpus"
        : `only ${context.evidence.length} similar past exchange(s) found, and the similarity was weak`,
    );
  }

  if (confidence.signals.recency < 0.5 && context.freshestEvidenceAgeDays !== null) {
    weak.push(`the closest supporting evidence is ${Math.round(context.freshestEvidenceAgeDays)} day(s) old, which pulled its weight down`);
  }

  if (confidence.signals.selfConsistency < 0.5) {
    weak.push("repeated drafts of this answer didn't agree with each other, which usually means the corpus doesn't give one clear answer");
  }

  const reasonList = weak.length > 0 ? weak.join("; ") : "overall confidence is too low even though no single signal stands out";
  return `I'd escalate this one rather than guess (confidence ${confidence.score.toFixed(2)}, below the ${confidence.threshold} threshold): ${reasonList}.`;
}

/** The immediate-escalation case: there was nothing to draft from at all — no rule, no evidence, no provider fallback. Never even scored against the threshold, since every signal that could carry weight is necessarily zero. */
export function noEvidenceEscalationReason(): string {
  return "I'd escalate this one: no standing order or past exchange in the corpus covers this question at all.";
}
