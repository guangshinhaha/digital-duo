import type { DuoConfig } from "../config.js";
import { createLlmAdjudicator, runPairExtraction, type PairExtractionSummary } from "../derivation/qa-pairs.js";
import { createLlmRuleTextGenerator, runRuleInduction, type RuleInductionSummary } from "../derivation/rules.js";
import { createLlmTopicLabeler, runTopicAssignment, type TopicAssignmentResult } from "../derivation/topics.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { ProviderConfigError } from "../provider/types.js";
import { resolveProvider } from "../provider/registry.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Resolves an optional InferenceProvider for a best-effort LLM helper (adjudication, labeling): a missing/misconfigured provider (G1 is unresolved) degrades to the deterministic default rather than failing the whole derivation stage. */
function tryResolveProvider(config: DuoConfig) {
  try {
    return resolveProvider(config);
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Implements `duo derive pairs`. Adjudication is best-effort: if no
 * provider is configured (DUO_PROVIDER unset), extraction still runs, just
 * without an adjudicator — the same "degrade rather than fail" shape #20's
 * hybridSearch uses for its network dependency. A configuration problem is
 * expected here (G1 is unresolved for real inference), not exceptional.
 */
export async function runDerivePairs(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Promise<PairExtractionSummary> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);

  const provider = tryResolveProvider(config);
  const adjudicate = provider ? createLlmAdjudicator(provider) : undefined;

  return runPairExtraction(config.storePath, passphrase, { adjudicate });
}

/**
 * Implements `duo derive topics`. Embeddings run unconditionally (v1-tech-design.md
 * §1.2, same as #20's `duo embed`/`duo search`); the LLM labeler is
 * best-effort exactly like #23's adjudicator.
 */
export async function runDeriveTopics(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Promise<TopicAssignmentResult> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);

  const provider = tryResolveProvider(config);
  const labelTopic = provider ? createLlmTopicLabeler(provider) : undefined;
  const embeddingProvider = createOllamaEmbeddingProvider(config);

  return runTopicAssignment(config.storePath, passphrase, config.duoDir, embeddingProvider, { labelTopic });
}

/**
 * Implements `duo derive rules`. Only the `confirmed`-case rule phrasing is
 * ever handed to an LLM (v1-tech-design.md §1.5 step 3); the deterministic
 * default (the topic's most central answer, verbatim) is used whenever no
 * provider is configured, same best-effort shape as the other derive
 * commands.
 */
export async function runDeriveRules(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Promise<RuleInductionSummary> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);

  const provider = tryResolveProvider(config);
  const generateRuleText = provider ? createLlmRuleTextGenerator(provider) : undefined;
  const embeddingProvider = createOllamaEmbeddingProvider(config);

  return runRuleInduction(config.storePath, passphrase, embeddingProvider, { generateRuleText });
}
