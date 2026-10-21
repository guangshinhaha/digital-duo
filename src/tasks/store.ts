import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { transition, type TaskEvent, type TaskState } from "./state.js";

/**
 * W-S4-4: the task and card store — two tables in the SAME encrypted
 * personal store every other daemon-side table lives in (`withDatabase`,
 * the decrypt-to-temp/re-encrypt dance `src/store/store.ts` owns), never a
 * plaintext file. Schema creation follows `ensurePendingActionsSchema`'s
 * pattern in `src/actions/approvals.ts`: `CREATE TABLE IF NOT EXISTS`,
 * `STRICT`, run on demand by every function that touches either table.
 *
 * `src/workspace/**` never imports this file directly — the pinned
 * boundary scan (test/workspace-payload.test.ts) forbids it, now extended
 * to `../tasks/` for exactly this reason: the workspace service reaches
 * the store only through the injected `WorkspaceTaskSink` interface
 * (`src/workspace/service.ts`), whose implementation
 * (`src/serve/workspace-tasks.ts`) is the one caller of everything below,
 * the same indirection `workspace-read-state.ts` already uses for
 * `DuoReadState`.
 */

export function ensureTasksSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      question_event_id TEXT NOT NULL,
      requester TEXT NOT NULL,
      state TEXT NOT NULL,
      draft_id TEXT,
      pending_action_id TEXT,
      t4_request_id TEXT,
      milestone_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_cards (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      audience TEXT NOT NULL,
      rev INTEGER NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      requester TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
}

export interface Task {
  readonly id: string;
  readonly roomId: string;
  readonly questionEventId: string;
  readonly requester: string;
  readonly state: TaskState;
  readonly draftId: string | null;
  readonly pendingActionId: string | null;
  readonly t4RequestId: string | null;
  readonly milestoneCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskRow {
  id: string;
  room_id: string;
  question_event_id: string;
  requester: string;
  state: string;
  draft_id: string | null;
  pending_action_id: string | null;
  t4_request_id: string | null;
  milestone_count: number;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    roomId: row.room_id,
    questionEventId: row.question_event_id,
    requester: row.requester,
    state: row.state as TaskState,
    draftId: row.draft_id,
    pendingActionId: row.pending_action_id,
    t4RequestId: row.t4_request_id,
    milestoneCount: row.milestone_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTaskInput {
  readonly roomId: string;
  readonly questionEventId: string;
  readonly requester: string;
  /** The passed_on outcome's draftId, when known at creation (the passed_on path). Absent for the ack-timer path, which creates the task before any draft exists. */
  readonly draftId?: string | null;
}

/** Creates a task in `acknowledged` — the state machine's one entry point (cards.md §8). */
export function createTask(storePath: string, passphrase: string, input: CreateTaskInput): Task {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTasksSchema(db);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (id, room_id, question_event_id, requester, state, draft_id, pending_action_id, t4_request_id, milestone_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'acknowledged', ?, NULL, NULL, 0, ?, ?)`,
    ).run(id, input.roomId, input.questionEventId, input.requester, input.draftId ?? null, now, now);
    return {
      id,
      roomId: input.roomId,
      questionEventId: input.questionEventId,
      requester: input.requester,
      state: "acknowledged",
      draftId: input.draftId ?? null,
      pendingActionId: null,
      t4RequestId: null,
      milestoneCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function getTask(storePath: string, passphrase: string, id: string): Task | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTasksSchema(db);
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  });
}

/** Every task, oldest first, optionally filtered by state. */
export function listTasks(storePath: string, passphrase: string, state?: TaskState): Task[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTasksSchema(db);
    const rows = state
      ? (db.prepare(`SELECT * FROM tasks WHERE state = ? ORDER BY created_at ASC`).all(state) as unknown as TaskRow[])
      : (db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`).all() as unknown as TaskRow[]);
    return rows.map(rowToTask);
  });
}

