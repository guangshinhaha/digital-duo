const DEFAULT_STORE_PATH = "data/duo.db";
// The human-readable, git-versioned half of the derived output
// (v1-tech-design.md §1.3: `duo/topics.json`, `duo/rules/*.md`, `duo/voice.md`) —
// deliberately separate from `storePath`'s encrypted database directory.
const DEFAULT_DUO_DIR = "duo";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
// Embeddings run locally via Ollama unconditionally (v1-tech-design.md §1.2)
// — unlike the completion model, this doesn't wait on G1, so it gets a real
// default rather than requiring explicit configuration.
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
// The classification ceiling is policy-set, not owner-set (#48 AC: "set by
// configuration under policy control, not by the owner in the UI"), and
// defaults to the most conservative real-world default rather than the
// most permissive (v1-tech-design.md §2: a pilot corpus is "probably ...
// Official (Open) only").
const DEFAULT_CLASSIFICATION_CEILING = "official_open";

// #33's own acceptance criteria: "signal weights live in configuration,
// not in code, so the eval harness can sweep them." Defaults reflect
// v1-tech-design.md §1.8's ranking (self-consistency and retrieval
// strength highest, recency medium, self-report lowest because it's
// poorly calibrated) without summing to any particular total — scoreConfidence
// normalizes by the weights' own sum, so a sweep can scale them freely.
const DEFAULT_CONFIDENCE_WEIGHT_SELF_CONSISTENCY = 0.3;
const DEFAULT_CONFIDENCE_WEIGHT_RETRIEVAL_STRENGTH = 0.3;
const DEFAULT_CONFIDENCE_WEIGHT_RULE_HIT = 0.25;
const DEFAULT_CONFIDENCE_WEIGHT_RECENCY = 0.1;
const DEFAULT_CONFIDENCE_WEIGHT_SELF_REPORT = 0.05;
// Below this composite score, the draft pipeline (#32/#34) suppresses the
// draft in favor of an escalation (#33 AC2).
const DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD = 0.55;
// Fixed sample count for self-consistency (#33 AC checklist): generate
// this many drafts and measure their agreement.
const DEFAULT_CONFIDENCE_SELF_CONSISTENCY_SAMPLES = 3;
// Exponential half-life for evidence-recency decay, in days. 180 matches
// #69's shared-duo staleness threshold (isStale) — the same "material not
// revisited in about six months starts to look old" judgment, reused here
// rather than picking an unrelated number.
const DEFAULT_CONFIDENCE_RECENCY_HALF_LIFE_DAYS = 180;

// #35: v1-tech-design.md §1.10 says "hold out the most recent 6-8 weeks";
// 42 days (6 weeks) is the conservative end of that range, since a longer
// window is safer against AR-7 leakage than a shorter one.
const DEFAULT_EVAL_HOLDOUT_DAYS = 42;
// #44: what a public answer names itself owned by — "attributed to the
// owner's duo... not to the owner" (AC1) still needs *some* name for whose
// duo it is. A generic, honest default rather than inventing a real one:
// nothing upstream of this config (v1-spec.md's checked-in-file convention)
// carries the owner's actual name for the *personal* duo the way
// shared-duo/persona.json does for the shared one.
const DEFAULT_OWNER_NAME = "the owner";
// #36: the hand-labelled relevance-gate corpus, checked into the repo like
// duo/directory.json and shared-duo/persona.json — its own top-level
// directory since it's neither the encrypted store (data/) nor the
// derived, git-versioned duo output (duo/), but a fixed evaluation fixture.
const DEFAULT_EVAL_GATE_LABELS_PATH = "eval/gate-labels.json";
// #36 AC: "the precision floor is stated as a number, not a sentiment" —
// matches src/drafting/relevance-gate.ts's own stated target precision.
const DEFAULT_EVAL_GATE_PRECISION_FLOOR = 0.95;
// #63: a record of every archival/transfer/deletion, kept in its own
// top-level directory — deliberately neither `data/` (the encrypted
// store's directory, which `duo purge`/#63's own `endDuo` delete wholesale)
// nor `duo/` (removed by that same `endDuo`) — the same "runtime data must
// survive the thing it logs about being deleted" lesson #69 already
// learned the hard way for the shared duo's usage log.
const DEFAULT_LIFECYCLE_LOG_PATH = "duo-lifecycle-runtime/events.json";

