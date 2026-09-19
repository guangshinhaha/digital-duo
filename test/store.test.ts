import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecryptionError } from "../src/store/crypto.js";
import {
  createEncryptedStore,
  dataDirFor,
  decryptAndOpen,
  deleteStoreFiles,
  listStoreFiles,
  UnsafeStorePathError,
} from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const SQLITE_MAGIC = "SQLite format 3\0";

describe("createEncryptedStore", () => {
  it("creates a file at storePath", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    expect(existsSync(storePath)).toBe(true);
  });

  it("writes ciphertext, not a readable SQLite file, at rest", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    const bytes = readFileSync(storePath);
    expect(bytes.subarray(0, SQLITE_MAGIC.length).toString("latin1")).not.toBe(SQLITE_MAGIC);
  });

  it("leaves no plaintext temp file or SQLite side files behind", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    expect(existsSync(`${storePath}.plaintext-tmp`)).toBe(false);
    expect(existsSync(`${storePath}.plaintext-tmp-journal`)).toBe(false);
    expect(existsSync(`${storePath}.plaintext-tmp-wal`)).toBe(false);
    expect(existsSync(`${storePath}.plaintext-tmp-shm`)).toBe(false);
  });

  it("is a real SQLite database underneath: decrypting with the right passphrase opens it and finds one meta row", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    expect(decryptAndOpen(storePath, "pw")).toEqual({ metaRowCount: 1 });
  });

  it("refuses to open with the wrong passphrase", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    expect(() => decryptAndOpen(storePath, "wrong")).toThrow(DecryptionError);
  });
});

describe("listStoreFiles / deleteStoreFiles", () => {
  it("lists no files when the data directory doesn't exist", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    expect(listStoreFiles(storePath)).toEqual([]);
  });

  it("lists every file under the data directory, relative and sorted", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    writeFileSync(join(dataDirFor(storePath), ".passphrase"), "pw");
    expect(listStoreFiles(storePath)).toEqual(["duo.db", ".passphrase"].sort());
  });

  it("deleteStoreFiles removes the whole data directory, leaving nothing recoverable", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, "pw");
    deleteStoreFiles(storePath);
    expect(existsSync(dataDirFor(storePath))).toBe(false);
    expect(listStoreFiles(storePath)).toEqual([]);
  });

  it("deleteStoreFiles on an already-absent data directory doesn't throw", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    expect(() => deleteStoreFiles(storePath)).not.toThrow();
  });
});

describe("safety: never treat cwd, home, or filesystem root as the data directory", () => {
  // A bare filename with no directory component makes dirname() resolve to
  // ".", i.e. the real process.cwd() of this test run (the repo root) —
  // exactly the dangerous case these guards exist for. Both assertions
  // must throw *before* touching the filesystem, or this test would be
  // writing into/deleting the repo itself.
  const dangerousStorePath = "duo.db";

  it("createEncryptedStore refuses a storePath with no directory component", () => {
    expect(() => createEncryptedStore(dangerousStorePath, "pw")).toThrow(UnsafeStorePathError);
    expect(existsSync(dangerousStorePath)).toBe(false);
  });

  it("deleteStoreFiles refuses the same unsafe path rather than deleting the cwd", () => {
    expect(() => deleteStoreFiles(dangerousStorePath)).toThrow(UnsafeStorePathError);
  });
});
