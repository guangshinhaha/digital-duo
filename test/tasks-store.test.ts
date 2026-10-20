import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { InvalidTaskTransitionError } from "../src/tasks/state.js";
import {
  createCard,
  createTask,
  ensureTasksSchema,
  getCard,
  getTask,
  listCards,
  listTasks,
  NonIncreasingRevError,
  updateCardRevAndState,
  updateTaskState,
} from "../src/tasks/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const SQLITE_MAGIC = "SQLite format 3\0";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

describe("ensureTasksSchema — idempotent, encrypted at rest", () => {
  it("creates both tables, and running it twice is a no-op", () => {
    const storePath = initStore();
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensureTasksSchema(db);
      ensureTasksSchema(db);
    });
    const task = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    expect(task.state).toBe("acknowledged");
  });

  it("the store file on disk is not valid SQLite, nor readable plaintext — tasks live in the encrypted store, never a plaintext file", () => {
    const storePath = initStore();
    createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const bytes = readFileSync(storePath);
    expect(bytes.subarray(0, SQLITE_MAGIC.length).toString("latin1")).not.toBe(SQLITE_MAGIC);
    expect(bytes.toString("utf8")).not.toContain("@alice:workspace");
    expect(bytes.toString("utf8")).not.toContain("acknowledged");
  });

  it("leaves no plaintext temp file behind after a task write", () => {
    const storePath = initStore();
    createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    expect(existsSync(`${storePath}.rw-tmp`)).toBe(false);
  });
});

