import type { DuoConfig } from "../config.js";
import { type EnforceCeilingOutcome, enforceClassificationCeiling, parseClassificationCeiling } from "../permissions/classification.js";
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
