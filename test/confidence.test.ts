import { describe, expect, it } from "vitest";
import {
  computeRecencyDecay,
  computeRetrievalStrength,
  computeSelfReport,
  runSelfConsistencySampling,
  scoreConfidence,
  type ConfidenceWeights,
} from "../src/drafting/confidence.js";

const WEIGHTS: ConfidenceWeights = { selfConsistency: 0.3, retrievalStrength: 0.3, ruleHit: 0.25, recency: 0.1, selfReport: 0.05 };
const THRESHOLD = 0.55;

describe("scoreConfidence — well-supported answers score high (AC1)", () => {
  it("lands high, with every contributing signal visible individually", () => {
    const result = scoreConfidence(
      { selfConsistency: 0.95, retrievalStrength: 0.9, ruleHit: 1, recency: 0.95, selfReport: 0.8 },
      WEIGHTS,
      THRESHOLD,
    );
    expect(result.score).toBeGreaterThan(THRESHOLD);
    expect(result.passesThreshold).toBe(true);
    expect(result.signals).toEqual({ selfConsistency: 0.95, retrievalStrength: 0.9, ruleHit: 1, recency: 0.95, selfReport: 0.8 });
    expect(result.weights).toEqual(WEIGHTS);
  });
});

describe("scoreConfidence — thin support scores low and routes to escalation (AC2)", () => {
  it("lands below the escalation threshold when retrieval is weak and no rule matches", () => {
    const result = scoreConfidence(
      { selfConsistency: 0.4, retrievalStrength: 0.1, ruleHit: 0, recency: 1, selfReport: 0.5 },
      WEIGHTS,
      THRESHOLD,
    );
    expect(result.score).toBeLessThan(THRESHOLD);
    expect(result.passesThreshold).toBe(false);
  });
});

describe("scoreConfidence — old evidence lowers confidence relative to recent support (AC3)", () => {
  it("scores identical support lower when its recency signal is decayed", () => {
    const base = { selfConsistency: 0.8, retrievalStrength: 0.8, ruleHit: 1, selfReport: 0.6 };
    const fresh = scoreConfidence({ ...base, recency: computeRecencyDecay(1, 180) }, WEIGHTS, THRESHOLD);
    const old = scoreConfidence({ ...base, recency: computeRecencyDecay(365, 180) }, WEIGHTS, THRESHOLD);
    expect(old.score).toBeLessThan(fresh.score);
  });
});

describe("scoreConfidence — weights live in configuration (AC checklist)", () => {
  it("responds to a different weight configuration without any code change", () => {
    const signals = { selfConsistency: 1, retrievalStrength: 0, ruleHit: 0, recency: 0, selfReport: 0 };
    const heavyOnSelfConsistency: ConfidenceWeights = { selfConsistency: 1, retrievalStrength: 0, ruleHit: 0, recency: 0, selfReport: 0 };
    const heavyOnRetrieval: ConfidenceWeights = { selfConsistency: 0, retrievalStrength: 1, ruleHit: 0, recency: 0, selfReport: 0 };
    expect(scoreConfidence(signals, heavyOnSelfConsistency, THRESHOLD).score).toBe(1);
    expect(scoreConfidence(signals, heavyOnRetrieval, THRESHOLD).score).toBe(0);
  });

  it("never divides by zero when every weight is zero", () => {
    const zeroWeights: ConfidenceWeights = { selfConsistency: 0, retrievalStrength: 0, ruleHit: 0, recency: 0, selfReport: 0 };
    const result = scoreConfidence({ selfConsistency: 1, retrievalStrength: 1, ruleHit: 1, recency: 1, selfReport: 1 }, zeroWeights, THRESHOLD);
    expect(result.score).toBe(0);
    expect(result.passesThreshold).toBe(false);
  });
});

