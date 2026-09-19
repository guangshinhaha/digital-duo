import type { DuoConfig } from "../config.js";
import { buildInterruptionPortrait, type InterruptionPortrait } from "../derivation/portrait.js";
import { requireStoreExists } from "../store/store.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";

/** Implements `duo mirror portrait` (#27): the onboarding screen, sourced from #23/#24's output only. */
export function runMirrorPortrait(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): InterruptionPortrait {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return buildInterruptionPortrait(config.storePath, passphrase, config.duoDir);
}
