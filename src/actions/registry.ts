import { readTopicsFile } from "../derivation/topics.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureTrustSchema, getCellRow, isTrustTier, upsertCellRow, type AutonomyLevel, type TrustTier } from "../trust/grid.js";
import { appendLedgerEntry, ensureTrustLedgerSchema } from "../trust/ledger.js";
import { appendActionAttempt, ensureActionAttemptLogSchema } from "./attempt-log.js";

/**
 * `docs/concept.md` §6 stages actions by reversibility, obligation, and
 * audience rather than by build difficulty (#56). This module is the
 * registry that mechanism describes: every tool the duo can reach is
 * registered with those three properties, its tier is derived from them
 * (never asserted directly), and #56 AC2's "unregistered tool cannot be
 * used" makes this the one choke point every execution-shaped module in
 * this epic (#57-#60) must call through before doing anything.
 *
 * `ActionTier` deliberately includes T4, unlike `TrustTier` (#52's grid,
 * which excludes it entirely — "never a dimension of the table in the
 * first place"). A registered action can genuinely classify as T4; what
 * cannot happen is a T4 *grid cell* granting it autonomy, since no such
 * cell can exist. #60 builds the separate, non-grid gate T4 actually goes
 * through.
 */
export const ACTION_TIERS = ["T0", "T1", "T2", "T3", "T4"] as const;
export type ActionTier = (typeof ACTION_TIERS)[number];

function isActionTier(value: string): value is ActionTier {
  return (ACTION_TIERS as readonly string[]).includes(value);
}

/** Ordinal risk order — used only to detect a *rise* in tier on re-registration (#56 AC3); never used to compare autonomy levels, which is `AUTONOMY_LEVELS`' job. */
const TIER_ORDER: Record<ActionTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

/**
 * Who an action's *effect* reaches, not who can invoke it. `"none"` — no
 * side effect on anyone (T0: answer, cite, summarise). `"owner"` — visible
 * only to the owner (T1: private preparation). `"internal"` — colleagues or
 * internal systems (T2/T3, split by obligation/reversibility below).
 * `"external"` — a citizen, another agency, or anything with statutory or
 * spend effect (always T4, concept.md's "never autonomous" line, regardless
 * of how reversible or non-obligating the action otherwise looks).
 */
export const ACTION_AUDIENCES = ["none", "owner", "internal", "external"] as const;
export type ActionAudience = (typeof ACTION_AUDIENCES)[number];

export interface ActionRiskShape {
  readonly reversible: boolean;
  readonly obligates: boolean;
  readonly audience: ActionAudience;
}

/**
 * The pure classifier behind #56 AC1 ("its tier is resolved from those
 * properties"). `audience` is decisive at the two extremes — `"external"`
 * is always T4 and `"none"` is always T0 — because concept.md's table
 * treats "who is reached" as the thing that makes T4 categorically
 * different, not something reversibility or obligation could offset.
 * Within `"internal"`, obligation (T3) and irreversibility (also escalated
 * to T3, the safer of the two remaining tiers, rather than under-classified
 * as T2) are what separate a one-click-undo action from a binding one.
 */
export function classifyActionTier(shape: ActionRiskShape): ActionTier {
  if (shape.audience === "external") {
    return "T4";
  }
  if (shape.audience === "none") {
    return "T0";
  }
  if (shape.audience === "owner") {
    return "T1";
  }
  if (shape.obligates || !shape.reversible) {
    return "T3";
  }
  return "T2";
}

export interface ActionDescriptor extends ActionRiskShape {
  readonly id: string;
  readonly description: string;
  /** Topics this action can be exercised within — necessary for the trust grid's (topic × tier) check (#52) to mean anything for a *specific* action, and for #56 AC3's "which grants lapsed" to name real cells rather than a system-wide sweep. Not one of the three literal properties the issue names, but a minimal, documented extension: without it, "checked against the trust grid" has no topic to check against. */
  readonly topicIds: readonly string[];
}

