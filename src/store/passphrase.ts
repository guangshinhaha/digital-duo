import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const PASSPHRASE_FILE_NAME = ".passphrase";

/**
 * Where the generated passphrase lives: next to the store file, so it
 * inherits the same gitignored data directory rather than needing its own
 * ignore rule.
 */
export function passphraseFilePath(storePath: string): string {
  return join(dirname(storePath), PASSPHRASE_FILE_NAME);
}

/**
 * Resolves the passphrase used to encrypt/decrypt the store at `storePath`.
 *
 * DUO_PASSPHRASE, when set, always wins and is never written to disk by
 * this function — an operator who sets it is managing the secret
 * themselves. Otherwise this reads the persisted passphrase file, or, the
 * first time, generates a random one and persists it with owner-only
 * permissions. Either way, nothing here prints the passphrase or accepts it
 * as a CLI argument, so it never lands in the repo or in shell history by
 * this tool's own doing (AC: "never written into the repository or into
 * shell history by the tool itself").
 */
export function resolveOrCreatePassphrase(storePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DUO_PASSPHRASE;
  if (fromEnv) {
    return fromEnv;
  }

  const keyPath = passphraseFilePath(storePath);
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf8").trim();
  }

  const generated = randomBytes(32).toString("base64url");
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, generated, { mode: 0o600 });
  return generated;
}
