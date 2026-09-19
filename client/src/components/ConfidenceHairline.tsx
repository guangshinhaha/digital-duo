import type { DraftPipelineResult } from "../api/types.js";

/**
 * The 2px hairline on a draft's leading edge (`client-tech-design.md` Part
 * 4). Never a percentage — `confidenceScore` is a weighted composite
 * against a configurable threshold, not a calibrated probability, so
 * rendering "62%" would be precision the number doesn't have. Four states,
 * derived from the real fields on `DraftPipelineResult` rather than a
 * separately-maintained mapping.
 */
export function ConfidenceHairline({ result }: { result: DraftPipelineResult }) {
  const state = hairlineState(result);
  const style =
    state === "hedged"
      ? { backgroundColor: "var(--escalate)", opacity: 0.4 }
      : { backgroundColor: `var(--${colorToken(state)})` };
  return <div data-testid="confidence-hairline" data-state={state} className="h-0.5 w-full rounded-full" style={style} />;
}

export type HairlineState = "refused" | "escalated" | "hedged" | "confident";

function colorToken(state: HairlineState): string {
  switch (state) {
    case "refused":
      return "refused";
    case "escalated":
      return "escalate";
    case "confident":
      return "confident";
    case "hedged":
      return "escalate";
  }
}

export function hairlineState(result: DraftPipelineResult): HairlineState {
  if (result.kind === "escalation") {
    return result.refused ? "refused" : "escalated";
  }
  const { score, threshold } = result.confidence;
  if (score < threshold + 0.15) {
    return "hedged";
  }
  return "confident";
}
