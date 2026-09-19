import type { DuoConfig } from "../config.js";
import { grantAutonomy, type GrantOutcome } from "../trust/grants.js";
import { isTrustTier, listGrid, type GridRow, type TrustCell, type TrustTier } from "../trust/grid.js";
import { acceptPromotionOffer, declinePromotionOffer, getPendingPromotionOffers, type PromotionOffer } from "../trust/promotion.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

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

/** Implements `duo trust grant <text> --tier <T0-T3> [--topic <id>]` (#53 AC1/AC2/AC3): applies immediately unless ambiguous (owner re-runs with --topic) or it conflicts with a written refusal. */
export function runTrustGrant(
  scopeText: string,
  options: RunTrustGrantOptions,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): GrantOutcome {
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
