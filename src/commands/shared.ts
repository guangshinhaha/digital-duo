import { loadSharedDuoConfig } from "../shared-duo/config.js";
import { answerSharedDuo, type SharedDuoAnswer } from "../shared-duo/answer.js";
import { loadSharedDuo } from "../shared-duo/loader.js";
import { loadUsageLog, unresolvedQuestionGaps, type QuestionGap } from "../shared-duo/usage-log.js";
import { buildUsageReport, type SharedDuoUsageReport } from "../shared-duo/usage-report.js";

/** Who a `duo shared ask` is recorded under when `--as` is omitted — asking still works without naming yourself, and #71's usage report simply lumps every such ask together rather than treating it as one distinct asker per call. */
const ANONYMOUS_ASKER = "anonymous";

/** Implements `duo shared ask <question> [--as <askerId>]` (#69, `--as` added by #71): loads the persona file fresh on every call — a hand-edited, merged change to it takes effect on the very next ask, with nothing to restart. */
export async function runSharedAsk(
  question: string,
  askerId: string = ANONYMOUS_ASKER,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SharedDuoAnswer> {
  const { personaPath, usageLogPath } = loadSharedDuoConfig(env);
  const duo = loadSharedDuo(personaPath);
  // #160: the CLI never comes through an ask link and (#69/#71) never
  // resolves the ref — stated explicitly now that the answering function
  // takes the full asker context.
  return answerSharedDuo(duo, question, { ref: askerId, resolved: null, askLinkId: null }, usageLogPath);
}

/** Implements `duo shared gaps` (#69 AC4): the out-of-scope questions the shared duo has been asked, most-repeated first. */
export function runSharedGaps(env: NodeJS.ProcessEnv = process.env): QuestionGap[] {
  const { usageLogPath } = loadSharedDuoConfig(env);
  return unresolvedQuestionGaps(loadUsageLog(usageLogPath));
}

/** Implements `duo shared usage` (#71): the honest usage picture — total questions, distinct/repeat askers, answer/escalation rate, the weekly trend, unanswerable-question gaps, and whether the duo has been abandoned or never used at all. */
export function runSharedUsage(env: NodeJS.ProcessEnv = process.env): SharedDuoUsageReport {
  const { usageLogPath } = loadSharedDuoConfig(env);
  return buildUsageReport(loadUsageLog(usageLogPath));
}
