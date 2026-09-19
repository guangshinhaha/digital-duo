import { withDatabase } from "../store/store.js";
import { appendActionAttempt, ensureActionAttemptLogSchema } from "./attempt-log.js";
import { createPendingActionRow, ensurePendingActionsSchema, type PendingAction } from "./approvals.js";
import { ensureActionRegistrySchema, getActionRow } from "./registry.js";

/**
 * T3 from `docs/concept.md` §6: "Approve, confirm, assign, commit to a
 * date, speak unhedged ... Starts as draft-and-approve, graduates
 * individually." #59's own rule, stated as an acceptance criterion rather
 * than left to the trust grid: **no T3 action is autonomous on first
 * grant — every one enters as draft-and-approve.**
 *
 * Design decision on the issue's own open question ("which T3 actions, if
 * any, should ever reach full autonomy — the honest answer may be
 * none"): this module never consults the trust grid's autonomy level at
 * all, for any T3 action, regardless of how many clean instances a topic
 * has accumulated. Every AC in this story ("nothing happens until the
 * owner approves", "an unapproved action expires rather than executing")
 * is written without a carve-out for a promoted cell, and #52's grid
 * still lets a T3 cell's `cleanStreak` climb toward a promotion offer
 * generically — that tracking is left in place as real signal about
 * which topics *would* be trusted, but this module never lets it skip the
 * approval tap. If T3 ever earns a genuinely autonomous path, that is a
 * deliberate new decision for its own issue, not a default this one falls
 * into.
 */

export class NotAT3ActionError extends Error {
  constructor(actionId: string) {
    super(`"${actionId}" did not resolve to a T3 (binding-internal) action.`);
    this.name = "NotAT3ActionError";
  }
}

/** How long a prepared T3 action waits for the owner's tap before it expires unapproved (#59 AC2). 24 hours — long enough to survive a workday without becoming stale for a "commit to a date" style request. */
export const BINDING_ACTION_DEFAULT_EXPIRY_HOURS = 24;

export interface PrepareBindingActionInput {
  readonly actionId: string;
  readonly topicId: string;
  readonly reasoning: string;
  /** A plain description of what the owner is being committed to — a date, a deliverable — recorded on the pending item and, once approved, in the announcement (#59 AC3). Omit for a binding action that doesn't itself create a commitment. */
  readonly commitsTo?: string;
  readonly expiresInHours?: number;
}

type PrepareBindingActionResult = { readonly ok: true; readonly pendingAction: PendingAction } | { readonly ok: false };

/**
 * Stages a T3 action for the owner's approval — the *only* thing this
 * function does. There is no execute parameter here at all: unlike
 * #58's `performReversibleAction` (which can run a T2 action directly once
 * granted), nothing in this module ever calls a side effect — that is
 * `approvePendingAction`'s job alone, and only after the owner's explicit
 * tap (`src/actions/approvals.ts`).
 */
export function prepareBindingAction(storePath: string, passphrase: string, input: PrepareBindingActionInput): PendingAction {
  const result = withDatabase(storePath, passphrase, true, (db): PrepareBindingActionResult => {
    ensureActionRegistrySchema(db);
    ensureActionAttemptLogSchema(db);
    ensurePendingActionsSchema(db);

    const action = getActionRow(db, input.actionId);
    if (!action || action.tier !== "T3") {
      appendActionAttempt(db, {
        actionId: input.actionId,
        topicId: input.topicId,
        tier: action?.tier ?? null,
        outcome: "refused_unregistered",
        detail: { reason: action ? "action is not classified T3" : "action is not registered" },
      });
      return { ok: false };
    }

    const expiresAt = new Date(Date.now() + (input.expiresInHours ?? BINDING_ACTION_DEFAULT_EXPIRY_HOURS) * 60 * 60 * 1000).toISOString();
    const pendingAction = createPendingActionRow(db, {
      actionId: input.actionId,
      topicId: input.topicId,
      tier: "T3",
      reasoning: input.reasoning,
      commitsTo: input.commitsTo ?? null,
      expiresAt,
    });
    appendActionAttempt(db, { actionId: input.actionId, topicId: input.topicId, tier: "T3", outcome: "awaiting_approval", detail: { pendingActionId: pendingAction.id } });
    return { ok: true, pendingAction };
  });

  if (!result.ok) {
    throw new NotAT3ActionError(input.actionId);
  }
  return result.pendingAction;
}
