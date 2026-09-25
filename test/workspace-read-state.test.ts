import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { durableDuoReadState, ensureWorkspaceReadEventsSchema } from "../src/serve/workspace-read-state.js";
import { ANSWER_RATE_WINDOW_MS, AnswerRateWindow, InMemoryDuoReadState, isStaleEvent } from "../src/workspace/read-state.js";

/**
 * #189: the durable read state and the backlog policies around it — the
 * work #219's successor notes deferred here. The policy functions are pure
 * (boundary tests need no clock rig); the durable implementation runs
 * against a real encrypted store in a temp dir, the same way the token
 * store's tests exercise theirs, including the restart the in-process FIFO
 * could not survive.
 */

describe("isStaleEvent — the backlog age boundary", () => {
  it("is stale strictly inside the window, fresh at and beyond the boundary", () => {
    const now = 1_758_000_000_000;
    const maxAgeMs = 3_600_000;
    expect(isStaleEvent(now - maxAgeMs - 1, now, maxAgeMs)).toBe(true);
    expect(isStaleEvent(now - maxAgeMs, now, maxAgeMs)).toBe(false);
    expect(isStaleEvent(now, now, maxAgeMs)).toBe(false);
  });
});

describe("AnswerRateWindow — the flood bound", () => {
  it("allows up to the bound per rolling window, then refuses, then allows again once the window slides", () => {
    const window = new AnswerRateWindow(2);
    const start = 1_758_000_000_000;
    expect(window.allows(start)).toBe(true);
    window.record(start);
    expect(window.allows(start + 1000)).toBe(true);
    window.record(start + 1000);
    // Two sends inside one rolling minute: the third is refused.
    expect(window.allows(start + 2000)).toBe(false);
    expect(window.allows(start + 59_999)).toBe(false);
    // The first send ages out of the window exactly one window later.
    expect(window.allows(start + ANSWER_RATE_WINDOW_MS + 1)).toBe(true);
    window.record(start + ANSWER_RATE_WINDOW_MS + 1);
    // And the second send's slot returns a moment after that.
    expect(window.allows(start + ANSWER_RATE_WINDOW_MS + 1001)).toBe(true);
  });

  it("counts only recorded sends — allows() never mutates the window", () => {
    const window = new AnswerRateWindow(1);
    const now = 1_758_000_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(window.allows(now + i)).toBe(true);
    }
    window.record(now);
    expect(window.allows(now + 1)).toBe(false);
  });
});

describe("InMemoryDuoReadState", () => {
  it("remembers marked events and nothing else", () => {
    const readState = new InMemoryDuoReadState();
    expect(readState.hasRead("$1")).toBe(false);
    readState.markRead("!room:workspace", "$1", 1);
    expect(readState.hasRead("$1")).toBe(true);
    expect(readState.hasRead("$2")).toBe(false);
  });
});

