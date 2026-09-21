import { randomUUID } from "node:crypto";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { appendActionAttempt, ensureActionAttemptLogSchema } from "./attempt-log.js";
import { ensureActionRegistrySchema, getActionRow, type RegisteredAction } from "./registry.js";

/**
 * `docs/concept.md` §6: "Never autonomous. Product principle, not a
 * limitation." #52 already made T4 a compile-time impossibility in the
 * trust grid (`TrustTier` excludes it) and #60's own change to
 * `ensureTrustSchema` makes it a database-level impossibility too (a
 * `CHECK` constraint, not just an absent row). This module is the *only*
 * way a T4 action can ever run at all: there is no autonomous path,
 * because there is no grid cell that could ever say "auto" for T4 — every
 * T4 action goes through this two-step create-then-confirm sequence, and
 * `confirmAndExecuteT4Request` is the one function in the entire codebase
 * that is allowed to invoke a T4 side effect.
 *
 * Deliberately reads no environment variable and no configuration value
 * anywhere in this module (AC1: "no setting exists to bypass this") — the
 * request/confirm functions take no flag that could skip the two-step
 * sequence, and there is no third function that shortcuts it.
 */

export class NotAT4ActionError extends Error {
  constructor(actionId: string) {
    super(`"${actionId}" is not a registered T4 action — this module refuses to stage a request for anything else.`);
    this.name = "NotAT4ActionError";
  }
}

export interface PendingT4Request {
  readonly id: string;
  readonly actionId: string;
  readonly topicId: string;
  readonly reasoning: string;
  readonly createdAt: string;
  readonly executedAt: string | null;
}

interface PendingT4Row {
  id: string;
  action_id: string;
  topic_id: string;
  reasoning: string;
  created_at: string;
  executed_at: string | null;
}

function rowToRequest(row: PendingT4Row): PendingT4Request {
  return { id: row.id, actionId: row.action_id, topicId: row.topic_id, reasoning: row.reasoning, createdAt: row.created_at, executedAt: row.executed_at };
}

/** Created on demand, matching every other table in this codebase. Not append-only like `action_attempts` — `executed_at` legitimately moves from null to a timestamp exactly once, via `confirmAndExecuteT4Request` alone. */
function ensurePendingT4Schema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_t4_requests (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      created_at TEXT NOT NULL,
      executed_at TEXT
    ) STRICT
  `);
}

/**
 * Stages a T4 request — the "decide to try" half, entirely separate from
 * the "actually run" half (`confirmAndExecuteT4Request`). Refuses (and
 * logs the attempt, #60 AC3) anything that isn't a registered action
 * currently classified T4: this is not a generic "ask permission" queue,
 * it exists only for the one tier that structurally cannot have any other
 * path to execution.
 */
type CreateT4RequestResult = { readonly ok: true; readonly request: PendingT4Request } | { readonly ok: false };

/**
 * `withDatabase` only re-encrypts (persists) a mutation when its callback
 * *returns* — throwing from inside it discards every write the callback
 * made, including a log entry meant to survive the very refusal it's
 * logging. So this function's own `withDatabase` callback never throws: a
 * refusal is returned as `{ ok: false }` (after the attempt log entry is
 * already written and about to persist), and `createT4Request` throws only
 * once that call has returned and the log entry is safely on disk.
 */
export function createT4Request(
  storePath: string,
  passphrase: string,
  input: { actionId: string; topicId: string; reasoning: string },
): PendingT4Request {
  const result = withDatabase(storePath, passphrase, true, (db): CreateT4RequestResult => {
    ensureActionRegistrySchema(db);
    ensureActionAttemptLogSchema(db);
    ensurePendingT4Schema(db);

    const action = getActionRow(db, input.actionId);
    if (!action || action.tier !== "T4") {
      appendActionAttempt(db, {
        actionId: input.actionId,
        topicId: input.topicId,
        tier: action?.tier ?? null,
        outcome: "refused_t4_bypass",
        detail: { reason: action ? "action is not classified T4" : "action is not registered", requestedTopicId: input.topicId },
      });
      return { ok: false };
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO pending_t4_requests (id, action_id, topic_id, reasoning, created_at, executed_at) VALUES (?, ?, ?, ?, ?, NULL)`).run(
      id,
      input.actionId,
      input.topicId,
      input.reasoning,
      createdAt,
    );
    appendActionAttempt(db, { actionId: input.actionId, topicId: input.topicId, tier: "T4", outcome: "requires_human_confirmation", detail: { requestId: id } });
    return { ok: true, request: { id, actionId: input.actionId, topicId: input.topicId, reasoning: input.reasoning, createdAt, executedAt: null } };
  });

  if (!result.ok) {
    throw new NotAT4ActionError(input.actionId);
  }
  return result.request;
}