export interface RegisteredAction extends ActionDescriptor {
  readonly tier: ActionTier;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

interface ActionRow {
  id: string;
  description: string;
  reversible: number;
  obligates: number;
  audience: string;
  topic_ids: string;
  tier: string;
  registered_at: string;
  updated_at: string;
}

function rowToAction(row: ActionRow): RegisteredAction {
  return {
    id: row.id,
    description: row.description,
    reversible: row.reversible === 1,
    obligates: row.obligates === 1,
    audience: row.audience as ActionAudience,
    topicIds: JSON.parse(row.topic_ids) as string[],
    tier: row.tier as ActionTier,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

/** Created on demand, matching every other table in this codebase. */
export function ensureActionRegistrySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_registry (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      reversible INTEGER NOT NULL,
      obligates INTEGER NOT NULL,
      audience TEXT NOT NULL,
      topic_ids TEXT NOT NULL,
      tier TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
}

/**
 * The raw, db-taking primitive — exported so a caller that already holds
 * an open handle (e.g. #60's `t4-guard.ts`, which must check an action's
 * registration inside its own transaction) can read a row without opening
 * a second `withDatabase` against the same file. The exact fix #28 needed
 * for the same class of bug, applied here from the start.
 */
export function getActionRow(db: Database, actionId: string): RegisteredAction | undefined {
  const row = db.prepare(`SELECT * FROM action_registry WHERE id = ?`).get(actionId) as ActionRow | undefined;
  return row ? rowToAction(row) : undefined;
}

export interface LapsedGrant {
  readonly topicId: string;
  readonly tier: TrustTier;
  readonly previousLevel: AutonomyLevel;
}

export interface RegisterActionResult {
  readonly action: RegisteredAction;
  readonly tierChanged: boolean;
  readonly previousTier: ActionTier | undefined;
  /** Every (topic × old tier) grid cell that was granted or earned autonomy and no longer covers this action, because its risk rose (#56 AC3, #60 AC2). Reported so the owner is told, not silently dropped. */
  readonly lapsedGrants: readonly LapsedGrant[];
}

/**
 * Registers a new action, or re-registers an existing one with updated risk
 * properties. Re-registration is where #56 AC3 lives: if the freshly
 * classified tier is a *rise* in risk over the stored one, every topic this
 * action applies to has its old-tier grid cell checked; a cell already
 * granted or earned past "ask" is revoked back to "ask" and reported as
 * lapsed, since it was calibrated for a risk level this action no longer
 * sits at. A tier that falls or stays the same never revokes anything — the
 * risky direction is the one that needs an active response.
 *
 * One open handle for the whole call (read the existing row, classify,
 * revoke cells, log the attempt) — never a nested `withDatabase`, the exact
 * class of bug #28 found and fixed.
 */
export function registerAction(storePath: string, passphrase: string, descriptor: ActionDescriptor): RegisterActionResult {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureActionRegistrySchema(db);
    ensureTrustSchema(db);
    ensureTrustLedgerSchema(db);
    ensureActionAttemptLogSchema(db);

    const existing = getActionRow(db, descriptor.id);
    const tier = classifyActionTier(descriptor);
    const now = new Date().toISOString();
    const action: RegisteredAction = {
      ...descriptor,
      tier,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };

    db.prepare(
      `
      INSERT INTO action_registry (id, description, reversible, obligates, audience, topic_ids, tier, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        reversible = excluded.reversible,
        obligates = excluded.obligates,
        audience = excluded.audience,
        topic_ids = excluded.topic_ids,
        tier = excluded.tier,
        updated_at = excluded.updated_at
    `,
    ).run(
      action.id,
      action.description,
      action.reversible ? 1 : 0,
      action.obligates ? 1 : 0,
      action.audience,
      JSON.stringify(action.topicIds),
      action.tier,
      action.registeredAt,
      action.updatedAt,
    );

    const lapsedGrants: LapsedGrant[] = [];
    const tierRose = existing !== undefined && TIER_ORDER[tier] > TIER_ORDER[existing.tier];
    if (tierRose && isTrustTier(existing!.tier)) {
      const oldTier = existing!.tier as TrustTier;
      for (const topicId of existing!.topicIds) {
        const cell = getCellRow(db, topicId, oldTier);
        if (cell && cell.level !== "ask") {
          lapsedGrants.push({ topicId, tier: oldTier, previousLevel: cell.level });
          upsertCellRow(db, { ...cell, level: "ask", cleanStreak: 0, lastOfferStreak: null, lastOfferStatus: null, updatedAt: now });
          appendLedgerEntry(db, {
            topicId,
            tier: oldTier,
            eventType: "revoked",
            detail: { reason: "action re-tiered to higher risk", actionId: action.id, fromTier: existing!.tier, toTier: tier, previousLevel: cell.level },
          });
        }
      }
    }

    appendActionAttempt(db, {
      actionId: action.id,
      topicId: null,
      tier: action.tier,
      outcome: "resolved",
      detail: { event: existing ? "re-registered" : "registered", tierChanged: existing !== undefined && existing.tier !== tier, lapsedGrantCount: lapsedGrants.length },
    });

    return { action, tierChanged: existing !== undefined && existing.tier !== tier, previousTier: existing?.tier, lapsedGrants };
  });
}

export function getRegisteredAction(storePath: string, passphrase: string, actionId: string): RegisteredAction | undefined {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureActionRegistrySchema(db);
    return getActionRow(db, actionId);
  });
}

