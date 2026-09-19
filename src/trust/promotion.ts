import { readTopicsFile } from "../derivation/topics.js";
import { withDatabase } from "../store/store.js";
import { ensureTrustSchema, getCellRow, listCellRows, nextLevel, upsertCellRow, type AutonomyLevel, type TrustCell, type TrustTier } from "./grid.js";
import { appendLedgerEntry, ensureTrustLedgerSchema } from "./ledger.js";

/**
 * "Promote slowly ... a cell offers to graduate after N clean instances and
 * an explicit tap from the owner. Never silently." (docs/concept.md §6).
 * 3 is the same support bar #25's rule induction already uses for a
 * "confirmed" rule — chosen for consistency with that existing precedent
 * rather than independently tuned; nothing here depends on the two staying
 * equal.
 */
export const PROMOTION_THRESHOLD = 3;

/**
 * After a decline, re-offering requires *another* full threshold's worth of
 * clean instances beyond the point of decline — #54 AC2's "materially
 * higher bar," not the same bar met again immediately.
 */
export const REOFFER_MARGIN = PROMOTION_THRESHOLD;

function emptyCell(topicId: string, tier: TrustTier, now: string): TrustCell {
  return {
    topicId,
    tier,
    level: "ask",
    source: "earned",
    cleanStreak: 0,
    lastOfferStreak: null,
    lastOfferStatus: null,
    demotionAnnounced: true,
    updatedAt: now,
  };
}

/**
 * Records one clean (uncorrected) instance of the duo acting at a cell's
 * current level. Never itself changes the level — the only thing that
 * moves a cell here is an explicit `acceptPromotionOffer` call (#54 AC3:
 * "there is no timeout that grants autonomy by default").
 */
export function recordCleanInstance(storePath: string, passphrase: string, topicId: string, tier: TrustTier): TrustCell {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTrustSchema(db);
    ensureTrustLedgerSchema(db);
    const now = new Date().toISOString();
    const existing = getCellRow(db, topicId, tier) ?? emptyCell(topicId, tier, now);
    const updated: TrustCell = { ...existing, cleanStreak: existing.cleanStreak + 1, updatedAt: now };
    upsertCellRow(db, updated);
    appendLedgerEntry(db, { topicId, tier, eventType: "instance", detail: { cleanStreak: updated.cleanStreak } });
    return updated;
  });
}

/** Whether a cell currently qualifies for a promotion offer — pure function of its own stored state, never mutating anything itself. */
function offerIsDue(cell: TrustCell): boolean {
  if (nextLevel(cell.level) === undefined) {
    return false; // already at "auto" — nothing to promote to
  }
  if (cell.cleanStreak < PROMOTION_THRESHOLD) {
    return false;
  }
  if (cell.lastOfferStatus === "declined" && cell.lastOfferStreak !== null) {
    return cell.cleanStreak >= cell.lastOfferStreak + REOFFER_MARGIN;
  }
  return true;
}

export interface PromotionOffer {
  readonly topicId: string;
  /** undefined when the topic has since been merged or removed — still surfaced (the offer is real evidence about a cell that exists), but never actionable via #52's resolveAutonomy, which would report it stale. */
  readonly topicLabel: string | undefined;
  readonly tier: TrustTier;
  readonly currentLevel: AutonomyLevel;
  readonly offeredLevel: AutonomyLevel;
  readonly cleanStreak: number;
}

/**
 * The batched digest itself (#54 "also true when done": promotion offers
 * appear here, batched, never as individual pings) — every cell currently
 * due for an offer, computed fresh from stored state each call rather than
 * a queue something could half-drain. Nothing here mutates anything;
 * "nothing changes until they accept" (AC3) holds even for the read that
 * shows the offer.
 */
export function getPendingPromotionOffers(storePath: string, passphrase: string, duoDir: string): PromotionOffer[] {
  const labelById = new Map(readTopicsFile(duoDir).map((topic) => [topic.id, topic.label]));
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureTrustSchema(db);
    return listCellRows(db)
      .filter(offerIsDue)
      .map((cell) => ({
        topicId: cell.topicId,
        topicLabel: labelById.get(cell.topicId),
        tier: cell.tier,
        currentLevel: cell.level,
        offeredLevel: nextLevel(cell.level)!,
        cleanStreak: cell.cleanStreak,
      }));
  });
}

export class NoPendingPromotionOfferError extends Error {
  constructor(topicId: string, tier: TrustTier) {
    super(`No pending promotion offer for topic "${topicId}" at tier "${tier}".`);
    this.name = "NoPendingPromotionOfferError";
  }
}

/**
 * The owner's explicit tap (#53/#54 AC1): moves the cell up exactly one
 * rung and resets its streak to 0 — the next promotion, if any, is earned
 * fresh from here, not by evidence this acceptance already spent.
 */
export function acceptPromotionOffer(storePath: string, passphrase: string, topicId: string, tier: TrustTier): TrustCell {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTrustSchema(db);
    ensureTrustLedgerSchema(db);
    const existing = getCellRow(db, topicId, tier);
    if (!existing || !offerIsDue(existing)) {
      throw new NoPendingPromotionOfferError(topicId, tier);
    }
    const now = new Date().toISOString();
    const promoted: TrustCell = {
      ...existing,
      level: nextLevel(existing.level)!,
      source: "earned",
      cleanStreak: 0,
      lastOfferStreak: null,
      lastOfferStatus: null,
      updatedAt: now,
    };
    upsertCellRow(db, promoted);
    appendLedgerEntry(db, {
      topicId,
      tier,
      eventType: "promotion_accepted",
      detail: { fromLevel: existing.level, toLevel: promoted.level, cleanStreak: existing.cleanStreak },
    });
    return promoted;
  });
}

/**
 * Declining does not re-ask immediately (#54 AC2): the streak keeps
 * accumulating in the background, but the next offer only fires once it
 * clears `lastOfferStreak + REOFFER_MARGIN` — a materially higher bar than
 * the one just declined, not the same bar met again next question.
 */
export function declinePromotionOffer(storePath: string, passphrase: string, topicId: string, tier: TrustTier): TrustCell {
  return withDatabase(storePath, passphrase, true, (db) => {
    ensureTrustSchema(db);
    ensureTrustLedgerSchema(db);
    const existing = getCellRow(db, topicId, tier);
    if (!existing || !offerIsDue(existing)) {
      throw new NoPendingPromotionOfferError(topicId, tier);
    }
    const now = new Date().toISOString();
    const declined: TrustCell = { ...existing, lastOfferStreak: existing.cleanStreak, lastOfferStatus: "declined", updatedAt: now };
    upsertCellRow(db, declined);
    appendLedgerEntry(db, { topicId, tier, eventType: "promotion_declined", detail: { atStreak: existing.cleanStreak } });
    return declined;
  });
}
