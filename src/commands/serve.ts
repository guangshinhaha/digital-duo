import type { DuoConfig } from "../config.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { assertServableHost } from "../serve/bind.js";
import { resolvePassphraseForServing } from "../serve/passphrase.js";
import { createServer, type ServeDeps } from "../serve/server.js";
import { createDeviceToken, listDeviceTokens, revokeDeviceToken, type DeviceToken, type PairedDevice } from "../serve/tokens.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

export interface ServeOptions {
  readonly host: string | undefined;
  readonly port: number;
}

/**
 * Implements `duo serve` (`client-tech-design.md` §1.3): resolves the
 * passphrase and providers once, refuses an unsafe bind host, and starts
 * listening. Returns the bound address and a `close` function rather than
 * blocking forever itself, so a test (or a wrapping process) controls the
 * daemon's lifetime rather than this function owning `process` directly.
 */
export async function runServe(
  options: ServeOptions,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ address: string; close: () => Promise<void> }> {
  requireStoreExists(config.storePath);
  assertServableHost(options.host);

  const passphrase = await resolvePassphraseForServing(env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);

  const deps: ServeDeps = {
    storePath: config.storePath,
    passphrase,
    duoDir: config.duoDir,
    embeddingProvider,
    inferenceProvider,
    confidenceConfig: config.confidence,
    env,
  };

  const app = createServer(deps);
  const address = await app.listen({ host: options.host, port: options.port });
  return { address, close: () => app.close() };
}

// `duo pair`/`duo pair list`/`duo pair revoke` are management commands run
// interactively at a terminal, not the daemon itself — they use the
// ordinary CLI passphrase resolution (resolveOrCreatePassphrase, disk
// fallback included), the same as every other `duo mirror`/`duo trust`
// command. Only `duo serve` itself, which holds the passphrase in memory
// behind an open socket, is bound by the no-disk-fallback rule
// (serve/passphrase.ts's resolvePassphraseForServing, used above).

/** Implements `duo pair <name>` (`client-tech-design.md` Part 2): mints a device token and prints it exactly once — it is never persisted anywhere in recoverable form. */
export function runPair(name: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PairedDevice {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return createDeviceToken(config.storePath, passphrase, name);
}

/** Implements `duo pair list`. */
export function runPairList(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): DeviceToken[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listDeviceTokens(config.storePath, passphrase);
}

/** Implements `duo pair revoke <id>`. Immediate; closes that device's ability to authenticate on its very next request. */
export function runPairRevoke(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): void {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  revokeDeviceToken(config.storePath, passphrase, id);
}
