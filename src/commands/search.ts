import type { DuoConfig } from "../config.js";
import { hybridSearch, type HybridSearchOutcome } from "../ingest/embeddings.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo search <query>`: hybrid full-text + embedding retrieval over the store. */
export async function runSearch(
  query: string,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HybridSearchOutcome> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const provider = createOllamaEmbeddingProvider(config);
  return hybridSearch(config.storePath, passphrase, query, provider);
}
