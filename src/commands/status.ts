import { existsSync } from "node:fs";
import type { DuoConfig } from "../config.js";
import { describeDuoKnowledge, type DuoKnowledge } from "../duo/knowledge-summary.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { requireStoreExists } from "../store/store.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";

/**
 * Implements `duo status` (R1). Reports the raw configured provider, store
 * location, and whether a file exists there. Never constructs a live
 * provider client (that would make this command capable of throwing) — it
 * always resolves without error, so `duo status` always exits 0 regardless
 * of provider misconfiguration.
 */
export function runStatus(config: DuoConfig): string {
  const providerLine = config.providerName ? `provider: ${config.providerName}` : "provider: (not configured)";
  const storeExists = existsSync(config.storePath);
  return [providerLine, `store: ${config.storePath}`, `store exists: ${storeExists}`].join("\n");
}

/**
 * The providers `duo knowledge` reports (#175): the configured inference
 * provider by name, and the embedding provider by name+model — constructed
 * only to read those two strings, never called. Construction happens in a
 * try/catch because `runStatus`'s own contract (a read-only summary never
 * fails on an unconfigured machine) applies here too: an unconfigured
 * embedding model is reported as "not configured", not thrown.
 */
function knowledgeProviders(config: DuoConfig): DuoKnowledge["providers"] {
  let embedding: DuoKnowledge["providers"]["embedding"] = null;
  try {
    const provider = createOllamaEmbeddingProvider(config);
    embedding = { name: provider.name, model: provider.model };
  } catch {
    // DUO_OLLAMA_EMBEDDING_MODEL unset — honestly reported as null below.
  }
  return { inference: config.providerName ?? null, embedding };
}

/**
 * Implements `duo knowledge` (#175): the owner-facing one-screen summary of
 * what this duo knows. A pure read over `describeDuoKnowledge`'s
 * composition — every line is a fact a module already computed, formatted
 * for a terminal.
 */
export function runKnowledge(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): string {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const knowledge = describeDuoKnowledge(
    config.storePath,
    passphrase,
    config.duoDir,
    knowledgeProviders(config),
    env,
  );

  const lines: string[] = [];

  const bySource = Object.entries(knowledge.records.bySource);
  lines.push(
    bySource.length > 0
      ? `records: ${knowledge.records.total} (${bySource.map(([source, count]) => `${source}: ${count}`).join(", ")})`
      : "records: 0",
  );

  lines.push(
    knowledge.lastImport
      ? `last import: ${knowledge.lastImport.runAt} — ${knowledge.lastImport.written} written, ${knowledge.lastImport.alreadyPresent} already present, ${knowledge.lastImport.discardedOtherText} discarded as other text, ${knowledge.lastImport.discardedAboveCeiling} discarded above ceiling`
      : "last import: never",
  );

  lines.push(
    knowledge.corpus.tooThin
      ? `corpus: ${knowledge.corpus.totalQuestions} question(s) — too thin to characterize (minimum ${knowledge.corpus.minimumQuestionsToCharacterize})`
      : `corpus: ${knowledge.corpus.totalQuestions} question(s) across ${knowledge.corpus.topicBreakdown.length} topic(s), ${knowledge.corpus.periodStart ?? "?"} to ${knowledge.corpus.periodEnd ?? "?"}`,
  );

  const { byReviewStatus } = knowledge.rules;
  lines.push(
    `rules: ${byReviewStatus.approved} approved, ${byReviewStatus.pending} pending, ${byReviewStatus.rejected} rejected, ${byReviewStatus.superseded} superseded`,
  );

  const { inference, embedding } = knowledge.providers;
  lines.push(
    `providers: inference ${inference ?? "(not configured)"}, embedding ${embedding ? `${embedding.name} (${embedding.model})` : "(not configured)"}`,
  );

  lines.push(
    `shared duo: ${knowledge.sharedUsage.summary} (${knowledge.sharedUsage.distinctAskers} asker(s), answer rate ${Math.round(knowledge.sharedUsage.answerRate * 100)}%)`,
  );

  return lines.join("\n");
}
