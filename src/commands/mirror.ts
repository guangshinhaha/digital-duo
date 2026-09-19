import type { DuoConfig } from "../config.js";
import { buildInterruptionPortrait, type InterruptionPortrait } from "../derivation/portrait.js";
import {
  approveRule,
  describeRuleWithEvidence,
  listRefusalConflicts,
  listRulesForReview,
  promoteRule,
  rejectRule,
  writeRuleByHand,
  type RefusalConflict,
  type RuleReviewListing,
  type RuleWithEvidence,
} from "../derivation/rule-review.js";
import type { Rule } from "../derivation/rules.js";
import { requireStoreExists } from "../store/store.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import {
  confirmNoRefusals,
  hasRefusalsDecision,
  readRefusalsFile,
  upsertRefusal,
  type Refusal,
} from "../trust/refusals.js";

/** Implements `duo mirror portrait` (#27): the onboarding screen, sourced from #23/#24's output only. */
export function runMirrorPortrait(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): InterruptionPortrait {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return buildInterruptionPortrait(config.storePath, passphrase, config.duoDir);
}

/** Implements `duo mirror rules [list]` (#28): the review queue, grouped by what the owner can do with each rule. */
export function runMirrorRulesList(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): RuleReviewListing {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listRulesForReview(config.storePath, passphrase);
}

/** Implements the "surfaced to the owner" half of #29 AC3: which approved rules a standing refusal is currently suppressing. */
export function runMirrorRuleConflicts(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): RefusalConflict[] {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return listRefusalConflicts(config.storePath, passphrase, config.duoDir);
}

/** Implements `duo mirror rules show <id>` (#28 AC1): a rule with the exchanges its citations point to. */
export function runMirrorRuleShow(ruleId: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): RuleWithEvidence {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return describeRuleWithEvidence(config.storePath, passphrase, ruleId);
}

/** Implements `duo mirror rules approve <id>` (#28 AC1). */
export function runMirrorRuleApprove(ruleId: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Rule {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return approveRule(config.storePath, passphrase, config.duoDir, ruleId);
}

/** Implements `duo mirror rules reject <id>` (#28 AC2). */
export function runMirrorRuleReject(ruleId: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Rule {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return rejectRule(config.storePath, passphrase, config.duoDir, ruleId);
}

/** Implements `duo mirror rules promote <id>` (#28 AC3). */
export function runMirrorRulePromote(ruleId: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): Rule {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return promoteRule(config.storePath, passphrase, config.duoDir, ruleId);
}

/** Implements `duo mirror rules write` (#28 AC4). */
export function runMirrorRuleWrite(
  label: string,
  text: string,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Rule {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return writeRuleByHand(config.storePath, passphrase, config.duoDir, label, text);
}

export interface RefusalsListing {
  readonly decided: boolean;
  readonly refusals: readonly Refusal[];
}

/** Implements `duo mirror refusals [list]` (#29 AC1/AC2) — no store needed, this is pure duoDir file state. */
export function runMirrorRefusalsList(config: DuoConfig): RefusalsListing {
  return { decided: hasRefusalsDecision(config.duoDir), refusals: readRefusalsFile(config.duoDir) };
}

/** Implements `duo mirror refusals add <heading> <reason>` (#29 AC1). */
export function runMirrorRefusalAdd(heading: string, reason: string, config: DuoConfig): Refusal[] {
  return upsertRefusal(config.duoDir, heading, reason);
}

/** Implements `duo mirror refusals confirm-none` (#29 AC2). */
export function runMirrorRefusalConfirmNone(config: DuoConfig): void {
  confirmNoRefusals(config.duoDir);
}
