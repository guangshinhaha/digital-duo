import type { DuoConfig } from "../config.js";
import {
  approveCandidate,
  listPendingReview,
  rejectCandidate,
  type ApproveCandidateOptions,
  type ApproveCandidateResult,
  type PendingReview,
} from "../corrections/review.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo corrections review` (#38): everything the correction loop has queued since the last review, style and substance alike. */
export function runCorrectionsReview(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PendingReview {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listPendingReview(config.storePath, passphrase, config.duoDir);
}

/** Implements `duo corrections approve <id> [--supersedes <ruleId>]` (#38 AC1, #39 AC3). */
export function runCorrectionsApprove(
  id: string,
  config: DuoConfig,
  options: ApproveCandidateOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ApproveCandidateResult {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return approveCandidate(config.storePath, passphrase, config.duoDir, id, options);
}

/** Implements `duo corrections reject <id>` (#38 AC2). */
export function runCorrectionsReject(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): void {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  rejectCandidate(config.storePath, passphrase, id);
}
