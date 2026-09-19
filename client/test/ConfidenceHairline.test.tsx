import { describe, expect, it } from "vitest";
import { hairlineState } from "../src/components/ConfidenceHairline.js";
import type { DraftPipelineResult } from "../src/api/types.js";

describe("hairlineState (client-tech-design.md Part 4)", () => {
  it("is refused for a refused escalation", () => {
    const result: DraftPipelineResult = { kind: "escalation", draftId: "d1", reason: "refused subject", refused: true, confidence: undefined };
    expect(hairlineState(result)).toBe("refused");
  });

  it("is escalated for a non-refused escalation", () => {
    const result: DraftPipelineResult = { kind: "escalation", draftId: "d1", reason: "no evidence", refused: false, confidence: undefined };
    expect(hairlineState(result)).toBe("escalated");
  });

  it("is confident when the score clears threshold + 0.15", () => {
    const result: DraftPipelineResult = {
      kind: "draft",
      draftId: "d1",
      text: "answer",
      sources: [],
      confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 },
    };
    expect(hairlineState(result)).toBe("confident");
  });

  it("is hedged just above threshold", () => {
    const result: DraftPipelineResult = {
      kind: "draft",
      draftId: "d1",
      text: "answer",
      sources: [],
      confidence: { score: 0.6, passesThreshold: true, threshold: 0.55 },
    };
    expect(hairlineState(result)).toBe("hedged");
  });
});
