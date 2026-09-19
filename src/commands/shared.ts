import { loadSharedDuoConfig } from "../shared-duo/config.js";
import { answerSharedDuo, type SharedDuoAnswer } from "../shared-duo/answer.js";
import { loadSharedDuo } from "../shared-duo/loader.js";
import { loadUsageLog, unresolvedQuestionGaps, type QuestionGap } from "../shared-duo/usage-log.js";

/** Implements `duo shared ask <question>` (#69): loads the persona file fresh on every call — a hand-edited, merged change to it takes effect on the very next ask, with nothing to restart. */
export async function runSharedAsk(question: string, env: NodeJS.ProcessEnv = process.env): Promise<SharedDuoAnswer> {
  const { personaPath, usageLogPath } = loadSharedDuoConfig(env);
  const duo = loadSharedDuo(personaPath);
  return answerSharedDuo(duo, question, usageLogPath);
}

/** Implements `duo shared gaps` (#69 AC4): the out-of-scope questions the shared duo has been asked, most-repeated first. */
export function runSharedGaps(env: NodeJS.ProcessEnv = process.env): QuestionGap[] {
  const { usageLogPath } = loadSharedDuoConfig(env);
  return unresolvedQuestionGaps(loadUsageLog(usageLogPath));
}
