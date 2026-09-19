import type { DuoConfig } from "../config.js";
import { appendActionAttempt, ensureActionAttemptLogSchema } from "../actions/attempt-log.js";
import { grantAutonomy, type GrantOutcome } from "../trust/grants.js";
import { isTrustTier, listGrid, type GridRow, type TrustCell, type TrustTier } from "../trust/grid.js";
import { acceptPromotionOffer, declinePromotionOffer, getPendingPromotionOffers, type PromotionOffer } from "../trust/promotion.js";
import { applyCorrection, type DemotionResult } from "../trust/demotion.js";
import { listLedgerEntries, type TrustLedgerEntry } from "../trust/ledger.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists, withDatabase } from "../store/store.js";

export class InvalidTrustTierError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid trust tier — expected one of T0, T1, T2, T3.`);
    this.name = "InvalidTrustTierError";
  }
}

/** Shared by both `trust grant` and (once #54/#55 land) other trust subcommands that take a tier on the command line — one place validates the raw string against the type, since commander itself only ever hands this a string. */
export function parseTrustTier(value: string): TrustTier {
  if (!isTrustTier(value)) {
    throw new InvalidTrustTierError(value);
  }
  return value;
}

/** Implements `duo trust grid` (#53 AC4): every touched cell, its level, and whether it was earned or granted. */
export function runTrustGrid(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): GridRow[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listGrid(config.storePath, passphrase, config.duoDir);
}

export interface RunTrustGrantOptions {
  readonly tier: string;
  readonly topicId?: string;
}

/**
 * Implements `duo trust grant <text> --tier <T0-T3> [--topic <id>]` (#53
 * AC1/AC2/AC3): applies immediately unless ambiguous (owner re-runs with
 * --topic) or it conflicts with a written refusal.
 *
 * #60 AC3: an attempt to grant T4 specifically — "an instruction, standing
 * order, or prompt attempting to authorise autonomous T4 execution" — is
 * refused (same `InvalidTrustTierError` #52 already threw) but also
 * written to the action attempt log, distinct from every other invalid
 * tier string, which is just a typo and not worth recording.
 */
export function runTrustGrant(
  scopeText: string,
  options: RunTrustGrantOptions,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): GrantOutcome {
  // A plain typo (e.g. "T9") keeps the original, unconditional order —
  // rejected before the store is even required to exist (#53's own
  // behavior, unchanged). Only a T4 attempt specifically also requires the
  // store, to log the bypass attempt (#60 AC3) before still refusing.
  if (options.tier.toUpperCase() === "T4") {
    requireStoreExists(config.storePath);
    const passphrase = resolveOrCreatePassphrase(config.storePath, env);
    withDatabase(config.storePath, passphrase, true, (db) => {
      ensureActionAttemptLogSchema(db);
      appendActionAttempt(db, {
        actionId: "trust_grant",
        topicId: options.topicId ?? null,
        tier: "T4",
        outcome: "refused_t4_bypass",
        detail: { scopeText, requestedTier: options.tier },
      });
    });
  }

  const tier = parseTrustTier(options.tier);
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return grantAutonomy(config.storePath, passphrase, config.duoDir, { scopeText, tier, topicId: options.topicId });
}

/** Implements `duo trust promotions` (#54): the batched digest of every cell currently due for a promotion offer, evidence included. */
export function runTrustPromotions(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PromotionOffer[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return getPendingPromotionOffers(config.storePath, passphrase, config.duoDir);
}

/** Implements `duo trust promote <topicId> <tier> --accept|--decline` (#54 AC1/AC2/AC3): the owner's explicit tap — nothing promotes without it. */
export function runTrustPromote(
  topicId: string,
  tierValue: string,
  decision: "accept" | "decline",
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): TrustCell {
  const tier = parseTrustTier(tierValue);
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return decision === "accept"
    ? acceptPromotionOffer(config.storePath, passphrase, topicId, tier)
    : declinePromotionOffer(config.storePath, passphrase, topicId, tier);
}

/** Implements `duo trust correct <topicId> <tier> --reason <text>` (#55 AC1/AC3): a correction demotes the cell at once and restarts its promotion counter. */
export function runTrustCorrect(
  topicId: string,
  tierValue: string,
  reason: string,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): DemotionResult {
  const tier = parseTrustTier(tierValue);
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return applyCorrection(config.storePath, passphrase, { topicId, tier, correctionRef: reason });
}

/** Implements `duo trust ledger [--topic <id> --tier <tier>]` (#55 "also true when done": every demotion — and every other trust event — is reconstructible). */
export function runTrustLedger(
  config: DuoConfig,
  options: { topic?: string; tier?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): TrustLedgerEntry[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const filter = options.topic && options.tier ? { topicId: options.topic, tier: parseTrustTier(options.tier) } : undefined;
  return listLedgerEntries(config.storePath, passphrase, filter);
}
