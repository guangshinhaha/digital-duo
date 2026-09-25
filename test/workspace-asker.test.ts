import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { askerContextForSender, localpartOf } from "../src/workspace/asker.js";
import { memberOf } from "./helpers/workspace-member.js";

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
    // The deliberately loose grammar directory.ts documents: a serverless
    // id still yields its localpart exactly as #219 shipped it.
    expect(localpartOf("@alice:")).toBe("alice");
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

describe("askerContextForSender with the workspace member record — the #187 feed, one resolver either way (AC3)", () => {
  it("produces identical outcomes fed and unfed — the existing permissions path is unchanged, pinned", () => {
    const duoDir = writeDirectory([{ id: "bob", name: "Bob", clearance: "official_open", groups: [] }]);
    for (const sender of ["@bob:workspace", "@BOB:workspace", "@stranger:workspace"]) {
      const fed = askerContextForSender(sender, duoDir, memberOf(sender, "Whatever the profile says"));
      const unfed = askerContextForSender(sender, duoDir);
      expect(fed).toEqual(unfed);
    }
  });

  it("never resolves through the member's display name — an asker must not choose their own log identity", () => {
    // The directory knows asker id "bob"; the workspace member is a
    // DIFFERENT user whose self-service display name says "Bob". The
    // display name is not a lookup key, so the ask logs as who they are
    // (unresolved, their full Matrix user id), not as bob.
    const duoDir = writeDirectory([{ id: "bob", name: "Bob", clearance: "official_open", groups: [] }]);
    expect(askerContextForSender("@mallory:workspace", duoDir, memberOf("@mallory:workspace", "Bob"))).toEqual({
      ref: "@mallory:workspace",
      resolved: false,
      askLinkId: null,
    });
  });

  it("a duo-shaped sender resolves as itself or not at all — never credited to its owner (AR-13's direction, inbound)", () => {
    const duoDir = writeDirectory([{ id: "carol", name: "Carol", clearance: "official_open", groups: [] }]);
    expect(askerContextForSender("@duo-carol:workspace", duoDir, memberOf("@duo-carol:workspace", "Carol's duo"))).toEqual({
      ref: "@duo-carol:workspace",
      resolved: false,
      askLinkId: null,
    });
  });

  it("a fed call resolves exactly as the unfed path does — the member record is the feed's surface, not a second resolver", () => {
    const duoDir = writeDirectory([{ id: "bob", name: "Bob", clearance: "official_open", groups: [] }]);
    expect(askerContextForSender("@bob:workspace", duoDir, memberOf("@bob:workspace", "Bob from the directory"))).toEqual({
      ref: "bob",
      resolved: true,
      askLinkId: null,
    });
  });
});