describe("computeRetrievalStrength", () => {
  it("is zero with no evidence at all", () => {
    expect(computeRetrievalStrength([])).toBe(0);
  });

  it("rewards both similarity and count, up to the support threshold", () => {
    const oneWeakMatch = computeRetrievalStrength([0.9]);
    const threeStrongMatches = computeRetrievalStrength([0.9, 0.9, 0.9]);
    expect(threeStrongMatches).toBeGreaterThan(oneWeakMatch);
    expect(threeStrongMatches).toBeCloseTo(0.9, 5);
  });

  it("does not reward a fourth match beyond the threshold count", () => {
    const three = computeRetrievalStrength([0.8, 0.8, 0.8]);
    const four = computeRetrievalStrength([0.8, 0.8, 0.8, 0.8]);
    expect(four).toBeCloseTo(three, 5);
  });
});

describe("computeRecencyDecay", () => {
  it("is 1 (no penalty) when there is no age to speak of", () => {
    expect(computeRecencyDecay(null, 180)).toBe(1);
  });

  it("is exactly half at one half-life", () => {
    expect(computeRecencyDecay(180, 180)).toBeCloseTo(0.5, 5);
  });

  it("decays further the older the evidence, and the age is a plain number a caller can state", () => {
    const fresh = computeRecencyDecay(7, 180);
    const oneYearOld = computeRecencyDecay(365, 180);
    expect(oneYearOld).toBeLessThan(fresh);
    expect(oneYearOld).toBeGreaterThanOrEqual(0);
  });
});

describe("computeSelfReport", () => {
  it("defaults to a neutral 0.5 when the model gave no self-report", () => {
    expect(computeSelfReport(null)).toBe(0.5);
  });

  it("parses a percentage-style number", () => {
    expect(computeSelfReport("82%")).toBeCloseTo(0.82, 5);
  });

  it("parses an already-normalized 0..1 number", () => {
    expect(computeSelfReport("0.9")).toBeCloseTo(0.9, 5);
  });

  it("parses qualitative words", () => {
    expect(computeSelfReport("I'm highly confident")).toBeGreaterThan(0.7);
    expect(computeSelfReport("not confident at all")).toBeLessThan(0.3);
  });

  it("defaults to neutral for unparseable text", () => {
    expect(computeSelfReport("the sky is blue")).toBe(0.5);
  });
});

describe("runSelfConsistencySampling — fixed sample count, cost recorded (AC checklist)", () => {
  it("runs exactly sampleCount generations and records elapsed time", async () => {
    let calls = 0;
    const result = await runSelfConsistencySampling(
      "prompt",
      3,
      async () => {
        calls += 1;
        return "same answer every time";
      },
      async () => [1, 0, 0],
    );
    expect(calls).toBe(3);
    expect(result.sampleCount).toBe(3);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.agreement).toBeCloseTo(1, 5);
  });

  it("scores lower agreement when samples genuinely disagree", async () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    let generated = 0;
    let embedded = 0;
    const result = await runSelfConsistencySampling(
      "prompt",
      3,
      async () => `sample-${generated++}`, // distinct text per call, so the identical-text short-circuit doesn't apply
      async () => vectors[embedded++],
    );
    expect(result.agreement).toBeCloseTo(0, 5);
  });

  it("a single sample trivially agrees with itself", async () => {
    const result = await runSelfConsistencySampling("prompt", 1, async () => "only answer", async () => [1, 2, 3]);
    expect(result.sampleCount).toBe(1);
    expect(result.agreement).toBe(1);
  });

  it("degrades to a neutral agreement score if embedding the samples fails", async () => {
    let generated = 0;
    const result = await runSelfConsistencySampling(
      "prompt",
      2,
      async () => `answer-${generated++}`, // distinct text, so embedding is actually attempted (and fails) rather than short-circuiting on identical text
      async () => {
        throw new Error("embedding service down");
      },
    );
    expect(result.agreement).toBe(0.5);
    expect(result.samples).toHaveLength(2);
  });
});
