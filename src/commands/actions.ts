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
import { confirmAndExecuteT4Request, createT4Request, listPendingT4Requests, type PendingT4Request } from "../actions/t4-guard.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

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
