import { describe, expect, it } from "vitest";
import type { QaPair } from "../src/derivation/qa-pairs.js";
import type { Rule } from "../src/derivation/rules.js";
import { assertNoHeldOutEvidence, HeldOutLeakageError } from "../src/eval/held-out-assertion.js";
import { createRecord } from "../src/ingest/record.js";

const CUTOFF = "2026-02-01T00:00:00.000Z";

function rule(id: string): Rule {
  return {
    id,
    topicId: id,
    text: "some policy",
    status: "confirmed",
    supportCount: 3,
    consistency: 0.9,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastConfirmedAt: "2026-01-01T00:00:00.000Z",
    reviewStatus: "approved",
    origin: "derived",
  };
}

function qaPair(id: string, questionId: string, answerId: string): QaPair {
  return { id, questionId, answerId, threadId: "t1", ts: "2026-01-15T00:00:00.000Z", topicId: "topic-1" };
}

function recordAt(id: string, timestamp: string) {
  return { ...createRecord({ source: "test", sourceRef: null, kind: "my_thinking", author: "me", text: "x", timestamp, threadId: "t1", audience: "channel" }), id };
}

describe("assertNoHeldOutEvidence — #35 AC1, checked rather than assumed", () => {
  it("passes silently when every rule's evidence sits strictly before the cutoff", () => {
    const q = recordAt("q1", "2026-01-10T00:00:00.000Z");
    const a = recordAt("a1", "2026-01-11T00:00:00.000Z");
    const rules = [rule("rule-1")];
    const evidenceByRuleId = new Map([["rule-1", ["pair-1"]]]);
    const qaPairsById = new Map([["pair-1", qaPair("pair-1", "q1", "a1")]]);
    const recordsById = new Map([
      ["q1", q],
      ["a1", a],
    ]);
    expect(() => assertNoHeldOutEvidence(rules, evidenceByRuleId, qaPairsById, recordsById, CUTOFF)).not.toThrow();
  });

  it("throws HeldOutLeakageError, naming the rule/qa_pair/record, when an answer sits at or after the cutoff", () => {
    const q = recordAt("q1", "2026-01-10T00:00:00.000Z");
    const leakedAnswer = recordAt("a1", "2026-02-15T00:00:00.000Z"); // after CUTOFF
    const rules = [rule("rule-1")];
    const evidenceByRuleId = new Map([["rule-1", ["pair-1"]]]);
    const qaPairsById = new Map([["pair-1", qaPair("pair-1", "q1", "a1")]]);
    const recordsById = new Map([
      ["q1", q],
      ["a1", leakedAnswer],
    ]);

    expect(() => assertNoHeldOutEvidence(rules, evidenceByRuleId, qaPairsById, recordsById, CUTOFF)).toThrow(HeldOutLeakageError);
    try {
      assertNoHeldOutEvidence(rules, evidenceByRuleId, qaPairsById, recordsById, CUTOFF);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HeldOutLeakageError);
      expect((error as Error).message).toMatch(/rule-1/);
      expect((error as Error).message).toMatch(/pair-1/);
      expect((error as Error).message).toMatch(/a1/);
    }
  });

  it("also catches a leak on the question half of the pair, not just the answer half", () => {
    const leakedQuestion = recordAt("q1", "2026-03-01T00:00:00.000Z"); // after CUTOFF
    const a = recordAt("a1", "2026-01-11T00:00:00.000Z");
    const rules = [rule("rule-1")];
    const evidenceByRuleId = new Map([["rule-1", ["pair-1"]]]);
    const qaPairsById = new Map([["pair-1", qaPair("pair-1", "q1", "a1")]]);
    const recordsById = new Map([
      ["q1", leakedQuestion],
      ["a1", a],
    ]);
    expect(() => assertNoHeldOutEvidence(rules, evidenceByRuleId, qaPairsById, recordsById, CUTOFF)).toThrow(HeldOutLeakageError);
  });

  it("ignores a rule with no evidence rows at all, rather than throwing on an absent map entry", () => {
    const rules = [rule("rule-1")];
    expect(() => assertNoHeldOutEvidence(rules, new Map(), new Map(), new Map(), CUTOFF)).not.toThrow();
  });
});
