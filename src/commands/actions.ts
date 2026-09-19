import type { DuoConfig } from "../config.js";
import { listActionAttempts, type ActionAttemptEntry } from "../actions/attempt-log.js";
import {
  ACTION_AUDIENCES,
  listRegisteredActions,
  registerAction,
  type ActionAudience,
  type RegisterActionResult,
  type RegisteredAction,
} from "../actions/registry.js";
import {
  discardArtifact,
  listDiscardSignals,
  listPreparedArtifacts,
  prepareArtifact,
  type PreparationDiscardSignal,
  type PreparedArtifact,
  type PreparedArtifactKind,
} from "../actions/preparation.js";
import { listPendingActions, type PendingAction, type PendingActionStatus } from "../actions/approvals.js";
import {
  listReversibleActions,
  performReversibleAction,
  undoReversibleAction,
  type PerformReversibleOutcome,
  type ReversibleActionRecord,
} from "../actions/reversible.js";
import { confirmAndExecuteT4Request, createT4Request, listPendingT4Requests, type PendingT4Request } from "../actions/t4-guard.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

const DEFAULT_PREPARATION_TOPIC_ID = "general";

export class InvalidActionAudienceError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid action audience — expected one of ${ACTION_AUDIENCES.join(", ")}.`);
    this.name = "InvalidActionAudienceError";
  }
}

function parseAudience(value: string): ActionAudience {
  if (!(ACTION_AUDIENCES as readonly string[]).includes(value)) {
    throw new InvalidActionAudienceError(value);
  }
  return value as ActionAudience;
}

export class InvalidBooleanFlagError extends Error {
  constructor(flag: string, value: string) {
    super(`"${value}" is not valid for ${flag} — expected exactly "true" or "false".`);
    this.name = "InvalidBooleanFlagError";
  }
}

/** A typo here silently flips an action's classified tier (#56 AC1), so unlike most CLI flags in this codebase this one refuses anything other than an exact "true"/"false" rather than treating an unrecognised value as false. */
function parseBooleanFlag(flag: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidBooleanFlagError(flag, value);
}

export interface RunActionsRegisterOptions {
  readonly description: string;
  /** Raw CLI flag values, validated here (not by the caller) — see parseBooleanFlag. */
  readonly reversible: string;
  readonly obligates: string;
  readonly audience: string;
  readonly topics: string;
}

/** Implements `duo actions register` (#56 AC1): the tier is derived from the three risk properties, never asserted directly, and a tier rise on re-registration revokes any grid cell no longer covering it. */
export function runActionsRegister(actionId: string, options: RunActionsRegisterOptions, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): RegisterActionResult {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const topicIds = options.topics
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return registerAction(config.storePath, passphrase, {
    id: actionId,
    description: options.description,
    reversible: parseBooleanFlag("--reversible", options.reversible),
    obligates: parseBooleanFlag("--obligates", options.obligates),
    audience: parseAudience(options.audience),
    topicIds,
  });
}

/** Implements `duo actions list` (#56 "also true when done": the registry is the one place to see what's registered and at what tier). */
export function runActionsList(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): RegisteredAction[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listRegisteredActions(config.storePath, passphrase);
}

/** Implements `duo actions attempts` (#56 AC2 / #60 AC3): every attempt to use a registered or unregistered action, refused or resolved — the durable, owner-reviewable surface a bypass attempt is recorded to. */
export function runActionsAttempts(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): ActionAttemptEntry[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listActionAttempts(config.storePath, passphrase);
}

/** Implements `duo actions t4 request` (#60 AC1): stages a T4 request. Nothing executes until a separate, explicit `duo actions t4 confirm` call. */
export function runActionsT4Request(
  actionId: string,
  options: { topic: string; reasoning: string },
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): PendingT4Request {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return createT4Request(config.storePath, passphrase, { actionId, topicId: options.topic, reasoning: options.reasoning });
}

/** Implements `duo actions t4 pending` — every T4 request awaiting the owner's explicit confirmation. */
export function runActionsT4Pending(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PendingT4Request[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listPendingT4Requests(config.storePath, passphrase);
}

/**
 * Implements `duo actions t4 confirm <requestId>` — the owner's own
 * explicit, at-the-moment-of-execution confirmation (#60 AC1). There is
 * genuinely nothing to execute yet (defining which actions are T4 is out
 * of scope, per the issue itself), so this wiring's `execute` callback is a
 * no-op placeholder for whatever a future connector supplies — the
 * mechanism this exercises (staged request, explicit confirm, exactly-once
 * execution) is real and identical to what a real T4 action will use.
 */
export function runActionsT4Confirm(requestId: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PendingT4Request {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return confirmAndExecuteT4Request(config.storePath, passphrase, requestId, () => {});
}

/** Implements `duo actions prepare` (#57 AC1): prepares a draft/document/ticket visible only to the owner. */
export function runActionsPrepare(
  options: { kind: PreparedArtifactKind; topic?: string; title: string; content: string },
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): PreparedArtifact {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return prepareArtifact(config.storePath, passphrase, config.duoDir, {
    kind: options.kind,
    topicId: options.topic ?? DEFAULT_PREPARATION_TOPIC_ID,
    title: options.title,
    content: options.content,
  });
}

/** Implements `duo actions prepared` — every prepared artifact currently sitting only the owner can see. */
export function runActionsListPrepared(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PreparedArtifact[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listPreparedArtifacts(config.storePath, passphrase);
}

/** Implements `duo actions discard <id>` (#57 AC3): removes a prepared artifact entirely, recording the discard as a signal. */
export function runActionsDiscard(id: string, note: string | undefined, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PreparationDiscardSignal {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return discardArtifact(config.storePath, passphrase, id, note);
}

/** Implements `duo actions discards` — every discard signal recorded, the training-signal read on what was never wanted. */
export function runActionsListDiscards(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PreparationDiscardSignal[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listDiscardSignals(config.storePath, passphrase);
}

/**
 * Implements `duo actions perform` (#58 AC1/AC3/AC4). There is genuinely
 * nothing to perform/roll-back yet (implementing any specific action is
 * out of scope, per #56), so this wiring's `perform`/`rollbackPartial`
 * callbacks are no-op placeholders for whatever a future connector
 * supplies — the mechanism this exercises (registry gate, autonomy gate,
 * revertibility gate, escalate-or-run, undo) is real.
 */
export function runActionsPerform(
  options: { action: string; topic: string; description: string; notRevertible?: boolean },
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): PerformReversibleOutcome {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return performReversibleAction(config.storePath, passphrase, config.duoDir, {
    actionId: options.action,
    topicId: options.topic,
    description: options.description,
    canRevertHere: !options.notRevertible,
    perform: () => {},
    rollbackPartial: () => {},
  });
}

/** Implements `duo actions undo <id>` (#58 AC2): restores the prior state completely and records the reversal. */
export function runActionsUndo(id: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): ReversibleActionRecord {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return undoReversibleAction(config.storePath, passphrase, id, () => {});
}

/** Implements `duo actions reversible` — every reversible action performed, and whether it's still active, reverted, or failed. */
export function runActionsListReversible(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): ReversibleActionRecord[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listReversibleActions(config.storePath, passphrase);
}

/** Implements `duo actions pending [--status <status>]` — every action escalated to the owner (a T2 that couldn't run autonomously, or any T3 draft-and-approve item), oldest first. */
export function runActionsListPending(status: PendingActionStatus | undefined, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PendingAction[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listPendingActions(config.storePath, passphrase, status);
}
