import { withDatabase } from "../store/store.js";
import { ensureTrustSchema, getCellRow, previousLevel, resolveAutonomy, upsertCellRow, type AutonomyLevel, type TrustCell, type TrustTier } from "./grid.js";
import { appendLedgerEntry, ensureTrustLedgerSchema } from "./ledger.js";

/**
 * "Demote fast — one correction drops the cell a level immediately, and
 * says so." (docs/concept.md §6) — the asymmetric half of the trust
 * mechanic; #54 built the slow, opt-in promotion side.
 */
const DEMOTION_NOTICE = "I got that wrong recently, so I'm checking with you first on this before acting.";

export interface DemotionResult {
  readonly topicId: string;
  readonly tier: TrustTier;
  readonly fromLevel: AutonomyLevel;
  readonly toLevel: AutonomyLevel;
  /** False when the cell was already at the floor ("ask") — there's nowhere lower to drop to, though the correction is still recorded in the ledger. */
  readonly demoted: boolean;
}

/**
 * #55 AC1/AC3: a correction drops the cell one level immediately, and the
 * clean instances that preceded it stop counting toward re-earning the
 * level just lost — the streak (and any pending-offer state left over from
 * before the correction) restarts from zero. `correctionRef` is an opaque
 * caller-supplied identifier (e.g. an audit-log entry id, or a plain
 * description) — this module doesn't need to know what a correction *is*,
 * only that one happened and what it referenced, so it's recorded
 * alongside the demotion in the ledger (#55 "also true when done").
 */
export function applyCorrection(
  storePath: string,
  passphrase: string,
  input: { topicId: string; tier: TrustTier; correctionRef: string },
): DemotionResult {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTrustSchema(db);
    ensureTrustLedgerSchema(db);
    const now = new Date().toISOString();
    const existing: TrustCell = getCellRow(db, input.topicId, input.tier) ?? {
      topicId: input.topicId,
      tier: input.tier,
      level: "ask",
      source: "earned",
      cleanStreak: 0,
      lastOfferStreak: null,
      lastOfferStatus: null,
      demotionAnnounced: true,
      updatedAt: now,
    };

    const lower = previousLevel(existing.level);
    if (lower === undefined) {
      // Already at the floor — nothing to drop to, but the correction is
      // still real negative evidence: the streak (and any pending-offer
      // state) restarts exactly as it would on a real demotion (#55 AC3),
      // even though the level itself can't move any lower.
      upsertCellRow(db, { ...existing, cleanStreak: 0, lastOfferStreak: null, lastOfferStatus: null, updatedAt: now });
      appendLedgerEntry(db, {
        topicId: input.topicId,
        tier: input.tier,
        eventType: "demoted",
        detail: { correctionRef: input.correctionRef, fromLevel: existing.level, toLevel: existing.level, atFloor: true },
      });
      return { topicId: input.topicId, tier: input.tier, fromLevel: existing.level, toLevel: existing.level, demoted: false };
    }

    const demoted: TrustCell = {
      ...existing,
      level: lower,
      source: "earned",
      cleanStreak: 0,
      lastOfferStreak: null,
      lastOfferStatus: null,
      demotionAnnounced: false,
      updatedAt: now,
    };
    upsertCellRow(db, demoted);
    appendLedgerEntry(db, {
      topicId: input.topicId,
      tier: input.tier,
      eventType: "demoted",
      detail: { correctionRef: input.correctionRef, fromLevel: existing.level, toLevel: lower },
    });
    return { topicId: input.topicId, tier: input.tier, fromLevel: existing.level, toLevel: lower, demoted: true };
  });
}

export interface AutonomyForAnswering {
  readonly level: AutonomyLevel;
  readonly stale: boolean;
  /** Present exactly once, on the first read after a demotion — consumed by this same call so it is never repeated (#55 AC2's "next question" wording is singular). */
  readonly demotionNotice: string | undefined;
}

/**
 * The read the (future, #12) answering path calls before acting on a cell:
 * #52's resolveAutonomy, plus the one-time demotion announcement (#55 AC2).
 * A stale cell (its topic merged/removed) never carries a notice — there's
 * no live cell context left to announce anything about.
 */
export function resolveAutonomyForAnswering(
  storePath: string,
  passphrase: string,
  duoDir: string,
  topicId: string,
  tier: TrustTier,
): AutonomyForAnswering {
  const resolved = resolveAutonomy(storePath, passphrase, duoDir, topicId, tier);
  if (resolved.stale) {
    return { level: resolved.level, stale: true, demotionNotice: undefined };
  }
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTrustSchema(db);
    const existing = getCellRow(db, topicId, tier);
    if (!existing || existing.demotionAnnounced) {
      return { level: resolved.level, stale: false, demotionNotice: undefined };
    }
    upsertCellRow(db, { ...existing, demotionAnnounced: true });
    return { level: resolved.level, stale: false, demotionNotice: DEMOTION_NOTICE };
  });
}
