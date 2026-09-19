import type { DuoConfig } from "../config.js";
import {
  assembleEscalationDigest,
  checkUrgentEscalations,
  escalationUrgencyRate,
  listEscalationDigests,
  type AssembleDigestResult,
  type EscalationUrgencyRate,
  type SentEscalationDigest,
  type UrgentEscalationCheckResult,
} from "../escalation/digest.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo escalations check` (#46 AC3): the live-interrupt path — every urgent, unresolved escalation not yet acknowledged. */
export function runEscalationsCheck(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): UrgentEscalationCheckResult {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return checkUrgentEscalations(config.storePath, passphrase);
}

/** Implements `duo escalations digest` (#46 AC1/AC2/AC4): assembles and sends the batched digest, or reports there was nothing to send. */
export function runEscalationsDigest(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): AssembleDigestResult {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return assembleEscalationDigest(config.storePath, passphrase);
}

/** Implements `duo escalations history` — every digest actually sent, oldest first. */
export function runEscalationsHistory(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): SentEscalationDigest[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listEscalationDigests(config.storePath, passphrase);
}

/** Implements `duo escalations rate` (#46 AC3): the all-time urgent share, so drift away from "rare" is visible. */
export function runEscalationsRate(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): EscalationUrgencyRate {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return escalationUrgencyRate(config.storePath, passphrase);
}
