import type { DuoConfig } from "../config.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { type EnforceCeilingOutcome, enforceClassificationCeiling, parseClassificationCeiling } from "../permissions/classification.js";
import { answerForAsker, type AnswerForAskerResult } from "../permissions/answer.js";
import { type AuditEntry, getAuditEntry, listAuditEntries } from "../permissions/audit.js";
import { answerPublicly, type PublicAnswerOutcome } from "../permissions/public-answer.js";
import { listPublicAnswerLogEntries, type PublicAnswerLogEntry } from "../permissions/public-answer-log.js";
import { correctPublicAnswer, type CorrectPublicAnswerResult } from "../permissions/public-correction.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/**
 * Implements `duo permissions enforce-ceiling` (#48 AC3): re-evaluates
 * every record already in the store against the *currently configured*
 * ceiling and removes anything above it, reporting what was removed
 * rather than leaving it silently reachable under a since-lowered ceiling.
 */
export function runEnforceCeiling(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): EnforceCeilingOutcome {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const ceiling = parseClassificationCeiling(config.classificationCeiling);
  return enforceClassificationCeiling(config.storePath, passphrase, ceiling);
}

/** Implements `duo permissions ask <question> --as <askerId>` (#50): the first real consumer of #49's retrieveForAsker, tying resolution, permission-filtered retrieval, generation, and the audit log together. */
export async function runAskAsAsker(
  question: string,
  askerRef: string,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnswerForAskerResult> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  return answerForAsker(config.storePath, passphrase, config.duoDir, question, askerRef, embeddingProvider, inferenceProvider);
}

/**
 * Implements `duo permissions ask-public <question> --as <askerRef>` (#43):
 * a colleague's question, drafted privately as v1 always does, and posted
 * publicly only when the topic holds T0 autonomy, the evidence clears
 * confidence, and nothing about it is refused. `askerRef` is recorded for
 * the public-answer log only — #43 is explicit that per-asker
 * differentiation is out of scope, so it is never resolved against
 * duo/directory.json here the way `runAskAsAsker` resolves it.
 */
export async function runAnswerPublicly(
  question: string,
  askerRef: string,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicAnswerOutcome> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  return answerPublicly(
    config.storePath,
    passphrase,
    config.duoDir,
    question,
    // #160: the CLI never comes through an ask link and (#43) never
    // resolves the ref against duo/directory.json — both now stated
    // explicitly rather than left implicit in the old bare-string param.
    { ref: askerRef, resolved: null, askLinkId: null },
    embeddingProvider,
    inferenceProvider,
    config.confidence,
    config.ownerName,
  );
}

/**
 * Implements `duo permissions correct <entryId> <correctedText> [--thread-gone]`
 * (#45): corrects a public answer already logged, demoting its topic's T0
 * autonomy immediately and reporting whether the correction could be
 * posted back in the original thread. `--thread-gone` is how the owner
 * tells the CLI what it has no way to check itself (there is no live
 * channel integration yet, epic `e8` stays blocked) — see
 * `correctPublicAnswer`'s own doc comment.
 */
export function runCorrectPublicAnswer(
  entryId: string,
  correctedText: string,
  threadStillExists: boolean,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): CorrectPublicAnswerResult {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return correctPublicAnswer(config.storePath, passphrase, config.duoDir, entryId, correctedText, config.ownerName, threadStillExists);
}

/** Implements `duo permissions log` (#43/#45): every public-answer-log entry, oldest first — how the owner finds an entry id to correct. */
export function runListPublicAnswerLogEntries(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PublicAnswerLogEntry[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listPublicAnswerLogEntries(config.storePath, passphrase);
}

/** Implements `duo permissions audit` (#51 AC1): every audit entry, oldest first — the owner's full list to scan or pipe. */
export function runListAuditEntries(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): AuditEntry[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listAuditEntries(config.storePath, passphrase);
}

/** Implements `duo permissions audit --id <id>` (#51 AC1): one entry in full — everything needed to reconstruct that exact answer. */
export function runShowAuditEntry(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): AuditEntry | undefined {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return getAuditEntry(config.storePath, passphrase, id);
}
