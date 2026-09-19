import type { DuoConfig } from "../config.js";
import { createLlmAdjudicator, runPairExtraction, type PairExtractionSummary } from "../derivation/qa-pairs.js";
import { ProviderConfigError } from "../provider/types.js";
import { resolveProvider } from "../provider/registry.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

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

  let adjudicate;
  try {
    adjudicate = createLlmAdjudicator(resolveProvider(config));
  } catch (error) {
    if (!(error instanceof ProviderConfigError)) {
      throw error;
    }
    adjudicate = undefined;
  }

  return runPairExtraction(config.storePath, passphrase, { adjudicate });
}
