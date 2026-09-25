import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { askerContextForSender, localpartOf } from "../src/workspace/asker.js";

const tempDir = useTempDir();

function writeDirectory(entries: unknown[]): string {
  const duoDir = join(tempDir(), "duo");
  mkdirSync(duoDir, { recursive: true });
  writeFileSync(join(duoDir, "directory.json"), JSON.stringify(entries), "utf8");
  return duoDir;
}

describe("localpartOf", () => {
  it("extracts the localpart of a Matrix user id", () => {
    expect(localpartOf("@alice:workspace")).toBe("alice");
    expect(localpartOf("@duo-alice:workspace.example")).toBe("duo-alice");
  });

  it("passes anything un-shaped through unchanged, to simply fail resolution downstream", () => {
    expect(localpartOf("alice")).toBe("alice");
    expect(localpartOf("")).toBe("");
  });
});

describe("askerContextForSender — the asking Matrix user through the EXISTING directory resolution (#186 AC3)", () => {
  it("resolves a sender whose localpart matches a directory id, case-insensitively, logging the canonical id", () => {
    const duoDir = writeDirectory([{ id: "bob", name: "Bob", clearance: "official_open", groups: [] }]);
    expect(askerContextForSender("@BOB:workspace", duoDir)).toEqual({ ref: "bob", resolved: true, askLinkId: null });
  });

  it("logs the full Matrix user id when the sender resolves to nobody — most restrictive treatment, never an error", () => {
    const duoDir = writeDirectory([{ id: "bob", name: "Bob", clearance: "official_open", groups: [] }]);
    expect(askerContextForSender("@stranger:workspace", duoDir)).toEqual({
      ref: "@stranger:workspace",
      resolved: false,
      askLinkId: null,
    });
  });

  it("resolves against an absent directory as unresolved — the #49 safe default", () => {
    expect(askerContextForSender("@bob:workspace", join(tempDir(), "elsewhere"))).toEqual({
      ref: "@bob:workspace",
      resolved: false,
      askLinkId: null,
    });
  });

  it("degrades a malformed directory to the raw sender id rather than failing the ask — identity resolution never turns an answer into an error", () => {
    const duoDir = join(tempDir(), "broken");
    mkdirSync(duoDir, { recursive: true });
    writeFileSync(join(duoDir, "directory.json"), "{not json", "utf8");
    expect(askerContextForSender("@bob:workspace", duoDir)).toEqual({ ref: "@bob:workspace", resolved: false, askLinkId: null });
  });

  it("never carries an ask link — workspace asks are not ask-link asks", () => {
    const duoDir = writeDirectory([{ id: "bob", name: "Bob", clearance: "official_open", groups: [] }]);
    expect(askerContextForSender("@bob:workspace", duoDir).askLinkId).toBeNull();
  });
});
