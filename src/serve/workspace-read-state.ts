import { isStaleEvent, type DuoReadState } from "../workspace/read-state.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";

/**
 * #189: the durable `DuoReadState` — which workspace events this daemon
 * has already handled, surviving restarts in the same encrypted personal
 * store every other daemon-side table lives in (`withDatabase`, the
 * decrypt-to-temp/re-encrypt dance), not a new storage layer.
 *
 * This file lives in `src/serve/`, not `src/workspace/`, on purpose: the
 * pinned import scan (test/workspace-payload.test.ts) keeps `src/workspace/**`
 * from importing store modules so the corpus boundary holds structurally —
 * the store arrives here by ordinary composition, the same dependency
 * direction the answer pipeline uses. `runServe` constructs this and hands
 * it to the workspace service; the service knows the interface only.
 *
 * The table holds event ids and their homeserver timestamps, nothing
 * readable — it is a read position, not a message store
 * (docs/workspace-platform.md §1). `markRead` prunes rows older than the
 * retention horizon (the backlog age window): beyond it the age policy is
 * the protection, so the table spans exactly the window it needs.
 */
export function ensureWorkspaceReadEventsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_read_events (
      event_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      origin_server_ts INTEGER NOT NULL,
      read_at TEXT NOT NULL
    ) STRICT
  `);
}

interface PendingMark {
  readonly roomId: string;
  readonly originServerTs: number;
}

/**
 * The durable read state over one encrypted store. `retentionMs` is the
 * backlog age window from the workspace settings — rows older than it are
 * pruned on each write, keeping the table bounded by the policy that makes
 * old rows redundant.
 *
 * Every `withDatabase` call is a whole-store round trip (scrypt + decrypt +
 * re-encrypt), so the two hot operations do not pay one per call:
 *
 * - `hasRead` answers from a snapshot of the table's event ids loaded once
 *   at construction. The table is single-writer (only the workspace service
 *   touches it, serialized on its answer chain) and retention-bounded, so
 *   the set fits in memory and a fresh boot pays one decrypt to load it —
 *   the boot `runServe` already pays for its passphrase check anyway.
 * - `markRead` updates the snapshot immediately (a mark is true the moment
 *   it is made) but coalesces the encrypted-store writes: marks made in
 *   the same event-loop turn — exactly the shape of a policy-skipped
 *   sync-replay flood, which decides thousands of events back-to-back —
 *   land in one write. A crash or a failed flush loses marks the replay
 *   would re-decide identically (stale events re-skip; the rate window
 *   re-bounds), the same at-least-once stance read-state.ts states.
 */
export function durableDuoReadState(storePath: string, passphrase: string, retentionMs: number): DuoReadState {
  // event id -> its homeserver timestamp, so the flush can prune the
  // snapshot with the table (below) and the map stays bounded by the same
  // retention the rows are.
  const handled = new Map<string, number>(
    withDatabase(storePath, passphrase, false, (db) => {
      try {
        return (db.prepare("SELECT event_id, origin_server_ts FROM workspace_read_events").all() as {
          event_id: string;
          origin_server_ts: number;
        }[]).map((row) => [row.event_id, row.origin_server_ts] as const);
      } catch (error) {
        // Anything but a healthy read here (first boot before any write
        // created the table, a store that cannot be read) degrades to
        // "nothing handled" — the at-least-once re-answer — but never
        // silently: this is the one load-time error surface.
        console.error(
          "workspace: loading durable read state failed, treating every event as unhandled:",
          error instanceof Error ? error.message : error,
        );
        return [];
      }
    }),
  );

  let pending = new Map<string, PendingMark>();
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    if (pending.size === 0) {
      return;
    }
    const batch = pending;
    pending = new Map();
    const readAt = new Date().toISOString();
    const horizon = Date.now() - retentionMs;
    try {
      withDatabase(storePath, passphrase, true, (db) => {
        ensureWorkspaceReadEventsSchema(db);
        const insert = db.prepare(
          "INSERT OR IGNORE INTO workspace_read_events (event_id, room_id, origin_server_ts, read_at) VALUES (?, ?, ?, ?)",
        );
        for (const [eventId, mark] of batch) {
          insert.run(eventId, mark.roomId, mark.originServerTs, readAt);
        }
        db.prepare("DELETE FROM workspace_read_events WHERE origin_server_ts < ?").run(horizon);
      });
      // Prune the snapshot with the table, under the same horizon: an id
      // aged past retention leaves memory too, so a sustained flood cannot
      // grow the map without bound. An evicted event that somehow replays
      // is re-decided — and it is older than the backlog window by then, so
      // the age policy skips it; the same degradation a restart gets.
      for (const [eventId, ts] of handled) {
        if (ts < horizon) {
          handled.delete(eventId);
        }
      }
    } catch (error) {
      // The flush is asynchronous, so no caller can catch this — the batch's
      // marks are dropped and the events stay unrecorded, which the replay
      // re-decides (stale events re-skip, the rate window re-bounds): the
      // same at-least-once stance a crash before the flush already has.
      console.error(
        `workspace: recording durable read state for ${batch.size} event(s) failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  return {
    hasRead(eventId: string): boolean {
      return handled.has(eventId);
    },

    markRead(roomId: string, eventId: string, originServerTs: number): void {
      if (handled.has(eventId)) {
        return;
      }
      if (isStaleEvent(originServerTs, Date.now(), retentionMs)) {
        // Older than the retention horizon: the row would be pruned by its
        // own write, so neither the snapshot nor a pending mark records it —
        // the age policy decides this event, with or without a row.
        return;
      }
      handled.set(eventId, originServerTs);
      pending.set(eventId, { roomId, originServerTs });
      if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(flush, 0);
      }
    },
  };
}
