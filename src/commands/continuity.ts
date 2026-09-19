import type { DuoConfig } from "../config.js";
import { assertPredecessorConsultable } from "../continuity/lifecycle.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { consultPredecessorDuo, type PredecessorConsultation } from "../continuity/predecessor.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/**
 * Implements `duo continuity consult <predecessorStorePath> <predecessorDuoDir> <predecessorName> <question>`
 * (#61): the successor asks *the predecessor's own personal duo* — a
 * different store than the current process's own `config.storePath`, named
 * explicitly, since consulting someone else's duo is the whole point.
 * `config` still supplies the shared provider settings (Ollama host/model),
 * not the store to read from.
 */
export async function runConsultPredecessor(
  predecessorStorePath: string,
  predecessorDuoDir: string,
  predecessorName: string,
  question: string,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PredecessorConsultation> {
  requireStoreExists(predecessorStorePath);
  // #63 AC4: even this historical-record surface refuses once the
  // predecessor's own duo has been declared orphaned — there is nobody
  // left accountable to frame the historical answer around at all.
  assertPredecessorConsultable(predecessorDuoDir);
  const passphrase = resolveOrCreatePassphrase(predecessorStorePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  return consultPredecessorDuo(
    predecessorStorePath,
    passphrase,
    predecessorDuoDir,
    predecessorName,
    question,
    embeddingProvider,
    inferenceProvider,
    config.confidence,
  );
}