function parseNumberEnv(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface DuoConfig {
  /** Raw configured provider name, or undefined when DUO_PROVIDER is unset. */
  providerName: string | undefined;
  /** Path to the local store file. Defaults to "data/duo.db". */
  storePath: string;
  /** Raw configured classification ceiling (DUO_CLASSIFICATION_CEILING). Defaults to "official_open". Validated at the point of use (parseClassificationCeiling), same pattern as providerName — a bad value is a usage-time error, not a load-time one, so `duo status` can always report it raw. */
  classificationCeiling: string;
  /** Directory for human-readable, git-versioned derived output (topics.json, rules/*.md, voice.md). Defaults to "duo". Never encrypted, never purged by `duo purge`. */
  duoDir: string;
  /** #44: the name a public answer attributes itself to being owned by. Defaults to "the owner" — not a suppression knob (there is no config that removes attribution entirely, only what name it carries). */
  ownerName: string;
  ollama: {
    /** Ollama HTTP host. Defaults to "http://localhost:11434". */
    host: string;
    /** Ollama model name, or undefined when DUO_OLLAMA_MODEL is unset. */
    model: string | undefined;
    /** Ollama embedding model name. Defaults to "nomic-embed-text". */
    embeddingModel: string;
  };
  /** #33: the draft pipeline's composite-confidence knobs, all configuration rather than code so the eval harness can sweep them. */
  confidence: {
    weights: {
      selfConsistency: number;
      retrievalStrength: number;
      ruleHit: number;
      recency: number;
      selfReport: number;
    };
    /** Composite score below which a draft is suppressed in favor of an escalation. Defaults to 0.55. */
    escalationThreshold: number;
    /** Fixed self-consistency sample count. Defaults to 3. */
    selfConsistencySamples: number;
    /** Recency-decay half-life, in days. Defaults to 180. */
    recencyHalfLifeDays: number;
  };
  /** #35/#36: the offline evaluation harness's own knobs, all configuration for the same reason #33's confidence weights are — an eval harness needs to sweep them without a code change. */
  eval: {
    /** #35: the time-based split's held-out window, in days, applied *before* derivation runs (AR-7). Defaults to 42 (6 weeks). Recorded alongside every offline-eval score. */
    holdoutDays: number;
    /** #36: path to the hand-labelled relevance-gate mention set. Defaults to "eval/gate-labels.json". */
    gateLabelsPath: string;
    /** #36: the stated precision floor a gate-eval run fails against. Defaults to 0.95, matching RELEVANCE_GATE_TARGET_PRECISION. */
    gatePrecisionFloor: number;
  };
  /** #63: where the durable archival/transfer/deletion log lives. Defaults to "duo-lifecycle-runtime/events.json" — its own directory, outside anything `endDuo` or `duo purge` ever deletes. */
  lifecycleLogPath: string;
}

/**
 * Reads configuration from environment variables. This is a pure read: it
 * applies only the two documented defaults (store path, Ollama host) and
 * never validates or rejects a provider name or model — that validation
 * belongs to `resolveProvider` (see src/provider/registry.ts), so `duo
 * status` can report raw configuration without ever throwing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DuoConfig {
  return {
    providerName: env.DUO_PROVIDER || undefined,
    storePath: env.DUO_STORE_PATH || DEFAULT_STORE_PATH,
    classificationCeiling: env.DUO_CLASSIFICATION_CEILING || DEFAULT_CLASSIFICATION_CEILING,
    duoDir: env.DUO_DIR || DEFAULT_DUO_DIR,
    ownerName: env.DUO_OWNER_NAME || DEFAULT_OWNER_NAME,
    ollama: {
      host: env.DUO_OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
      model: env.DUO_OLLAMA_MODEL || undefined,
      embeddingModel: env.DUO_OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBEDDING_MODEL,
    },
    confidence: {
      weights: {
        selfConsistency: parseNumberEnv(env.DUO_CONFIDENCE_WEIGHT_SELF_CONSISTENCY, DEFAULT_CONFIDENCE_WEIGHT_SELF_CONSISTENCY),
        retrievalStrength: parseNumberEnv(env.DUO_CONFIDENCE_WEIGHT_RETRIEVAL_STRENGTH, DEFAULT_CONFIDENCE_WEIGHT_RETRIEVAL_STRENGTH),
        ruleHit: parseNumberEnv(env.DUO_CONFIDENCE_WEIGHT_RULE_HIT, DEFAULT_CONFIDENCE_WEIGHT_RULE_HIT),
        recency: parseNumberEnv(env.DUO_CONFIDENCE_WEIGHT_RECENCY, DEFAULT_CONFIDENCE_WEIGHT_RECENCY),
        selfReport: parseNumberEnv(env.DUO_CONFIDENCE_WEIGHT_SELF_REPORT, DEFAULT_CONFIDENCE_WEIGHT_SELF_REPORT),
      },
      escalationThreshold: parseNumberEnv(env.DUO_CONFIDENCE_ESCALATION_THRESHOLD, DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD),
      selfConsistencySamples: parseNumberEnv(env.DUO_CONFIDENCE_SELF_CONSISTENCY_SAMPLES, DEFAULT_CONFIDENCE_SELF_CONSISTENCY_SAMPLES),
      recencyHalfLifeDays: parseNumberEnv(env.DUO_CONFIDENCE_RECENCY_HALF_LIFE_DAYS, DEFAULT_CONFIDENCE_RECENCY_HALF_LIFE_DAYS),
    },
    eval: {
      holdoutDays: parseNumberEnv(env.DUO_EVAL_HOLDOUT_DAYS, DEFAULT_EVAL_HOLDOUT_DAYS),
      gateLabelsPath: env.DUO_EVAL_GATE_LABELS_PATH || DEFAULT_EVAL_GATE_LABELS_PATH,
      gatePrecisionFloor: parseNumberEnv(env.DUO_EVAL_GATE_PRECISION_FLOOR, DEFAULT_EVAL_GATE_PRECISION_FLOOR),
    },
    lifecycleLogPath: env.DUO_LIFECYCLE_LOG_PATH || DEFAULT_LIFECYCLE_LOG_PATH,
  };
}