describe("tasks — CRUD round-trips", () => {
  it("creates a task in acknowledged with no draftId, pendingActionId or t4RequestId, and round-trips through getTask", () => {
    const storePath = initStore();
    const created = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    expect(created.state).toBe("acknowledged");
    expect(created.draftId).toBeNull();
    expect(created.pendingActionId).toBeNull();
    expect(created.t4RequestId).toBeNull();
    expect(created.milestoneCount).toBe(0);
    const fetched = getTask(storePath, PASSPHRASE, created.id);
    expect(fetched).toEqual(created);
  });

  it("creates a task with a draftId when given one (the passed_on path)", () => {
    const storePath = initStore();
    const created = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace", draftId: "draft-1" });
    expect(created.draftId).toBe("draft-1");
  });

  it("getTask returns undefined for an unknown id", () => {
    const storePath = initStore();
    expect(getTask(storePath, PASSPHRASE, "ghost")).toBeUndefined();
  });

  it("listTasks returns every task, oldest first, optionally filtered by state", () => {
    const storePath = initStore();
    const a = createTask(storePath, PASSPHRASE, { roomId: "!r1:workspace", questionEventId: "$a", requester: "@alice:workspace" });
    const b = createTask(storePath, PASSPHRASE, { roomId: "!r2:workspace", questionEventId: "$b", requester: "@bob:workspace" });
    updateTaskState(storePath, PASSPHRASE, b.id, "start_working");
    expect(listTasks(storePath, PASSPHRASE).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(listTasks(storePath, PASSPHRASE, "acknowledged").map((t) => t.id)).toEqual([a.id]);
    expect(listTasks(storePath, PASSPHRASE, "working").map((t) => t.id)).toEqual([b.id]);
  });

  it("updateTaskState applies the state machine's transition and persists the result", () => {
    const storePath = initStore();
    const created = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const updated = updateTaskState(storePath, PASSPHRASE, created.id, "start_working");
    expect(updated.state).toBe("working");
    expect(getTask(storePath, PASSPHRASE, created.id)?.state).toBe("working");
  });

  it("updateTaskState refuses an invalid transition and writes nothing", () => {
    const storePath = initStore();
    const created = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    updateTaskState(storePath, PASSPHRASE, created.id, "complete");
    expect(() => updateTaskState(storePath, PASSPHRASE, created.id, "start_working")).toThrow(InvalidTaskTransitionError);
    // Nothing changed — the task is still "done" from the earlier, valid transition.
    expect(getTask(storePath, PASSPHRASE, created.id)?.state).toBe("done");
  });

  it("updateTaskState can set draftId, pendingActionId and t4RequestId alongside a state change", () => {
    const storePath = initStore();
    const created = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const updated = updateTaskState(storePath, PASSPHRASE, created.id, "need_decision", { pendingActionId: "pa-1" });
    expect(updated.state).toBe("needs_decision");
    expect(updated.pendingActionId).toBe("pa-1");
  });

  it("milestone_count increments while below 3 and never exceeds 3", () => {
    const storePath = initStore();
    const created = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    expect(created.milestoneCount).toBe(0);
    let last = created;
    for (let i = 0; i < 5; i += 1) {
      last = updateTaskState(storePath, PASSPHRASE, created.id, undefined, { incrementMilestone: true });
    }
    expect(last.milestoneCount).toBe(3);
    expect(getTask(storePath, PASSPHRASE, created.id)?.milestoneCount).toBe(3);
  });
});

describe("workspace_cards — CRUD round-trips, rev strictly increasing", () => {
  it("creates a card at rev 1 and round-trips through getCard", () => {
    const storePath = initStore();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const card = createCard(storePath, PASSPHRASE, {
      taskId: task.id,
      roomId: "!room:workspace",
      eventId: "$card1",
      kind: "task",
      audience: "visitor",
      state: "acknowledged",
      payloadJson: JSON.stringify({ v: 1, rev: 1 }),
      requester: "@alice:workspace",
    });
    expect(card.rev).toBe(1);
    expect(getCard(storePath, PASSPHRASE, card.id)).toEqual(card);
  });

  it("listCards filters by roomId and audience", () => {
    const storePath = initStore();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const visitorCard = createCard(storePath, PASSPHRASE, {
      taskId: task.id,
      roomId: "!room:workspace",
      eventId: "$card1",
      kind: "task",
      audience: "visitor",
      state: "acknowledged",
      payloadJson: "{}",
      requester: "@alice:workspace",
    });
    const ownerCard = createCard(storePath, PASSPHRASE, {
      taskId: task.id,
      roomId: "!other:workspace",
      eventId: "$card2",
      kind: "task",
      audience: "owner",
      state: "acknowledged",
      payloadJson: "{}",
      requester: "@alice:workspace",
    });
    expect(listCards(storePath, PASSPHRASE, { roomId: "!room:workspace" }).map((c) => c.id)).toEqual([visitorCard.id]);
    expect(listCards(storePath, PASSPHRASE, { audience: "owner" }).map((c) => c.id)).toEqual([ownerCard.id]);
  });

  it("updateCardRevAndState bumps rev and state together", () => {
    const storePath = initStore();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const card = createCard(storePath, PASSPHRASE, {
      taskId: task.id,
      roomId: "!room:workspace",
      eventId: "$card1",
      kind: "task",
      audience: "visitor",
      state: "acknowledged",
      payloadJson: "{}",
      requester: "@alice:workspace",
    });
    const updated = updateCardRevAndState(storePath, PASSPHRASE, card.id, { rev: 2, state: "working", payloadJson: "{}" });
    expect(updated.rev).toBe(2);
    expect(updated.state).toBe("working");
  });

  it("refuses a non-increasing rev write — rev must be strictly greater than the previous rev", () => {
    const storePath = initStore();
    const task = createTask(storePath, PASSPHRASE, { roomId: "!room:workspace", questionEventId: "$q1", requester: "@alice:workspace" });
    const card = createCard(storePath, PASSPHRASE, {
      taskId: task.id,
      roomId: "!room:workspace",
      eventId: "$card1",
      kind: "task",
      audience: "visitor",
      state: "acknowledged",
      payloadJson: "{}",
      requester: "@alice:workspace",
    });
    updateCardRevAndState(storePath, PASSPHRASE, card.id, { rev: 2, state: "working", payloadJson: "{}" });
    expect(() => updateCardRevAndState(storePath, PASSPHRASE, card.id, { rev: 2, state: "done", payloadJson: "{}" })).toThrow(NonIncreasingRevError);
    expect(() => updateCardRevAndState(storePath, PASSPHRASE, card.id, { rev: 1, state: "done", payloadJson: "{}" })).toThrow(NonIncreasingRevError);
    // Nothing changed on the refused writes.
    expect(getCard(storePath, PASSPHRASE, card.id)?.rev).toBe(2);
    expect(getCard(storePath, PASSPHRASE, card.id)?.state).toBe("working");
  });
});
