import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveClearance, InvalidDirectoryError, loadDirectory, resolveAsker } from "../src/permissions/directory.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();

function duoDir(): string {
  return join(tempDir(), "duo");
}

function writeDirectoryFile(dir: string, contents: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "directory.json"), JSON.stringify(contents), "utf8");
}

describe("loadDirectory", () => {
  it("returns an empty roster when duo/directory.json (or the directory) doesn't exist yet", () => {
    expect(loadDirectory(duoDir())).toEqual([]);
  });

  it("reads a well-formed roster, defaulting groups to an empty array when absent", () => {
    const dir = duoDir();
    writeDirectoryFile(dir, [
      { id: "alice", name: "Alice", clearance: "restricted", groups: ["engineering"] },
      { id: "bob", name: "Bob", clearance: "official_open" },
    ]);
    const directory = loadDirectory(dir);
    expect(directory).toEqual([
      { id: "alice", name: "Alice", clearance: "restricted", groups: ["engineering"] },
      { id: "bob", name: "Bob", clearance: "official_open", groups: [] },
    ]);
  });

  it("rejects a non-array file", () => {
    const dir = duoDir();
    writeDirectoryFile(dir, { not: "an array" });
    expect(() => loadDirectory(dir)).toThrow(InvalidDirectoryError);
  });

  it("rejects an entry with an invalid clearance, naming the entry", () => {
    const dir = duoDir();
    writeDirectoryFile(dir, [{ id: "carol", name: "Carol", clearance: "top-secret" }]);
    expect(() => loadDirectory(dir)).toThrow(/carol/);
  });

  it("rejects an entry missing id or name", () => {
    const dir = duoDir();
    writeDirectoryFile(dir, [{ name: "No Id", clearance: "restricted" }]);
    expect(() => loadDirectory(dir)).toThrow(InvalidDirectoryError);
  });
});

describe("resolveAsker", () => {
  const directory = [{ id: "alice", name: "Alice", clearance: "restricted" as const, groups: [] }];

  it("resolves a known asker, matching case-insensitively", () => {
    expect(resolveAsker("ALICE", directory)).toEqual({ resolved: true, identity: directory[0] });
  });

  it("comes back unresolved for an asker not in the directory, rather than throwing", () => {
    expect(resolveAsker("mallory", directory)).toEqual({ resolved: false, askerRef: "mallory" });
  });
});

describe("effectiveClearance", () => {
  it("uses the resolved identity's own clearance", () => {
    const resolution = resolveAsker("alice", [{ id: "alice", name: "Alice", clearance: "confidential" as const, groups: [] }]);
    expect(effectiveClearance(resolution)).toBe("confidential");
  });

  it("gives an unresolvable asker the lowest defined clearance — the most restrictive treatment (#49 AC2)", () => {
    const resolution = resolveAsker("mallory", []);
    expect(effectiveClearance(resolution)).toBe("official_open");
  });
});