export function listPendingT4Requests(storePath: string, passphrase: string): PendingT4Request[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensurePendingT4Schema(db);
    const rows = db.prepare(`SELECT * FROM pending_t4_requests WHERE executed_at IS NULL ORDER BY created_at ASC`).all() as unknown as PendingT4Row[];
    return rows.map(rowToRequest);
  });
}

export interface PendingT4RequestForJudgement extends PendingT4Request {
  /**
   * The registered action this request names, read from the same registry
   * row the guard checked at staging — the owner judging a confirmation
   * needs what will happen (`description`), to what (`topicId`, on the
   * request itself), and irreversibly or not (`reversible`), not just the
   * request row. Null only if the registry row is gone, which no code path
   * in this repo can do (there is no unregister); degraded to null rather
   * than thrown for a hand-edited store.
   */
  readonly action: RegisteredAction | null;
}

/**
 * #180: the pending request rows joined with the registry facts the owner
 * needs to judge each one — the same read `duo actions t4 pending`'s raw
 * list feeds, shaped for the moment of confirmation instead of the
 * terminal. A composition over two store tables belongs in the module
 * (`describeDuoKnowledge`'s #175 precedent), never in a route handler, and
 * one `withDatabase` handle joins both — no nested store call.
 */
export function describePendingT4Requests(storePath: string, passphrase: string): PendingT4RequestForJudgement[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureActionRegistrySchema(db);
    ensurePendingT4Schema(db);
    const rows = db.prepare(`SELECT * FROM pending_t4_requests WHERE executed_at IS NULL ORDER BY created_at ASC`).all() as unknown as PendingT4Row[];
    return rows.map((row) => ({ ...rowToRequest(row), action: getActionRow(db, row.action_id) ?? null }));
  });
}

export class NoPendingT4RequestError extends Error {
  constructor(requestId: string) {
    super(`No pending T4 request with id "${requestId}".`);
    this.name = "NoPendingT4RequestError";
  }
}

export class T4RequestAlreadyExecutedError extends Error {
  constructor(requestId: string) {
    super(`T4 request "${requestId}" was already executed and cannot run again.`);
    this.name = "T4RequestAlreadyExecutedError";
  }
}

/**
 * The one function anywhere in this codebase allowed to invoke a T4 side
 * effect (AC1). It requires a `requestId` that only `createT4Request`
 * could have produced — there is no parameter here that stages a request
 * and confirms it in the same call, and no default for `requestId` that
 * could be guessed or omitted. `execute` runs exactly once, inside the same
 * transaction that marks the request executed, so a caller cannot invoke
 * it twice by calling this function twice either (the second call throws
 * before `execute` is ever reached).
 */
export function confirmAndExecuteT4Request(
  storePath: string,
  passphrase: string,
  requestId: string,
  execute: () => void,
  /**
   * #180: who confirmed, when the confirmation arrives over HTTP — the
   * paired device's id, recorded in the `t4_executed` attempt entry so the
   * log names the device that gave the confirmation. Omitted by the CLI
   * path (the owner at the terminal); the log entry is byte-identical to
   * before when absent.
   */
  confirmedBy?: string,
): PendingT4Request {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensurePendingT4Schema(db);
    ensureActionAttemptLogSchema(db);

    const row = db.prepare(`SELECT * FROM pending_t4_requests WHERE id = ?`).get(requestId) as PendingT4Row | undefined;
    if (!row) {
      throw new NoPendingT4RequestError(requestId);
    }
    if (row.executed_at !== null) {
      throw new T4RequestAlreadyExecutedError(requestId);
    }

    execute();

    const executedAt = new Date().toISOString();
    db.prepare(`UPDATE pending_t4_requests SET executed_at = ? WHERE id = ?`).run(executedAt, requestId);
    appendActionAttempt(db, {
      actionId: row.action_id,
      topicId: row.topic_id,
      tier: "T4",
      outcome: "t4_executed",
      detail: { requestId, ...(confirmedBy !== undefined ? { confirmedBy } : {}) },
    });
    return rowToRequest({ ...row, executed_at: executedAt });
  });
}
