import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { decrypt, encrypt } from "./crypto.js";

// node:sqlite is still experimental (Node 22.5+) and warns as soon as it is
// loaded, so the listener below must be registered before the lazy
// require() calls in this file ever run — that's the only reason it's a
// lazy require() via createRequire rather than a static ESM import.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  const isSqliteExperimentalWarning = warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message);
  if (!isSqliteExperimentalWarning) {
    console.error(warning);
  }
});

const require = createRequire(import.meta.url);

/** Lazily loads node:sqlite after the warning suppression above is in place. */
function loadSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

/** The directory that holds the store file, its passphrase, and any staging databases — everything `duo purge` removes. */
export function dataDirFor(storePath: string): string {
  return dirname(storePath);
}

/**
 * Thrown instead of touching the filesystem when `storePath`'s directory
 * resolves to somewhere `duo purge` must never recursively delete.
 */
export class UnsafeStorePathError extends Error {
  constructor(dataDir: string) {
    super(
      `Refusing to use "${dataDir}" as the store's data directory: it is the current directory, the home ` +
        `directory, or the filesystem root. Set DUO_STORE_PATH to a file inside its own dedicated ` +
        `subdirectory (e.g. "data/duo.db"), since \`duo purge\` deletes that whole directory.`,
    );
    this.name = "UnsafeStorePathError";
  }
}

/**
 * `duo purge` deletes the entire data directory (see deleteStoreFiles), so
 * that directory must never resolve to somewhere unrelated. A relative
 * DUO_STORE_PATH with no directory component (e.g. "duo.db") makes
 * dirname() return "." — the current working directory — which would turn
 * a routine purge into deleting the whole project or home directory. Both
 * createEncryptedStore and deleteStoreFiles call this first so a dangerous
 * path fails loudly at init time, before there's anything to purge.
 */
export function assertSafeDataDir(storePath: string): string {
  const dataDir = resolve(dataDirFor(storePath));
  const unsafe = new Set([resolve(process.cwd()), resolve(homedir()), resolve("/")]);
  if (unsafe.has(dataDir)) {
    throw new UnsafeStorePathError(dataDir);
  }
  return dataDir;
}

function removeIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Creates a real SQLite database, then encrypts its bytes at rest under
 * `passphrase` and writes only the ciphertext to `storePath` — so a file
 * listing or a plain `sqlite3 data/duo.db` never sees plaintext content.
 * The plaintext is built in a sibling temp file (same gitignored directory)
 * and removed once the encrypted file is written, including any
 * journal/WAL side files SQLite may have created for it.
 */
export function createEncryptedStore(storePath: string, passphrase: string): void {
  mkdirSync(assertSafeDataDir(storePath), { recursive: true });

  const plainPath = `${storePath}.plaintext-tmp`;
  removeIfExists(plainPath);
  try {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(plainPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS duo_store_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        ) STRICT
      `);
      const insert = db.prepare("INSERT OR REPLACE INTO duo_store_meta (key, value) VALUES (?, ?)");
      insert.run("created_at", new Date().toISOString());
    } finally {
      db.close();
    }

    const plaintext = readFileSync(plainPath);
    const encrypted = encrypt(plaintext, passphrase);
    writeFileSync(storePath, encrypted, { mode: 0o600 });
  } finally {
    removeIfExists(plainPath);
    removeIfExists(`${plainPath}-journal`);
    removeIfExists(`${plainPath}-wal`);
    removeIfExists(`${plainPath}-shm`);
  }
}

/**
 * Decrypts the store and opens the result as a real SQLite database,
 * returning the row count of its metadata table. Exists to prove the
 * ciphertext really is a SQLite database underneath — used by tests today;
 * a future read path (once #18 lands an ingest schema) can reuse it instead
 * of re-deriving the decrypt-to-temp-file dance.
 */
export function decryptAndOpen(storePath: string, passphrase: string): { metaRowCount: number } {
  const encrypted = readFileSync(storePath);
  const plaintext = decrypt(encrypted, passphrase);

  const tempPath = `${storePath}.verify-tmp`;
  removeIfExists(tempPath);
  writeFileSync(tempPath, plaintext);
  try {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(tempPath);
    try {
      const rows = db.prepare("SELECT COUNT(*) AS count FROM duo_store_meta").get() as { count: number };
      return { metaRowCount: rows.count };
    } finally {
      db.close();
    }
  } finally {
    removeIfExists(tempPath);
    removeIfExists(`${tempPath}-journal`);
    removeIfExists(`${tempPath}-wal`);
    removeIfExists(`${tempPath}-shm`);
  }
}

function listFilesRecursive(dir: string, base: string = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, base));
    } else if (entry.isFile()) {
      files.push(relative(base, fullPath));
    }
  }
  return files.sort();
}

/**
 * Lists every file that currently lives in the store's data directory —
 * the store itself, the passphrase file, and any staging databases a
 * future ingest phase drops there (v1-tech-design.md §1.4). Paths are
 * relative to the data directory, sorted, so `duo purge`'s description of
 * "what would be deleted" is deterministic.
 */
export function listStoreFiles(storePath: string): string[] {
  const dataDir = dataDirFor(storePath);
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    return [];
  }
  return listFilesRecursive(dataDir);
}

/**
 * Deletes the entire data directory and everything in it — the store,
 * staging databases, and the passphrase file alike — so nothing
 * recoverable remains on disk. Deleting the whole directory (rather than
 * naming files one by one) is deliberate: it purges anything a future
 * ingest phase leaves behind too, without `duo purge` needing to know that
 * phase's file-naming conventions.
 */
export function deleteStoreFiles(storePath: string): void {
  const dataDir = assertSafeDataDir(storePath);
  rmSync(dataDir, { recursive: true, force: true });
}
