import { describe, expect, it } from "vitest";
import { publicAttributionLine, renderSourceAttribution, withPublicAttribution } from "../src/permissions/attribution.js";
import type { DraftSource } from "../src/drafting/draft-log.js";

describe("publicAttributionLine", () => {
  it("names the owner's duo, not the owner, with no detail for a non-answer message", () => {
    const line = publicAttributionLine("Dana Cole");
    expect(line).toContain("Dana Cole");
    expect(line).toMatch(/duo/i);
    expect(line).not.toMatch(/confidence/i);
  });

  it("states confidence and evidence age when detail is given", () => {
    const line = publicAttributionLine("Dana Cole", { confidence: 0.82, evidenceAgeDays: 12 });
    expect(line).toContain("0.82");
    expect(line).toMatch(/12 day/);
  });

  it("says there is no dated evidence when evidenceAgeDays is null", () => {
    const line = publicAttributionLine("Dana Cole", { confidence: 0.6, evidenceAgeDays: null });
    expect(line).toMatch(/no dated evidence/);
  });
});

describe("renderSourceAttribution", () => {
  it("returns an empty string for no sources", () => {
    expect(renderSourceAttribution([])).toBe("");
  });

  it("tells a standing order (the owner's own position) apart from a retrieved past exchange", () => {
    const sources: DraftSource[] = [
      { kind: "rule", id: "r1", label: "standing order: five days per quarter" },
      { kind: "evidence", id: "e1", label: "past exchange (similarity 0.90): asked last week" },
    ];
    const rendered = renderSourceAttribution(sources);
    expect(rendered).toMatch(/owner's own standing order/);
    expect(rendered).toMatch(/retrieved past exchange, not the owner speaking now/);
    expect(rendered).toContain("five days per quarter");
    expect(rendered).toContain("asked last week");
  });
});

describe("withPublicAttribution", () => {
  it("composes text, sources, and the attribution line, in that order", () => {
    const sources: DraftSource[] = [{ kind: "rule", id: "r1", label: "standing order text" }];
    const result = withPublicAttribution("the answer", "Dana Cole", sources, { confidence: 0.7, evidenceAgeDays: 3 });
    const textIndex = result.indexOf("the answer");
    const sourceIndex = result.indexOf("standing order text");
    const attributionIndex = result.indexOf("Dana Cole");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(sourceIndex).toBeGreaterThan(textIndex);
    expect(attributionIndex).toBeGreaterThan(sourceIndex);
  });

  it("still attributes with no sources and no detail — there is nothing that can produce an unlabelled result (#44 AC2)", () => {
    const result = withPublicAttribution("", "Dana Cole");
    expect(result).toContain("Dana Cole");
  });
});
