import type { DuoConfig } from "../config.js";
import { embedRecords, type EmbedRecordsResult } from "../ingest/embeddings.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo embed`: backfills a local Ollama embedding for every record that doesn't have a current one. */
export async function runEmbed(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Promise<EmbedRecordsResult> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const provider = createOllamaEmbeddingProvider(config);
  return embedRecords(config.storePath, passphrase, provider);
}