export function listRegisteredActions(storePath: string, passphrase: string): RegisteredAction[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureActionRegistrySchema(db);
    const rows = db.prepare(`SELECT * FROM action_registry ORDER BY id`).all() as unknown as ActionRow[];
    return rows.map(rowToAction);
  });
}

export type ActionUseOutcome =
  | { readonly status: "refused_unregistered" }
  | { readonly status: "resolved"; readonly tier: ActionTier; readonly level: AutonomyLevel | "confirm_required"; readonly stale: boolean };

/**
 * The one function anything outside this module should call before an
 * action runs (#56 AC1/AC2) — the choke point every tier-specific module
 * built later in this epic (#57-#60) routes through. An action not found in
 * the registry is refused outright, logged, and never executed at an
 * assumed tier (AC2) — there is no fallback tier here, only refusal. A T4
 * action never reaches the grid at all (it structurally cannot — #52
 * excludes T4 from `TrustTier`, #60 CHECK-constrains `trust_cells` the same
 * way); it always resolves to `"confirm_required"`, which is #60's own gate
 * (`src/actions/t4-guard.ts`), never this one.
 */
export function resolveActionForUse(storePath: string, passphrase: string, duoDir: string, actionId: string, topicId: string): ActionUseOutcome {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureActionRegistrySchema(db);
    ensureTrustSchema(db);
    ensureActionAttemptLogSchema(db);

    const action = getActionRow(db, actionId);
    if (!action) {
      appendActionAttempt(db, { actionId, topicId, tier: null, outcome: "refused_unregistered", detail: {} });
      return { status: "refused_unregistered" };
    }

    if (action.tier === "T4") {
      appendActionAttempt(db, { actionId, topicId, tier: action.tier, outcome: "requires_human_confirmation", detail: {} });
      return { status: "resolved", tier: "T4", level: "confirm_required", stale: false };
    }

    // readTopicsFile is a plain file read, not a db call, so it's safe to
    // call inside this open handle — no nesting risk.
    const topicExists = readTopicsFile(duoDir).some((topic) => topic.id === topicId);
    const cell = getCellRow(db, topicId, action.tier);
    const level: AutonomyLevel = !cell ? "ask" : !topicExists ? "ask" : cell.level;
    const stale = cell !== undefined && !topicExists;

    appendActionAttempt(db, { actionId, topicId, tier: action.tier, outcome: "resolved", detail: { level, stale } });
    return { status: "resolved", tier: action.tier, level, stale };
  });
}
