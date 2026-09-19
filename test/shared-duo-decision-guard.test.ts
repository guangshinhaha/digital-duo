import { describe, expect, it } from "vitest";
import { isDecisionRequest } from "../src/shared-duo/decision-guard.js";

describe("isDecisionRequest", () => {
  it.each([
    "can you decide whether we extend the deadline?",
    "please make a decision on this",
    "can you approve this expense claim?",
    "I need approval for this purchase",
    "can you authorize this?",
    "who can sign off on this?",
    "sign-off please",
    "give this the green light",
    "give this the go-ahead",
    "go ahead and confirm",
    "can you rubber-stamp this?",
    "can you overrule the earlier answer?",
  ])("recognises %j as a decision request", (question) => {
    expect(isDecisionRequest(question)).toBe(true);
  });

  it.each([
    "what is the leave policy?",
    "how many days of leave do I get?",
    "how do I sign in to the HR portal?",
    "what documents do I need for an expense claim?",
    "when are new starter IT accounts provisioned?",
    "please sign the form and return it",
  ])("does not flag an ordinary lookup question: %j", (question) => {
    expect(isDecisionRequest(question)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDecisionRequest("CAN YOU APPROVE THIS?")).toBe(true);
  });
});
