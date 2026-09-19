import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GateLabelExample } from "../src/eval/gate-labels.js";
import { loadGateLabels } from "../src/eval/gate-labels.js";
import { assertPrecisionFloor, MIN_LABELS_PER_MENTION_TYPE, PrecisionFloorViolationError, scoreRelevanceGate } from "../src/eval/gate-eval.js";

function example(overrides: Partial<GateLabelExample> & Pick<GateLabelExample, "id" | "text" | "expected">): GateLabelExample {
  return { mentionType: "generic", ...overrides };
}

describe("scoreRelevanceGate — precision and recall, never averaged into one figure (#36 AC1)", () => {
  it("scores true/false positives and negatives against the real gate (classifyMention)", () => {
    const labels: GateLabelExample[] = [
      example({ id: "q1", text: "can you review this?", expected: "answerable" }), // TP
      example({ id: "n1", text: "thanks so much!", expected: "not_answerable" }), // TN
    ];
    const report = scoreRelevanceGate(labels);
    expect(report.total).toBe(2);
    expect(report.truePositives).toBe(1);
    expect(report.trueNegatives).toBe(1);
    expect(report.falsePositives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.precision).toBe(1);
    expect(report.recall).toBe(1);
  });

  it("reports precision as a perfect 1 (not NaN) when nothing was predicted answerable at all", () => {
    const labels: GateLabelExample[] = [example({ id: "n1", text: "thanks!", expected: "not_answerable" })];
    const report = scoreRelevanceGate(labels);
    expect(report.truePositives + report.falsePositives).toBe(0);
    expect(report.precision).toBe(1);
  });

  it("reports recall as 0 (not NaN) when the label set has no answerable examples at all", () => {
    const labels: GateLabelExample[] = [example({ id: "n1", text: "thanks!", expected: "not_answerable" })];
    const report = scoreRelevanceGate(labels);
    expect(report.recall).toBe(0);
  });

  it("names false positives explicitly, per #36 AC2, rather than only counting them", () => {
    // A question-shaped mention the gate will actually pass, hand-labelled
    // as not really answerable — a real false positive against the gate's
    // current keyword heuristic.
    const labels: GateLabelExample[] = [example({ id: "r1", text: "Why does this always happen?", expected: "not_answerable" })];
    const report = scoreRelevanceGate(labels);
    expect(report.falsePositives).toBe(1);
    expect(report.falsePositiveExamples).toHaveLength(1);
    expect(report.falsePositiveExamples[0].id).toBe("r1");
  });

  it("reports coverage per mentionType and flags an under-represented one", () => {
    const labels: GateLabelExample[] = [
      example({ id: "a1", mentionType: "typeA", text: "thanks!", expected: "not_answerable" }),
      example({ id: "a2", mentionType: "typeA", text: "cheers!", expected: "not_answerable" }),
      example({ id: "a3", mentionType: "typeA", text: "no worries!", expected: "not_answerable" }),
      example({ id: "b1", mentionType: "typeB", text: "fyi, done.", expected: "not_answerable" }),
    ];
    const report = scoreRelevanceGate(labels);
    expect(report.coverageByMentionType).toEqual({ typeA: 3, typeB: 1 });
    expect(MIN_LABELS_PER_MENTION_TYPE).toBe(3);
    expect(report.underrepresentedMentionTypes).toEqual(["typeB"]);
  });
});

describe("assertPrecisionFloor — #36 AC2, fails loudly on a regression", () => {
  it("is a no-op when precision meets the floor", () => {
    const labels: GateLabelExample[] = [example({ id: "q1", text: "can you review this?", expected: "answerable" })];
    const report = scoreRelevanceGate(labels);
    expect(() => assertPrecisionFloor(report, 0.95)).not.toThrow();
  });

  it("throws PrecisionFloorViolationError, naming the newly admitted false positives, when precision drops below the floor", () => {
    const labels: GateLabelExample[] = [
      example({ id: "q1", text: "can you review this?", expected: "answerable" }), // TP
      example({ id: "r1", text: "Why does this always happen?", expected: "not_answerable" }), // FP
    ];
    const report = scoreRelevanceGate(labels); // precision = 1/2 = 0.5
    expect(() => assertPrecisionFloor(report, 0.95)).toThrow(PrecisionFloorViolationError);
    try {
      assertPrecisionFloor(report, 0.95);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrecisionFloorViolationError);
      const typed = error as PrecisionFloorViolationError;
      expect(typed.floor).toBe(0.95);
      expect(typed.precision).toBeCloseTo(0.5, 5);
      expect(typed.falsePositives.map((item) => item.id)).toEqual(["r1"]);
      expect(typed.message).toMatch(/r1/);
    }
  });
});

describe("scoreRelevanceGate — the real, checked-in eval/gate-labels.json (#36 AC: labelled set lives in the repo)", () => {
  it("pins the gate's current, honest precision/recall against the committed fixture", () => {
    // This is a documented, real finding from building this harness, not
    // an assumption: the relevance gate's keyword heuristic (#31) treats
    // any "?" or a leading question word as a genuine question, so a
    // rhetorical/sarcastic question (mentionType "rhetorical_question" in
    // the fixture) is scored as a false positive. Tuning the gate itself
    // is explicitly out of scope for #36 ("that happens in #31") — this
    // test pins today's real numbers as a regression tripwire: a future
    // change that pushes precision *lower* than this must fail here, and
    // a change that fixes the gap should update this test deliberately,
    // not by accident.
    const labels = loadGateLabels(fileURLToPath(new URL("../eval/gate-labels.json", import.meta.url)));
    const report = scoreRelevanceGate(labels);

    expect(report.recall).toBe(1); // no genuine question is ever missed
    expect(report.precision).toBeCloseTo(0.75, 5); // below the 0.95 floor — see comment above
    expect(report.falsePositiveExamples.map((item) => item.mentionType)).toEqual([
      "rhetorical_question",
      "rhetorical_question",
      "rhetorical_question",
      "rhetorical_question",
    ]);
    expect(report.underrepresentedMentionTypes).toEqual([]);
  });
});
