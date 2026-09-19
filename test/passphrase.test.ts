import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { passphraseFilePath, resolveOrCreatePassphrase } from "../src/store/passphrase.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

describe("resolveOrCreatePassphrase", () => {
  it("generates and persists a passphrase next to the store on first use", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const passphrase = resolveOrCreatePassphrase(storePath, {});
    expect(passphrase.length).toBeGreaterThan(20);
    expect(existsSync(passphraseFilePath(storePath))).toBe(true);
  });

  it("persists the passphrase file with owner-only permissions", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    resolveOrCreatePassphrase(storePath, {});
    const mode = statSync(passphraseFilePath(storePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the same passphrase on a second call (idempotent)", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const first = resolveOrCreatePassphrase(storePath, {});
    const second = resolveOrCreatePassphrase(storePath, {});
    expect(second).toBe(first);
  });

  it("prefers DUO_PASSPHRASE from env and never writes it to the passphrase file", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    const passphrase = resolveOrCreatePassphrase(storePath, { DUO_PASSPHRASE: "from-env-do-not-persist" });
    expect(passphrase).toBe("from-env-do-not-persist");
    expect(existsSync(passphraseFilePath(storePath))).toBe(false);
  });

  it("places the passphrase file in the same directory as the store, so both share one ignore rule", () => {
    const storePath = join(tempDir(), "data", "duo.db");
    resolveOrCreatePassphrase(storePath, {});
    const raw = readFileSync(passphraseFilePath(storePath), "utf8");
    expect(raw.trim().length).toBeGreaterThan(0);
    expect(passphraseFilePath(storePath)).toBe(join(tempDir(), "data", ".passphrase"));
  });
});