export class NoTaskError extends Error {
  constructor(id: string) {
    super(`No task with id "${id}".`);
    this.name = "NoTaskError";
  }
}

export interface UpdateTaskFields {
  readonly draftId?: string | null;
  readonly pendingActionId?: string | null;
  readonly t4RequestId?: string | null;
  /** Increments milestone_count by one, capped at 3 (cards.md §8: "at most 3 in total per task, not counting the final done/failed"). A call past the cap is a no-op on the count — it still applies, and persists, any other field or state change given alongside it. */
  readonly incrementMilestone?: boolean;
}

const MAX_MILESTONES = 3;

/**
 * Updates a task's state (via the state machine — `event` is undefined for
 * a field-only update, e.g. bumping milestone_count with no state change)
 * and/or its draftId/pendingActionId/t4RequestId/milestone_count, in one
 * transaction: `transition()` runs and may throw BEFORE anything is
 * written, so an invalid transition leaves the row untouched.
 */
export function updateTaskState(storePath: string, passphrase: string, id: string, event: TaskEvent | undefined, fields: UpdateTaskFields = {}): Task {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTasksSchema(db);
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    if (!row) {
      throw new NoTaskError(id);
    }
    const current = rowToTask(row);
    // transition() throws InvalidTaskTransitionError here, before any
    // UPDATE runs — the same "check first, write never happens on refusal"
    // ordering approvePendingAction uses for its own early-exit cases.
    const nextState = event === undefined ? current.state : transition(current, event);
    const nextMilestoneCount = fields.incrementMilestone === true ? Math.min(current.milestoneCount + 1, MAX_MILESTONES) : current.milestoneCount;
    const draftId = fields.draftId !== undefined ? fields.draftId : current.draftId;
    const pendingActionId = fields.pendingActionId !== undefined ? fields.pendingActionId : current.pendingActionId;
    const t4RequestId = fields.t4RequestId !== undefined ? fields.t4RequestId : current.t4RequestId;
    const updatedAt = new Date().toISOString();
    db.prepare(
      `UPDATE tasks SET state = ?, draft_id = ?, pending_action_id = ?, t4_request_id = ?, milestone_count = ?, updated_at = ? WHERE id = ?`,
    ).run(nextState, draftId, pendingActionId, t4RequestId, nextMilestoneCount, updatedAt, id);
    return { ...current, state: nextState, draftId, pendingActionId, t4RequestId, milestoneCount: nextMilestoneCount, updatedAt };
  });
}

