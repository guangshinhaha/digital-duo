import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderConfigError } from "../src/provider/types.js";

describe("loadConfig", () => {
  it("applies documented defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.storePath).toBe("data/duo.db");
    expect(config.duoDir).toBe("duo");
    expect(config.ollama.host).toBe("http://localhost:11434");
    expect(config.providerName).toBeUndefined();
    expect(config.ollama.model).toBeUndefined();
    expect(config.ollama.embeddingModel).toBe("nomic-embed-text");
    expect(config.classificationCeiling).toBe("official_open");
    expect(config.ownerName).toBe("the owner");
    expect(config.confidence).toEqual({
      weights: { selfConsistency: 0.3, retrievalStrength: 0.3, ruleHit: 0.25, recency: 0.1, selfReport: 0.05 },
      escalationThreshold: 0.55,
      selfConsistencySamples: 3,
      recencyHalfLifeDays: 180,
    });
    expect(config.eval).toEqual({
      holdoutDays: 42,
      gateLabelsPath: "eval/gate-labels.json",
      gatePrecisionFloor: 0.95,
    });
    expect(config.lifecycleLogPath).toBe("duo-lifecycle-runtime/events.json");
  });

  it("uses exactly the given values with no defaults applied over them", () => {
    const config = loadConfig({
      DUO_STORE_PATH: "/tmp/x.db",
      DUO_DIR: "/tmp/duo-out",
      DUO_PROVIDER: "ollama",
      DUO_OLLAMA_HOST: "http://h:1",
      DUO_OLLAMA_MODEL: "llama3",
      DUO_OLLAMA_EMBEDDING_MODEL: "custom-embed",
      DUO_CLASSIFICATION_CEILING: "secret",
      DUO_CONFIDENCE_WEIGHT_SELF_CONSISTENCY: "0.4",
      DUO_CONFIDENCE_WEIGHT_RETRIEVAL_STRENGTH: "0.2",
      DUO_CONFIDENCE_WEIGHT_RULE_HIT: "0.2",
      DUO_CONFIDENCE_WEIGHT_RECENCY: "0.15",
      DUO_CONFIDENCE_WEIGHT_SELF_REPORT: "0.05",
      DUO_CONFIDENCE_ESCALATION_THRESHOLD: "0.6",
      DUO_CONFIDENCE_SELF_CONSISTENCY_SAMPLES: "5",
      DUO_CONFIDENCE_RECENCY_HALF_LIFE_DAYS: "90",
      DUO_EVAL_HOLDOUT_DAYS: "21",
      DUO_EVAL_GATE_LABELS_PATH: "/tmp/labels.json",
      DUO_EVAL_GATE_PRECISION_FLOOR: "0.9",
      DUO_OWNER_NAME: "Priya Nair",
      DUO_LIFECYCLE_LOG_PATH: "/tmp/lifecycle.json",
    });
    expect(config).toEqual({
      providerName: "ollama",
      storePath: "/tmp/x.db",
      classificationCeiling: "secret",
      duoDir: "/tmp/duo-out",
      ownerName: "Priya Nair",
      ollama: { host: "http://h:1", model: "llama3", embeddingModel: "custom-embed" },
      confidence: {
        weights: { selfConsistency: 0.4, retrievalStrength: 0.2, ruleHit: 0.2, recency: 0.15, selfReport: 0.05 },
        escalationThreshold: 0.6,
        selfConsistencySamples: 5,
        recencyHalfLifeDays: 90,
      },
      eval: {
        holdoutDays: 21,
        gateLabelsPath: "/tmp/labels.json",
        gatePrecisionFloor: 0.9,
      },
      lifecycleLogPath: "/tmp/lifecycle.json",
    });
  });

  it("falls back to the confidence defaults when a numeric env var is unset or unparseable", () => {
    const config = loadConfig({ DUO_CONFIDENCE_WEIGHT_SELF_CONSISTENCY: "not-a-number" });
    expect(config.confidence.weights.selfConsistency).toBe(0.3);
  });

  it("never throws regardless of input", () => {
    expect(() => loadConfig({})).not.toThrow();
    expect(() => loadConfig({ DUO_PROVIDER: "not-a-real-provider" })).not.toThrow();
  });
});

describe("ProviderConfigError", () => {
  it("names the missing key in its message", () => {
    const error = new ProviderConfigError("DUO_PROVIDER");
    expect(error.message).toContain("DUO_PROVIDER");
    expect(error.missingKey).toBe("DUO_PROVIDER");
  });

  it("includes optional detail in its message", () => {
    const error = new ProviderConfigError("DUO_PROVIDER", "unknown-provider");
    expect(error.message).toContain("DUO_PROVIDER");
    expect(error.message).toContain("unknown-provider");
  });
});
