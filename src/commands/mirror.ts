import type { DuoConfig } from "../config.js";
import { buildInterruptionPortrait, type InterruptionPortrait } from "../derivation/portrait.js";
import {
  approveRule,
  describeRuleWithEvidence,
  listRulesForReview,
  promoteRule,
  rejectRule,
  writeRuleByHand,
  type RuleReviewListing,
  type RuleWithEvidence,
} from "../derivation/rule-review.js";
import type { Rule } from "../derivation/rules.js";
import { requireStoreExists } from "../store/store.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";

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