export interface WorkspaceCard {
  readonly id: string;
  readonly taskId: string;
  readonly roomId: string;
  readonly eventId: string;
  readonly kind: string;
  readonly audience: string;
  readonly rev: number;
  readonly state: string;
  readonly payloadJson: string;
  readonly requester: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorkspaceCardRow {
  id: string;
  task_id: string;
  room_id: string;
  event_id: string;
  kind: string;
  audience: string;
  rev: number;
  state: string;
  payload_json: string;
  requester: string;
  created_at: string;
  updated_at: string;
}

function rowToCard(row: WorkspaceCardRow): WorkspaceCard {
  return {
    id: row.id,
    taskId: row.task_id,
    roomId: row.room_id,
    eventId: row.event_id,
    kind: row.kind,
    audience: row.audience,
    rev: row.rev,
    state: row.state,
    payloadJson: row.payload_json,
    requester: row.requester,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateCardInput {
  /**
   * Caller-supplied (#312/S2 fix): the SAME id the caller already placed in
   * the `duo.card.card_id` field of the event it sent to Matrix, generated
   * before `sendCard` so it could go on the wire at all — `card_id` must
   * stay "stable across edits" (docs/workspace/cards.md §3), and the store
   * generating its own id here, independent of the wire payload's, is
   * exactly how that stability broke (caught by the #312/S2 "exactly one
   * card" test: the wire's first send and its first edit disagreed on
   * `card_id`).
   */
  readonly id: string;
  readonly taskId: string;
  readonly roomId: string;
  readonly eventId: string;
  readonly kind: string;
  readonly audience: string;
  readonly state: string;
  readonly payloadJson: string;
  readonly requester: string;
}

/** Creates a card row at rev 1 — the row written right after `sendCard` resolves the event id (W-S4-5). */
export function createCard(storePath: string, passphrase: string, input: CreateCardInput): WorkspaceCard {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTasksSchema(db);
    const id = input.id;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspace_cards (id, task_id, room_id, event_id, kind, audience, rev, state, payload_json, requester, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(id, input.taskId, input.roomId, input.eventId, input.kind, input.audience, input.state, input.payloadJson, input.requester, now, now);
    return {
      id,
      taskId: input.taskId,
      roomId: input.roomId,
      eventId: input.eventId,
      kind: input.kind,
      audience: input.audience,
      rev: 1,
      state: input.state,
      payloadJson: input.payloadJson,
      requester: input.requester,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function getCard(storePath: string, passphrase: string, id: string): WorkspaceCard | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTasksSchema(db);
    const row = db.prepare(`SELECT * FROM workspace_cards WHERE id = ?`).get(id) as WorkspaceCardRow | undefined;
    return row ? rowToCard(row) : undefined;
  });
}

export interface ListCardsFilter {
  readonly roomId?: string;
  readonly audience?: string;
  readonly taskId?: string;
}

/** Every card, oldest first, optionally narrowed by room id, audience and/or task id. */
export function listCards(storePath: string, passphrase: string, filter: ListCardsFilter = {}): WorkspaceCard[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTasksSchema(db);
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.roomId !== undefined) {
      clauses.push("room_id = ?");
      params.push(filter.roomId);
    }
    if (filter.audience !== undefined) {
      clauses.push("audience = ?");
      params.push(filter.audience);
    }
    if (filter.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(filter.taskId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM workspace_cards${where} ORDER BY created_at ASC`).all(...params) as unknown as WorkspaceCardRow[];
    return rows.map(rowToCard);
  });
}

export class NoCardError extends Error {
  constructor(id: string) {
    super(`No workspace card with id "${id}".`);
    this.name = "NoCardError";
  }
}

/** Thrown when a caller tries to write a `rev` that is not strictly greater than the card's current `rev` — cards.md §4: "rev orders edits within one card; it is never reset." Enforced here, not just by convention, so a caller cannot accidentally send two edits out of order. */
export class NonIncreasingRevError extends Error {
  constructor(id: string, attempted: number, current: number) {
    super(`Refusing to write rev ${attempted} for card "${id}" — its current rev is ${current}; a card's rev must strictly increase.`);
    this.name = "NonIncreasingRevError";
  }
}

export interface UpdateCardFields {
  readonly rev: number;
  readonly state: string;
  readonly payloadJson: string;
}

/** Updates a card's rev/state/payload together — the write made right after an `editCard` call resolves. Throws `NonIncreasingRevError` before writing anything if `rev` is not strictly greater than the card's current rev. */
export function updateCardRevAndState(storePath: string, passphrase: string, id: string, fields: UpdateCardFields): WorkspaceCard {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTasksSchema(db);
    const row = db.prepare(`SELECT * FROM workspace_cards WHERE id = ?`).get(id) as WorkspaceCardRow | undefined;
    if (!row) {
      throw new NoCardError(id);
    }
    if (fields.rev <= row.rev) {
      throw new NonIncreasingRevError(id, fields.rev, row.rev);
    }
    const updatedAt = new Date().toISOString();
    db.prepare(`UPDATE workspace_cards SET rev = ?, state = ?, payload_json = ?, updated_at = ? WHERE id = ?`).run(
      fields.rev,
      fields.state,
      fields.payloadJson,
      updatedAt,
      id,
    );
    return { ...rowToCard(row), rev: fields.rev, state: fields.state, payloadJson: fields.payloadJson, updatedAt };
  });
}
