import type { DuoConfig } from "../config.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { recordDraftOutcome, type DraftOutcome } from "../drafting/draft-log.js";
import { draftReply, type DraftPipelineResult } from "../drafting/pipeline.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo draft <question>` (#32): the CLI surface that closes the correction loop before any Slack app is approved (AR-4). */
export async function runDraft(
  question: string,
  threadContext: string | null,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DraftPipelineResult> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  return draftReply(config.storePath, passphrase, config.duoDir, question, threadContext, embeddingProvider, inferenceProvider, config.confidence);
}

/** Implements `duo draft-outcome <draftId> <sent|edited|discarded>` (#32 AC3). */
export function runRecordDraftOutcome(draftId: string, outcome: DraftOutcome, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): void {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  recordDraftOutcome(config.storePath, passphrase, draftId, outcome);
}
