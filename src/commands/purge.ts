import type { DuoConfig } from "../config.js";
import { assertSafeDataDir, dataDirFor, deleteStoreFiles, listStoreFiles } from "../store/store.js";

export interface PurgeResult {
  /** Whether `--yes` was passed and deletion actually ran. */
  confirmed: boolean;
  /** The data directory that holds (or held) the store. */
  dataDir: string;
  /** Files under `dataDir`, relative paths, sorted. Deleted when confirmed; merely reported otherwise. */
  paths: string[];
}

/**
 * Implements `duo purge`. Without confirmation this only ever reads the
 * filesystem: it lists what's there and returns, deleting nothing, which is
 * what makes the "describes what would be deleted, exits without deleting
 * anything" acceptance criterion true regardless of caller behavior.
 * Deletion happens only when `confirmed` is true, and removes the whole
 * data directory in one call (see deleteStoreFiles) rather than naming
 * files individually.
 *
 * assertSafeDataDir runs first, before listing anything, so a
 * DUO_STORE_PATH that resolves outside a dedicated subdirectory (e.g. to
 * the current directory) is rejected immediately with a clear error,
 * rather than walked and described as if it were a normal store.
 */
export function runPurge(config: DuoConfig, confirmed: boolean): PurgeResult {
  assertSafeDataDir(config.storePath);
  const dataDir = dataDirFor(config.storePath);
  const paths = listStoreFiles(config.storePath);

  if (confirmed && paths.length > 0) {
    deleteStoreFiles(config.storePath);
  }

  return { confirmed, dataDir, paths };
}
