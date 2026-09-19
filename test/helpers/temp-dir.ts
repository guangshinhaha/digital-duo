import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Wires a beforeEach/afterEach pair that creates a fresh temp directory per
 * test and removes it afterward. Returns a getter so callers read the
 * current test's directory rather than capturing a stale reference.
 */
export function useTempDir(prefix = "duo-cli-test-"): () => string {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return () => dir;
}
