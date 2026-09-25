import type { DuoConfig } from "../config.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
import { assertServableHost } from "../serve/bind.js";
import { resolvePassphraseForServing } from "../serve/passphrase.js";
import { createServer, type ServeDeps } from "../serve/server.js";
import {
  createAskToken,
  createDeviceToken,
  listAskTokens,
  listDeviceTokens,
  revokeAskToken,
  revokeDeviceToken,
  type AskToken,
  type DeviceToken,
  type MintedAskLink,
  type PairedDevice,
} from "../serve/tokens.js";
import { DecryptionError } from "../store/crypto.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists, withDatabase } from "../store/store.js";

/** Thrown by `runServe` when the resolved passphrase doesn't decrypt the store — checked once at boot, before binding, so a typo'd `DUO_PASSPHRASE` fails loudly here instead of the daemon reporting "listening" and then 500ing every request forever (every route's first real store access would otherwise be the first place this surfaces). */
export class ServePassphraseMismatchError extends Error {
  constructor(storePath: string, cause: DecryptionError) {
    super(`The passphrase for "${storePath}" is wrong: ${cause.message}`);
    this.name = "ServePassphraseMismatchError";
  }
}

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
  try {
    withDatabase(config.storePath, passphrase, false, () => {});
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new ServePassphraseMismatchError(config.storePath, error);
    }
    throw error;
  }

  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);

  const deps: ServeDeps = {
    storePath: config.storePath,
    passphrase,
    duoDir: config.duoDir,
    lifecycleLogPath: config.lifecycleLogPath,
    embeddingProvider,
    inferenceProvider,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: config.ownerName,
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

// `duo ask-link` (issue #158) mints a second token kind, not a device token
// with a permission flag: an ask link is short-lived and ask-only, and lives
// in its own `ask_tokens` table so it is structurally never a PairedDevice
// (`duo pair list` reads `device_tokens` and cannot see these). The expiry
// arithmetic (default 24h, `--expires-in-hours`) is the CLI edge's job
// (KTD4) — this layer takes the ISO-8601 instant as given.

/** Implements `duo ask-link new <name>`: mints a short-lived, ask-only link and returns it exactly once — the raw token is never persisted anywhere in recoverable form. */
export function runAskLink(name: string, expiresAt: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): MintedAskLink {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return createAskToken(config.storePath, passphrase, name, expiresAt);
}

/** Implements `duo ask-link list` — oldest first, revoked and expired included; no token value is ever listed. */
export function runAskLinkList(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): AskToken[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listAskTokens(config.storePath, passphrase);
}

/** Implements `duo ask-link revoke <id>`. Immediate; revoking an already-revoked link is a no-op, not an error. */
export function runAskLinkRevoke(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): void {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  revokeAskToken(config.storePath, passphrase, id);
}
