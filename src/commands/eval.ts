import type { DuoConfig } from "../config.js";
import { readRefusalsFile } from "../drafting/refusals.js";
import { scoreRelevanceGate, type GateEvalReport } from "../eval/gate-eval.js";
import { loadGateLabels } from "../eval/gate-labels.js";
import { runOfflineEval, type OfflineEvalOptions, type OfflineEvalReport } from "../eval/offline-eval.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/**
 * Implements `duo eval offline` (#35). Best-effort adjudication/labeling/
 * rule-phrasing, same "degrade rather than fail" shape as every other
 * derivation entry point (G1 is unresolved) — a run without a configured
 * provider still exercises the whole harness through draftReply's
 * deterministic extractive fallback.
 */
export async function runEvalOffline(
  config: DuoConfig,
  options: Pick<OfflineEvalOptions, "sampleSize" | "seed"> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<OfflineEvalReport> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);

  const provider = tryResolveProvider(config);
  const embeddingProvider = createOllamaEmbeddingProvider(config);

  return runOfflineEval(
    config.storePath,
    passphrase,
    config.duoDir,
    embeddingProvider,
    provider,
    config.confidence,
    config.eval.holdoutDays,
    options,
  );
}

/**
 * Implements `duo eval gate` (#36). Scores the real relevance gate
 * (classifyMention) against the checked-in hand-labelled set — no store
 * or provider needed at all, since the gate itself is a pure function and
 * the labels are a plain checked-in file. Deliberately doesn't assert the
 * precision floor itself: the caller (the CLI action) prints the full
 * report — including coverage (#36 AC3) — *before* deciding whether to
 * fail on it, so a floor violation still reports the label distribution
 * rather than only the error that aborted the run.
 */
export function runEvalGate(config: DuoConfig): GateEvalReport {
  const labels = loadGateLabels(config.eval.gateLabelsPath);
  const refusals = readRefusalsFile(config.duoDir);
  return scoreRelevanceGate(labels, refusals);
}
