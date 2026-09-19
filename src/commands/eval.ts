import type { DuoConfig } from "../config.js";
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
