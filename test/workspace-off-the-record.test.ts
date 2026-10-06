import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRoomOffTheRecord,
  InvalidOffTheRecordError,
  isRoomOffTheRecord,
  markRoomOffTheRecord,
  offTheRecordEntryFor,
  readOffTheRecordRooms,
} from "../src/workspace/off-the-record.js";
import { useTempDir } from "./helpers/temp-dir.js";

/**
 * guangshinhaha/duo#274's record module against a real
 * `duo/off-the-record.json` on disk — the owner's own surface, pinned the
 * same way `workspace-consent.test.ts` pins `room-consent.json`.
 */

const tempDir = useTempDir("duo-off-the-record-test-");

function duoDir(): string {
  return tempDir();
}

describe("readOffTheRecordRooms — a missing record is the safe default, a malformed one is an error", () => {
  it("returns [] when neither the file nor the directory exists — nothing is off the record yet", () => {
    expect(readOffTheRecordRooms(join(duoDir(), "never-created"))).toEqual([]);
    expect(readOffTheRecordRooms(duoDir())).toEqual([]);
  });

  it("refuses a non-array JSON value, by name and reason", () => {
    const dir = duoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "off-the-record.json"), "{}", "utf8");
    expect(() => readOffTheRecordRooms(dir)).toThrow(InvalidOffTheRecordError);
    expect(() => readOffTheRecordRooms(dir)).toThrow(/expected a JSON array/);
  });

  it("refuses an entry missing roomId or decidedAt", () => {
    const dir = duoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "off-the-record.json"), JSON.stringify([{ roomId: "" }]), "utf8");
    expect(() => readOffTheRecordRooms(dir)).toThrow(/missing a non-empty "roomId"/);

    writeFileSync(join(dir, "off-the-record.json"), JSON.stringify([{ roomId: "!a:workspace" }]), "utf8");
    expect(() => readOffTheRecordRooms(dir)).toThrow(/missing a non-empty "decidedAt"/);
  });
});

describe("markRoomOffTheRecord / clearRoomOffTheRecord — idempotent, reversible, exact-id matched", () => {
  it("marks a room off the record and reads it back", () => {
    const dir = duoDir();
    const entry = markRoomOffTheRecord(dir, "!a:workspace");
    expect(entry.roomId).toBe("!a:workspace");
    expect(isRoomOffTheRecord(dir, "!a:workspace")).toBe(true);
    expect(readOffTheRecordRooms(dir)).toEqual([entry]);
  });

  it("re-marking an already off-the-record room is a no-op — keeps the original decidedAt", () => {
    const dir = duoDir();
    const first = markRoomOffTheRecord(dir, "!a:workspace");
    const second = markRoomOffTheRecord(dir, "!a:workspace");
    expect(second).toEqual(first);
    expect(readOffTheRecordRooms(dir)).toHaveLength(1);
  });

  it("is case-sensitive and exact — a near-identical id is a different room", () => {
    const dir = duoDir();
    markRoomOffTheRecord(dir, "!a:workspace");
    expect(isRoomOffTheRecord(dir, "!A:workspace")).toBe(false);
    expect(isRoomOffTheRecord(dir, "!a:workspace2")).toBe(false);
  });

  it("clears a marked room and reports wasOn honestly", () => {
    const dir = duoDir();
    markRoomOffTheRecord(dir, "!a:workspace");
    expect(clearRoomOffTheRecord(dir, "!a:workspace")).toEqual({ wasOn: true, rooms: [] });
    expect(isRoomOffTheRecord(dir, "!a:workspace")).toBe(false);
  });

  it("clearing a room that was never marked is a no-op, not an error", () => {
    const dir = duoDir();
    expect(clearRoomOffTheRecord(dir, "!never:workspace")).toEqual({ wasOn: false, rooms: [] });
  });

  it("offTheRecordEntryFor returns null for an unmarked room", () => {
    const dir = duoDir();
    expect(offTheRecordEntryFor(dir, "!a:workspace")).toBeNull();
    markRoomOffTheRecord(dir, "!a:workspace");
    expect(offTheRecordEntryFor(dir, "!a:workspace")?.roomId).toBe("!a:workspace");
  });

  it("leaves other rooms' marks untouched", () => {
    const dir = duoDir();
    markRoomOffTheRecord(dir, "!a:workspace");
    markRoomOffTheRecord(dir, "!b:workspace");
    clearRoomOffTheRecord(dir, "!a:workspace");
    expect(isRoomOffTheRecord(dir, "!b:workspace")).toBe(true);
    expect(isRoomOffTheRecord(dir, "!a:workspace")).toBe(false);
  });
});
