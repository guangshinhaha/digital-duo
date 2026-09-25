import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forgetRoomDecision,
  InvalidRoomConsentError,
  readRoomConsent,
  recordRoomDecision,
  roomDecisionFor,
  type RoomConsentEntry,
} from "../src/workspace/consent.js";
import { useTempDir } from "./helpers/temp-dir.js";

/**
 * #192's record module against a real `duo/room-consent.json` on disk — the
 * file is the owner's surface, so these tests pin its formatting and failure
 * shapes as literally as its logic.
 */

const tempDir = useTempDir("duo-consent-record-test-");

function duoDir(): string {
  return tempDir();
}

function entry(roomId: string, overrides: Partial<RoomConsentEntry> = {}): RoomConsentEntry {
  return { roomId, status: "allowed", name: "Launch planning", inviterId: "@bob:workspace", joinedMemberCount: 3, decidedAt: "2026-09-25T12:00:00.000Z", ...overrides };
}

describe("readRoomConsent — a missing record is the safe default, a malformed one is an error", () => {
  it("returns [] when neither the file nor the directory exists — a duo nothing has been consented to yet", () => {
    expect(readRoomConsent(join(duoDir(), "never-created"))).toEqual([]);
    expect(readRoomConsent(duoDir())).toEqual([]);
  });

  it("reads back what recordRoomDecision wrote, including a hand-edited file", () => {
    const dir = duoDir();
    recordRoomDecision(dir, entry("!b:workspace"));
    recordRoomDecision(dir, entry("!a:workspace", { status: "refused", name: null, joinedMemberCount: null }));
    expect(readRoomConsent(dir)).toEqual([
      entry("!a:workspace", { status: "refused", name: null, joinedMemberCount: null }),
      entry("!b:workspace"),
    ]);
  });

  it("refuses anything that is not a JSON array of well-formed entries — by name and reason", () => {
    const dir = duoDir();
    for (const [raw, reason] of [
      ["{}", "expected a JSON array"],
      ["[{\"roomId\": \"\"}]", "missing a non-empty \"roomId\""],
      ["[{\"roomId\": \"!r:workspace\", \"status\": \"maybe\"}]", "invalid \"status\""],
      ["[{\"roomId\": \"!r:workspace\", \"status\": \"allowed\"}]", "missing a non-empty \"decidedAt\""],
      ["[{\"roomId\": \"!r:workspace\", \"status\": \"allowed\", \"decidedAt\": \"x\", \"joinedMemberCount\": 2.5}]", "not an integer or null"],
      ["[null]", "not an object"],
    ] as const) {
      writeRecord(dir, raw);
      expect(() => readRoomConsent(dir), raw).toThrow(InvalidRoomConsentError);
      expect(() => readRoomConsent(dir), raw).toThrow(new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("lets the platform's own parse error through for text that is not JSON at all — the directory/mutes convention", () => {
    const dir = duoDir();
    writeRecord(dir, "not json");
    expect(() => readRoomConsent(dir)).not.toThrow(InvalidRoomConsentError);
    expect(() => readRoomConsent(dir)).toThrow();
  });

  it("tolerates a hand-edited file: extra keys are ignored, undefined nulls are nulls", () => {
    const dir = duoDir();
    writeRecord(dir, "[{\"roomId\":\"!r:workspace\",\"status\":\"withdrawn\",\"decidedAt\":\"x\",\"inviterId\":\"@bob:workspace\",\"handNote\":\"decided at the kitchen table\"}]");
    expect(readRoomConsent(dir)).toEqual([entry("!r:workspace", { status: "withdrawn", decidedAt: "x", name: null, inviterId: "@bob:workspace", joinedMemberCount: null })]);
  });
});

describe("recordRoomDecision — one owner, one standing decision per room", () => {
  it("upserts: the latest decision for a room replaces the previous one", () => {
    const dir = duoDir();
    recordRoomDecision(dir, entry("!r:workspace"));
    recordRoomDecision(dir, entry("!r:workspace", { status: "withdrawn", decidedAt: "2026-09-25T13:00:00.000Z" }));
    expect(readRoomConsent(dir)).toEqual([entry("!r:workspace", { status: "withdrawn", decidedAt: "2026-09-25T13:00:00.000Z" })]);
  });

  it("writes the hand-reviewable formatting: sorted by room id, 2-space indent, trailing newline", () => {
    const dir = duoDir();
    recordRoomDecision(dir, entry("!b:workspace"));
    recordRoomDecision(dir, entry("!a:workspace"));
    const path = join(dir, "room-consent.json");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify([entry("!a:workspace"), entry("!b:workspace")], null, 2)}\n`,
    );
  });

  it("creates the duo directory when it does not exist yet", () => {
    const dir = join(duoDir(), "made", "on", "first", "decision");
    recordRoomDecision(dir, entry("!r:workspace"));
    expect(readRoomConsent(dir)).toEqual([entry("!r:workspace")]);
  });
});

describe("forgetRoomDecision — deletion is the mark of an executed exit", () => {
  it("deletes the room's entry and reports what left", () => {
    const dir = duoDir();
    recordRoomDecision(dir, entry("!a:workspace"));
    recordRoomDecision(dir, entry("!b:workspace"));
    const { entry: removed, rooms } = forgetRoomDecision(dir, "!a:workspace");
    expect(removed).toEqual(entry("!a:workspace"));
    expect(rooms.map((room) => room.roomId)).toEqual(["!b:workspace"]);
    expect(readRoomConsent(dir)).toEqual([entry("!b:workspace")]);
  });

  it("is honest about nothing-to-delete — the unmute convention", () => {
    const dir = duoDir();
    recordRoomDecision(dir, entry("!a:workspace"));
    const { entry: removed, rooms } = forgetRoomDecision(dir, "!never:workspace");
    expect(removed).toBeNull();
    expect(rooms).toEqual([entry("!a:workspace")]);
    expect(readRoomConsent(dir)).toEqual([entry("!a:workspace")]);
  });
});

describe("roomDecisionFor — the gate's one pure read", () => {
  const entries = [entry("!allowed:workspace"), entry("!refused:workspace", { status: "refused" }), entry("!withdrawn:workspace", { status: "withdrawn" })];

  it("returns the standing decision for a room, and null when there is none", () => {
    expect(roomDecisionFor(entries, "!allowed:workspace")).toBe("allowed");
    expect(roomDecisionFor(entries, "!refused:workspace")).toBe("refused");
    expect(roomDecisionFor(entries, "!withdrawn:workspace")).toBe("withdrawn");
    expect(roomDecisionFor(entries, "!never:workspace")).toBeNull();
    expect(roomDecisionFor([], "!allowed:workspace")).toBeNull();
  });

  it("matches room ids exactly, case-sensitively — a near-identical id is a different room", () => {
    expect(roomDecisionFor(entries, "!ALLOWED:workspace")).toBeNull();
    expect(roomDecisionFor(entries, "!allowed:workspace ")).toBeNull();
  });
});

/** Writes the record file verbatim — the wire/hand-edit surface under test. */
function writeRecord(dir: string, raw: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "room-consent.json"), raw, "utf8");
}
