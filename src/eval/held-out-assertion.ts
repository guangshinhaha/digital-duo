import type { QaPair } from "../derivation/qa-pairs.js";
import type { Rule } from "../derivation/rules.js";
import type { IngestRecord } from "../ingest/record.js";

/**
 * Thrown by assertNoHeldOutEvidence — names the exact rule, qa_pair, and
 * record responsible, so a leak is a specific, actionable bug report, not
 * a vague "something's wrong". Distinct from a config error: this is
 * "derivation must never see held-out evidence" (AR-7) being violated,
 * which is a bug in the pipeline, never something a caller should catch
 * and route around.
 */
export class HeldOutLeakageError extends Error {
  constructor(ruleId: string, qaPairId: string, recordId: string, timestamp: string, cutoff: string) {
    super(
      `Rule "${ruleId}" cites qa_pair "${qaPairId}", whose evidence includes record "${recordId}" ` +
        `(timestamp ${timestamp}) at or after the held-out cutoff ${cutoff}. Derivation must never see ` +
        "held-out evidence (AR-7) — this is a pipeline bug, not something to work around.",
    );
    this.name = "HeldOutLeakageError";
  }
}

/**
 * #35 AC1: "no rule cites evidence from the held-out window, and this is
 * asserted rather than assumed". By construction, derivation run only over
 * `trainRecords` (see offline-eval.ts) can never *produce* a rule citing a
 * held-out qa_pair — but AC1 explicitly asks for that to be checked, not
 * taken on faith, so this re-derives the same fact independently: for
 * every rule's evidence, resolve the qa_pair it cites and the records that
 * back it, and confirm both sit strictly before `cutoff`.
 *
 * Pure and side-effect-free — no database access — so it can be tested
 * directly against a deliberately-constructed leak, independent of
 * whether the real pipeline can ever actually produce one.
 */
export function assertNoHeldOutEvidence(
  rules: readonly Rule[],
  evidenceByRuleId: ReadonlyMap<string, readonly string[]>,
  qaPairsById: ReadonlyMap<string, QaPair>,
  recordsById: ReadonlyMap<string, IngestRecord>,
  cutoff: string,
): void {
  const cutoffMs = new Date(cutoff).getTime();

  for (const rule of rules) {
    const evidenceIds = evidenceByRuleId.get(rule.id) ?? [];
    for (const qaPairId of evidenceIds) {
      const pair = qaPairsById.get(qaPairId);
      if (!pair) {
        continue; // an evidence row citing a qa_pair that no longer exists is a different problem, not a held-out leak
      }
      for (const recordId of [pair.questionId, pair.answerId]) {
        const record = recordsById.get(recordId);
        if (!record) {
          continue;
        }
        const ts = new Date(record.timestamp).getTime();
        if (!Number.isNaN(ts) && ts >= cutoffMs) {
          throw new HeldOutLeakageError(rule.id, qaPairId, recordId, record.timestamp, cutoff);
        }
      }
    }
  }
}