describe("durableDuoReadState — the encrypted-store implementation", () => {
  const tempDir = useTempDir();
  const PASSPHRASE = "pw";

  function initStore(): string {
    const storePath = join(tempDir(), "data", "duo.db");
    createEncryptedStore(storePath, PASSPHRASE);
    return storePath;
  }

  interface ReadEventRow {
    event_id: string;
    room_id: string;
    origin_server_ts: number;
    read_at: string;
  }

  function rows(storePath: string): ReadEventRow[] {
    return withDatabase(storePath, PASSPHRASE, false, (db) => {
      ensureWorkspaceReadEventsSchema(db);
      return db.prepare("SELECT * FROM workspace_read_events ORDER BY origin_server_ts, event_id").all() as unknown as ReadEventRow[];
    });
  }

  /** Lets the implementation's next-tick write flush land — marks coalesce by event-loop turn, so tests must let the turn end. */
  async function flushed(): Promise<void> {
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  }

  it("records handled events and remembers them across a restart — the thing the in-process FIFO could not do", async () => {
    const storePath = initStore();
    durableDuoReadState(storePath, PASSPHRASE, 3_600_000).markRead("!dm:workspace", "$q1", Date.now());
    await flushed();
    // A "restart": a fresh instance over the same encrypted store, whose
    // construction-time snapshot loads what the previous process wrote.
    expect(durableDuoReadState(storePath, PASSPHRASE, 3_600_000).hasRead("$q1")).toBe(true);
    expect(durableDuoReadState(storePath, PASSPHRASE, 3_600_000).hasRead("$other")).toBe(false);
  });

  it("marks idempotently — one row per event no matter how many replays record it", async () => {
    const storePath = initStore();
    const readState = durableDuoReadState(storePath, PASSPHRASE, 3_600_000);
    const at = Date.now();
    readState.markRead("!dm:workspace", "$q1", at);
    readState.markRead("!dm:workspace", "$q1", at);
    readState.markRead("!dm:workspace", "$q1", at + 1000);
    await flushed();
    expect(rows(storePath)).toHaveLength(1);
  });

  it("stores event ids and homeserver timestamps only — a read position, not a message store (decision record §1)", async () => {
    const storePath = initStore();
    durableDuoReadState(storePath, PASSPHRASE, 3_600_000).markRead("!dm:workspace", "$q1", Date.now());
    await flushed();
    const row = rows(storePath)[0]!;
    expect(Object.keys(row).sort()).toEqual(["event_id", "origin_server_ts", "read_at", "room_id"]);
    expect(JSON.stringify(row)).not.toContain("body");
  });

  it("prunes rows older than the retention horizon on write — beyond the window, the age policy is the protection, not the table", async () => {
    const storePath = initStore();
    const readState = durableDuoReadState(storePath, PASSPHRASE, 3_600_000);
    const now = Date.now();
    readState.markRead("!dm:workspace", "$fresh", now);
    readState.markRead("!dm:workspace", "$ancient", now - 3_600_001);
    await flushed();
    // The ancient mark never became a row (it is older than the horizon —
    // the write would prune it immediately); the fresh one stands.
    expect(readState.hasRead("$fresh")).toBe(true);
    expect(readState.hasRead("$ancient")).toBe(false);
    expect(rows(storePath).map((row) => row.event_id)).toEqual(["$fresh"]);
  });

  it("prunes rows an older-retention instance left behind — the table AND the in-memory snapshot shrink under the tighter horizon", async () => {
    const storePath = initStore();
    const now = Date.now();
    // Process A keeps an hour: an event half an hour old lands as a row.
    durableDuoReadState(storePath, PASSPHRASE, 3_600_000).markRead("!dm:workspace", "$halfhour", now - 1_800_000);
    await flushed();
    expect(rows(storePath).map((row) => row.event_id)).toEqual(["$halfhour"]);
    // Process B keeps ten minutes over the same store: it loads the row
    // into its snapshot, then its first write prunes everything older than
    // its horizon — the SQL delete and the Map eviction together, so a
    // horizon-tightening restart cannot leave the snapshot growing rows
    // the table no longer has.
    const tighter = durableDuoReadState(storePath, PASSPHRASE, 600_000);
    expect(tighter.hasRead("$halfhour")).toBe(true);
    tighter.markRead("!dm:workspace", "$fresh", now);
    await flushed();
    expect(rows(storePath).map((row) => row.event_id)).toEqual(["$fresh"]);
    expect(tighter.hasRead("$halfhour")).toBe(false);
  });

  it("logs and drops the batch when the flush fails — the marks stay unrecorded, the replay re-decides, nothing throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const storePath = initStore();
    const readState = durableDuoReadState(storePath, PASSPHRASE, 3_600_000);
    readState.markRead("!dm:workspace", "$q1", Date.now());
    // The store vanishes before the coalesced write's turn (deleted
    // synchronously, so the already-armed flush timer cannot win the race):
    // the flush's whole-store round trip fails asynchronously, where no
    // caller could catch it — the failure must surface as a log, never an
    // unhandled error, and the dropped batch is the at-least-once stance.
    rmSync(storePath, { force: true });
    await flushed();
    const logged = consoleError.mock.calls.map((call) => `${String(call[0])}${call[1] === undefined ? "" : ` ${String(call[1])}`}`);
    expect(logged.some((line) => line.includes("recording durable read state for 1 event(s) failed"))).toBe(true);
    // In-process the mark still holds (it was true the moment it was made);
    // a restart is what re-decides it, finding nothing recorded.
    expect(readState.hasRead("$q1")).toBe(true);
  });

  it("hasRead never writes — it answers from the snapshot, and creates no rows", () => {
    const storePath = initStore();
    const readState = durableDuoReadState(storePath, PASSPHRASE, 3_600_000);
    expect(readState.hasRead("$nothing")).toBe(false);
    expect(rows(storePath)).toEqual([]);
  });

  it("hasRead is true the moment the mark is made, before the coalesced write lands — a flood's marks all hold in-process", async () => {
    const storePath = initStore();
    const readState = durableDuoReadState(storePath, PASSPHRASE, 3_600_000);
    const now = Date.now();
    // The flood shape: many marks inside one event-loop turn, before the
    // next-tick flush can run.
    readState.markRead("!dm:workspace", "$flood-1", now);
    readState.markRead("!dm:workspace", "$flood-2", now + 1);
    expect(readState.hasRead("$flood-1")).toBe(true);
    expect(readState.hasRead("$flood-2")).toBe(true);
    expect(rows(storePath)).toEqual([]);
    await flushed();
    expect(rows(storePath).map((row) => row.event_id)).toEqual(["$flood-1", "$flood-2"]);
  });
});
