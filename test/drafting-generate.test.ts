import { describe, expect, it } from "vitest";
import { buildDraftPrompt, extractiveDraft, pickRepresentativeSample } from "../src/drafting/generate.js";
import type { DraftContext } from "../src/drafting/context.js";
import type { Rule } from "../src/derivation/rules.js";

function baseContext(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    evidence: [],
    ruleHit: undefined,
    freshestEvidenceAgeDays: null,
    voiceText: "terse and direct",
    usedEmbeddings: true,
    ...overrides,
  };
}

const RULE: Rule = {
  id: "topic-leave",
  topicId: "topic-leave",
  text: "Standard leave is five days per quarter.",
  status: "confirmed",
  supportCount: 3,
  consistency: 0.9,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastConfirmedAt: "2026-01-01T00:00:00.000Z",
  reviewStatus: "approved",
  origin: "derived",
  supersededByRuleId: null,
  correctionDraftId: null,
  correctionQuestion: null,
};

describe("buildDraftPrompt", () => {
  it("includes the voice profile, the question, and never invents facts", () => {
    const prompt = buildDraftPrompt("How much leave do I get?", null, baseContext());
    expect(prompt).toContain("terse and direct");
    expect(prompt).toContain("How much leave do I get?");
    expect(prompt).toContain("Never invent facts");
  });

  it("includes the rule hit and evidence when present", () => {
    const prompt = buildDraftPrompt(
      "How much leave?",
      null,
      baseContext({
        ruleHit: RULE,
        evidence: [{ recordId: "r1", text: "past answer text", timestamp: "2026-01-01T00:00:00.000Z", similarity: 0.9, classification: "unknown" }],
      }),
    );
    expect(prompt).toContain(RULE.text);
    expect(prompt).toContain("past answer text");
  });

  it("includes piped thread context ahead of the question (AC4)", () => {
    const prompt = buildDraftPrompt("Is it due Friday?", "Alice: can you look at the report?\nMe: sure", baseContext());
    expect(prompt.indexOf("can you look at the report")).toBeLessThan(prompt.indexOf("Is it due Friday?"));
  });
});

describe("extractiveDraft", () => {
  it("prefers the rule's own text when a rule hit exists", () => {
    expect(
      extractiveDraft(baseContext({ ruleHit: RULE, evidence: [{ recordId: "r1", text: "other", timestamp: "t", similarity: 0.5, classification: "unknown" }] })),
    ).toBe(RULE.text);
  });

  it("falls back to the closest evidence when there's no rule hit", () => {
    expect(
      extractiveDraft(baseContext({ evidence: [{ recordId: "r1", text: "closest evidence text", timestamp: "t", similarity: 0.9, classification: "unknown" }] })),
    ).toBe("closest evidence text");
  });

  it("strips a leading classification marking off the closest evidence's text (#155)", () => {
    expect(
      extractiveDraft(
        baseContext({
          evidence: [{ recordId: "r1", text: "OFFICIAL (OPEN)\nclosest evidence text", timestamp: "t", similarity: 0.9, classification: "official_open" }],
        }),
      ),
    ).toBe("closest evidence text");
  });

  it("strips a leading classification marking off the rule's own text (#155) — a no-provider induction stores a marked answer verbatim as the rule text", () => {
    const markedRule = { ...RULE, text: "OFFICIAL (OPEN)\nStandard leave is five days per quarter." };
    expect(extractiveDraft(baseContext({ ruleHit: markedRule }))).toBe("Standard leave is five days per quarter.");
  });

  it("returns undefined when there's nothing to draft from at all", () => {
    expect(extractiveDraft(baseContext())).toBeUndefined();
  });
});

describe("pickRepresentativeSample", () => {
  it("returns the only sample when there's just one", () => {
    expect(pickRepresentativeSample(["only"], [])).toBe("only");
  });

  it("picks the sample closest to the group centroid", () => {
    // A direction-opposed outlier, not merely a differently-scaled one —
    // cosine similarity to the mean is scale-sensitive, so a
    // larger-magnitude outlier can (correctly, by this measure) look
    // "central" if it dominates the mean; an opposed direction cannot.
    const samples = ["outlier", "typical-a", "typical-b"];
    const embeddings = [
      [-1, 0, 1],
      [1, 1, 0],
      [1, 0.9, 0.1],
    ];
    expect(pickRepresentativeSample(samples, embeddings)).not.toBe("outlier");
  });

  it("returns empty string for no samples", () => {
    expect(pickRepresentativeSample([], [])).toBe("");
  });
});
