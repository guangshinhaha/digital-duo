import { describe, expect, it } from "vitest";
import { explainEscalation, noEvidenceEscalationReason, refusedSubjectEscalationReason } from "../src/drafting/escalation.js";
import { scoreConfidence, type ConfidenceWeights } from "../src/drafting/confidence.js";
import type { DraftContext } from "../src/drafting/context.js";

const WEIGHTS: ConfidenceWeights = { selfConsistency: 0.3, retrievalStrength: 0.3, ruleHit: 0.25, recency: 0.1, selfReport: 0.05 };

function context(overrides: Partial<DraftContext> = {}): DraftContext {
  return { evidence: [], ruleHit: undefined, freshestEvidenceAgeDays: null, voiceText: "", usedEmbeddings: true, ...overrides };
}

describe("explainEscalation — names which signal was weak and what would help (#34 AC1)", () => {
  it("names no-rule and thin-retrieval when both are weak", () => {
    const confidence = scoreConfidence(
      { selfConsistency: 0.4, retrievalStrength: 0.1, ruleHit: 0, recency: 1, selfReport: 0.5 },
      WEIGHTS,
      0.55,
    );
    const reason = explainEscalation(confidence, context({ evidence: [{ recordId: "r1", text: "x", timestamp: "t", similarity: 0.1, classification: "unknown" }] }));
    expect(reason).toContain("no standing order");
    expect(reason).toMatch(/weak/i);
    expect(reason.toLowerCase()).toContain("would");
  });

  it("names stale evidence when recency is the weak signal", () => {
    const confidence = scoreConfidence(
      { selfConsistency: 0.8, retrievalStrength: 0.8, ruleHit: 1, recency: 0.1, selfReport: 0.5 },
      WEIGHTS,
      0.55,
    );
    const reason = explainEscalation(confidence, context({ freshestEvidenceAgeDays: 400 }));
    expect(reason).toContain("400 day");
  });

  it("always states that it would escalate, plainly", () => {
    const confidence = scoreConfidence({ selfConsistency: 0, retrievalStrength: 0, ruleHit: 0, recency: 1, selfReport: 0.5 }, WEIGHTS, 0.55);
    expect(explainEscalation(confidence, context())).toMatch(/escalate/i);
  });
});

describe("noEvidenceEscalationReason", () => {
  it("states there is nothing at all to draw on, and what would help", () => {
    const reason = noEvidenceEscalationReason();
    expect(reason).toMatch(/escalate/i);
    expect(reason.toLowerCase()).toContain("would");
  });
});

describe("refusedSubjectEscalationReason — cites the refusal, nothing else (#34 AC2)", () => {
  it("names the matched refusal text", () => {
    const reason = refusedSubjectEscalationReason("compensation");
    expect(reason).toContain("compensation");
    expect(reason).toMatch(/escalate/i);
    expect(reason).toContain("duo/refusals.md");
  });
});
