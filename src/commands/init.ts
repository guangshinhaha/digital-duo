import { existsSync } from "node:fs";
import type { DuoConfig } from "../config.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { createEncryptedStore } from "../store/store.js";

export interface InitResult {
  /** false when a store already existed at this path and init did nothing to it. */
  created: boolean;
  storePath: string;
}

/**
 * Implements `duo init`. Idempotent by design: an existing store is left
 * untouched and reported as already present, rather than being silently
 * overwritten by a second `duo init` — the destructive path is `duo
 * purge`, not this one.
 */
export function runInit(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): InitResult {
  if (existsSync(config.storePath)) {
    return { created: false, storePath: config.storePath };
  }
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  createEncryptedStore(config.storePath, passphrase);
  return { created: true, storePath: config.storePath };
}
