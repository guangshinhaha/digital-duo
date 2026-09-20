import { buildInterruptionPortrait, type InterruptionPortrait, type TopicShare } from "../derivation/portrait.js";
import { listRules, RULE_REVIEW_STATUSES, type RuleReviewStatus } from "../derivation/rules.js";
import { getLastImportRun, type ImportRun } from "../ingest/import-runs.js";
import { countRecordsBySource } from "../ingest/record-store.js";
import { loadSharedDuoConfig } from "../shared-duo/config.js";
import { buildUsageReport, type SharedDuoUsageReport } from "../shared-duo/usage-report.js";
import { loadUsageLog } from "../shared-duo/usage-log.js";

/**
 * What this duo knows, in one read (#175). Every field is a fact a module
 * already computed or a count over rows a module already stores — this
 * function composes, it never derives anything new (no scores, no
 * percentages, no re-judged thinness): the corpus verdict is
 * InterruptionPortrait's own `tooThin`, the usage picture is
 * buildUsageReport's own report, and the record counts are GROUP BY over
 * the records table. Named `knowledge-summary` to keep it distinct from
 * knowledge.ts's KnowledgeSource — that module is where knowledge comes
 * *from*; this one reports what is *known*.
 */
export interface DuoKnowledge {
  /** How many records the corpus holds, and where they came from. */
  readonly records: {
    readonly total: number;
    readonly bySource: Readonly<Record<string, number>>;
  };
  /** The last completed ingest run — null when this store has never seen an import. */
  readonly lastImport: ImportRun | null;
  /**
   * The corpus-coverage slice of the interruption portrait: the portrait's
   * own thinness verdict and topic breakdown, not a recomputation. When
   * `tooThin` is true the caller should say "not enough history" rather
   * than render the breakdown (same contract as the Mirror's opening
   * screen).
   */
  readonly corpus: {
    readonly tooThin: boolean;
    readonly minimumQuestionsToCharacterize: number;
    readonly totalQuestions: number;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly topicBreakdown: readonly TopicShare[];
  };
  /** Rule counts by review status — every status key present, zero included. */
  readonly rules: {
    readonly byReviewStatus: Readonly<Record<RuleReviewStatus, number>>;
  };
  /** The providers in use, echoed from the caller's configuration — resolved here, never. */
  readonly providers: KnowledgeProviders;
  /** The shared duo's usage report, exactly as `duo shared usage` computes it. */
  readonly sharedUsage: SharedDuoUsageReport;
}

/**
 * Inference by configured name (null when none is configured); embedding by
 * name+model (null when unconfigured). Construction-free by design — the
 * caller says what is wired, this reports it.
 */
export interface KnowledgeProviders {
  readonly inference: string | null;
  readonly embedding: { readonly name: string; readonly model: string } | null;
}

/**
 * Composes the knowledge picture. Read-only against the store; the shared
 * usage log is read from `loadSharedDuoConfig(env).usageLogPath`, same
 * resolution as every other shared-duo path.
 */
export function describeDuoKnowledge(
  storePath: string,
  passphrase: string,
  duoDir: string,
  providers: KnowledgeProviders,
  env: NodeJS.ProcessEnv,
): DuoKnowledge {
  const bySource = countRecordsBySource(storePath, passphrase);
  const total = Object.values(bySource).reduce((sum, count) => sum + count, 0);

  const portrait: InterruptionPortrait = buildInterruptionPortrait(storePath, passphrase, duoDir);

  const byReviewStatus = Object.fromEntries(RULE_REVIEW_STATUSES.map((status) => [status, 0])) as Record<
    RuleReviewStatus,
    number
  >;
  for (const rule of listRules(storePath, passphrase)) {
    byReviewStatus[rule.reviewStatus] += 1;
  }

  const sharedUsage = buildUsageReport(loadUsageLog(loadSharedDuoConfig(env).usageLogPath));

  return {
    records: { total, bySource },
    lastImport: getLastImportRun(storePath, passphrase),
    corpus: {
      tooThin: portrait.tooThin,
      minimumQuestionsToCharacterize: portrait.minimumQuestionsToCharacterize,
      totalQuestions: portrait.totalQuestions,
      periodStart: portrait.periodStart,
      periodEnd: portrait.periodEnd,
      topicBreakdown: portrait.topicBreakdown,
    },
    rules: { byReviewStatus },
    providers,
    sharedUsage,
  };
}
