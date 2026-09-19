import { describe, expect, it } from "vitest";
import { isWorkRelevant } from "../src/ingest/work-relevance.js";

describe("isWorkRelevant", () => {
  it("judges clearly work-signalled text as relevant", () => {
    expect(
      isWorkRelevant(
        "Can you help me draft the incident report for the outage? Need to update the runbook before the postmortem meeting with my manager.",
      ),
    ).toBe(true);
  });

  it("judges clearly personal-signalled text as not relevant", () => {
    expect(
      isWorkRelevant("What's a good recipe for a birthday dinner this weekend? Also thinking about wedding and honeymoon plans."),
    ).toBe(false);
  });

  it("defaults to relevant when there is no signal either way (biased toward keeping content)", () => {
    expect(isWorkRelevant("The weather today is mild with a light breeze.")).toBe(true);
  });

  it("defaults to relevant on an exact tie", () => {
    expect(isWorkRelevant("We discussed the budget report over recipe ideas for the birthday dinner.")).toBe(true);
  });
});
