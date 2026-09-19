import type { DuoConfig } from "../config.js";
import {
  buildCalibrationSummary,
  findIncompleteCalibrationSession,
  findLatestCalibrationSession,
  listCalibrationJudgements,
  nextUnjudgedItem,
  recordCalibrationJudgement,
  startOrResumeCalibration,
  type CalibrationItem,
  type CalibrationJudgement,
  type CalibrationJudgementRecord,
  type CalibrationSession,
  type CalibrationSummary,
  type RecordJudgementResult,
  type StartCalibrationResult,
} from "../derivation/calibration.js";
import { buildInterruptionPortrait, type InterruptionPortrait } from "../derivation/portrait.js";
import { createOllamaEmbeddingProvider } from "../provider/ollama-embedding-provider.js";
import { tryResolveProvider } from "../provider/registry.js";
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

/** Implements `duo mirror calibrate` (#30): starts a session, or resumes/reports on an in-progress one — never both starts fresh and shows an existing one in the same call. */
export async function runMirrorCalibrateStart(
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartCalibrationResult> {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const embeddingProvider = createOllamaEmbeddingProvider(config);
  const inferenceProvider = tryResolveProvider(config);
  return startOrResumeCalibration(config.storePath, passphrase, config.duoDir, embeddingProvider, inferenceProvider, config.confidence);
}

export interface CalibrationProgress {
  readonly sessionId: string;
  readonly judgedCount: number;
  readonly totalCount: number;
  readonly completed: boolean;
  readonly next: CalibrationItem | undefined;
}

function progressOf(session: CalibrationSession, judgements: readonly CalibrationJudgementRecord[]): CalibrationProgress {
  return {
    sessionId: session.id,
    judgedCount: judgements.length,
    totalCount: session.items.length,
    completed: session.completedAt !== null,
    next: nextUnjudgedItem(session, judgements),
  };
}

/** Implements showing where the current session stands and what to judge next — the no-argument `duo mirror calibrate` output once a session already exists. Throws when there is no incomplete session to show (the caller should start one first). */
export function runMirrorCalibrateProgress(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): CalibrationProgress {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const session = findIncompleteCalibrationSession(config.storePath, passphrase);
  if (!session) {
    throw new Error("No calibration session in progress. Run `duo mirror calibrate` to start one.");
  }
  const judgements = listCalibrationJudgements(config.storePath, passphrase, session.id);
  return progressOf(session, judgements);
}

/** Implements `duo mirror calibrate judge <qaPairId> --approve|--reject|--edit <text>` (#30 AC1) — always against the one currently-incomplete session. */
export function runMirrorCalibrateJudge(
  qaPairId: string,
  judgement: CalibrationJudgement,
  editedText: string | undefined,
  config: DuoConfig,
  env: NodeJS.ProcessEnv = process.env,
): RecordJudgementResult {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const session = findIncompleteCalibrationSession(config.storePath, passphrase);
  if (!session) {
    throw new Error("No calibration session in progress. Run `duo mirror calibrate` to start one.");
  }
  return recordCalibrationJudgement(config.storePath, passphrase, session.id, qaPairId, judgement, editedText);
}

/** Implements `duo mirror calibrate summary` (#30 AC2): reports the agreement rate plainly, with every mismatch, never smoothed over. Resolves the most recently created session, in progress or just finished. */
export function runMirrorCalibrateSummary(config: DuoConfig, env: NodeJS.ProcessEnv = process.env): CalibrationSummary {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const session = findLatestCalibrationSession(config.storePath, passphrase);
  if (!session) {
    throw new Error("No calibration session exists yet. Run `duo mirror calibrate` to start one.");
  }
  const judgements = listCalibrationJudgements(config.storePath, passphrase, session.id);
  return buildCalibrationSummary(session, judgements);
}
