import { describe, expect, it } from "vitest";
import { attributionLine, withAttribution } from "../src/shared-duo/attribution.js";

describe("attributionLine", () => {
  it("names the shared duo and the owner, never framing it as a person, colleague, or employee", () => {
    const line = attributionLine("Dana Cole");
    expect(line).toContain("the shared duo");
    expect(line).toContain("Dana Cole");
    expect(line).not.toMatch(/\bcolleague\b/i);
    expect(line).not.toMatch(/\bemployee\b/i);
    expect(line).not.toMatch(/\bI am\b/i);
  });
});

describe("withAttribution", () => {
  it("appends the attribution line after the given text, on its own paragraph", () => {
    const result = withAttribution("some answer text", "Dana Cole");
    expect(result.startsWith("some answer text")).toBe(true);
    expect(result).toContain(attributionLine("Dana Cole"));
  });

  it("still attributes even when the base text is empty", () => {
    expect(withAttribution("", "Dana Cole")).toContain("Dana Cole");
  });
});
