import type { DuoConfig } from "../config.js";
import { assertOwnerConsultable } from "../continuity/lifecycle.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { listDrafts, type DraftOutcome, type DraftRecord, type ListDraftsOptions } from "../drafting/draft-log.js";
import { draftReply, type DraftPipelineResult } from "../drafting/pipeline.js";
import { queueStandingOrderCandidate } from "../drafting/standing-order-candidates.js";
import { createLlmEditClassifier, recordDraftOutcomeAndClassify, type ClassifyAndQueueResult } from "../corrections/classify.js";
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
  // #63 AC1/AC4: an archived or orphaned duo refuses to draft a new,
  // present-tense answer at all — checked first, before any retrieval or
  // generation, the same "escalate/refuse without reasoning about it"
  // placement #34's refusal check uses.
  assertOwnerConsultable(config.duoDir);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  return draftReply(config.storePath, passphrase, config.duoDir, question, threadContext, embeddingProvider, inferenceProvider, config.confidence);
}

/**
 * Implements `duo draft-outcome <draftId> <sent|edited|discarded> [sentText]`
 * (#32 AC3). When the outcome is "edited" and the owner supplied the text
 * they actually sent, this also runs the correction loop's classification
 * (#37, v1-tech-design.md §1.9) as an immediate side effect of recording
 * the outcome — it only ever queues candidates, never writes to
 * `duo/rules/` or `duo/voice.md` ("queue it; do not write immediately"),
 * so running it eagerly here is safe. The orchestration itself lives in
 * `recordDraftOutcomeAndClassify` (corrections/classify.ts), parameterized
 * on an explicit passphrase rather than one resolved here — this function's
 * whole job is resolving that passphrase and the provider from `config`.
 */
export async function runRecordDraftOutcome(
  draftId: string,
  outcome: DraftOutcome,
  config: DuoConfig,
  sentText?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClassifyAndQueueResult | undefined> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const provider = tryResolveProvider(config);
  const classifier = provider ? createLlmEditClassifier(provider) : undefined;
  return recordDraftOutcomeAndClassify(config.storePath, passphrase, draftId, outcome, sentText, classifier);
}

/** Implements `duo draft-answer <draftId> <answer>` (#34 AC3): turns an escalation the owner knows the answer to into a queued standing-order candidate. */
export function runRecordEscalationAnswer(draftId: string, answerText: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): string {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return queueStandingOrderCandidate(config.storePath, passphrase, draftId, answerText);
}

/**
 * Implements `duo drafts list [--pending] [--outcome <outcome>] [--limit <n>]`
 * — the gap `client-tech-design.md` G-a names: `listDrafts` was exported
 * and tested but reachable from no CLI command, and the Review surface's
 * whole read side is built on it.
 */
export function runDraftsList(config: DuoConfig, options: ListDraftsOptions = {}, env: NodeJS.ProcessEnv = process.env): DraftRecord[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listDrafts(config.storePath, passphrase, options);
}
