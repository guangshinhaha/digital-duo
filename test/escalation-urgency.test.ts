import { describe, expect, it } from "vitest";
import { classifyUrgency } from "../src/escalation/urgency.js";

describe("classifyUrgency", () => {
  it("classifies an objective severity signal as urgent", () => {
    expect(classifyUrgency("production is down, nobody can log in")).toBe("urgent");
    expect(classifyUrgency("we think there's been a data breach")).toBe("urgent");
    expect(classifyUrgency("customers can't access the portal at all")).toBe("urgent");
  });

  it("does not trust an asker simply saying the question is urgent (#46's own open question)", () => {
    expect(classifyUrgency("this is urgent, can you approve my leave request asap")).toBe("normal");
    expect(classifyUrgency("EMERGENCY: what is my vacation balance")).toBe("normal");
  });

  it("classifies an ordinary question as normal", () => {
    expect(classifyUrgency("how much vacation leave do I get")).toBe("normal");
  });
});
