import type { IngestRecord } from "../ingest/record.js";
import { stripMarkingLine } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { appendAuditEntry, type AuditConfidence } from "./audit.js";
import { retrieveForAsker } from "./retrieval.js";

/**
 * What every decline says, word for word, regardless of *why* the asker
 * gets nothing: nothing matched the question at all, or something matched
 * but every match was above their clearance. #50's own "open questions"
 * section flags this as unresolved design tension — "saying 'I cannot
 * tell you' leaks the existence of the thing; saying nothing looks like
 * ignorance" — and leaves it to be decided here. Resolved conservatively:
 * both cases produce this exact string, so an asker can never distinguish
 * "there was nothing" from "there was something you may not see" (#50 AC2:
 * "does not reveal ... the existence of specific restricted material").
 */
export const DECLINE_MESSAGE = "I don't have anything I can share with you on that.";

/** The no-provider-configured fallback: the visible records' own text, verbatim except for a leading classification marking (stripMarkingLine — the asker is already cleared for the content beneath it, but shouldn't see the raw stamp echoed back), with no synthesis. Same "degrade rather than fail" shape #23-#26 use for their LLM steps, just with a plainer floor since there's no deterministic single answer to fall back to here. */
function extractiveAnswer(records: readonly IngestRecord[]): string {
  return records.map((record) => stripMarkingLine(record)).join("\n\n");
}

function buildPrompt(question: string, records: readonly IngestRecord[]): string {
  const context = records.map((record) => `- ${stripMarkingLine(record)}`).join("\n");
  return [
    "Answer the question using only the information in the context below.",
    "If the context doesn't address the question, say so plainly rather than inventing an answer.",
    "",
    "Context:",
    context,
    "",
    `Question: ${question}`,
  ].join("\n");
}

export interface AnswerForAskerResult {
  readonly answer: string;
  /** True when no visible material informed the answer at all — `answer` is then exactly DECLINE_MESSAGE. */
  readonly declined: boolean;
  /** The audit_log id this call wrote — every answer, given or declined, is logged (#50 AC3). */
  readonly auditEntryId: string;
  /** Carried through from retrieveForAsker: set only when retrieval degraded to full-text-only (e.g. the embedding service was unreachable) — a caller (the CLI) should surface this, same as #20's `duo search` does. */
  readonly warning?: string;
}

/**
 * "The answer is (what I know) x (what I would tell you)" (#50's own
 * background) — resolves the asker and filters retrieval through #49's
 * retrieveForAsker, then answers from *only* what that leaves visible.
 * `inferenceProvider` is optional and best-effort: a missing/unreachable
 * one falls back to `extractiveAnswer` rather than failing the whole
 * call, same shape as #23-#26's LLM steps. Every call — answered or
 * declined — writes exactly one audit entry before returning (#50 AC3,
 * #51's log).
 */
export async function answerForAsker(
  storePath: string,
  passphrase: string,
  duoDir: string,
  question: string,
  askerRef: string,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider?: InferenceProvider,
): Promise<AnswerForAskerResult> {
  const retrieval = await retrieveForAsker(storePath, passphrase, question, embeddingProvider, askerRef, duoDir);
  const visibleRecords = retrieval.generationContext.map((ranked) => ranked.record);
  const declined = visibleRecords.length === 0;

  let answer: string;
  if (declined) {
    answer = DECLINE_MESSAGE;
  } else if (inferenceProvider) {
    try {
      answer = await inferenceProvider.complete(buildPrompt(question, visibleRecords));
    } catch {
      answer = extractiveAnswer(visibleRecords);
    }
  } else {
    answer = extractiveAnswer(visibleRecords);
  }

  // A coarse, honest signal (#51 AC1) — not a calibrated probability, just
  // what actually happened: nothing to be confident about (declined), a
  // degraded retrieval channel, or the ordinary case.
  const confidence: AuditConfidence = declined ? "low" : retrieval.usedEmbeddings ? "high" : "degraded";

  const auditEntryId = appendAuditEntry(storePath, passphrase, {
    question,
    askerRef,
    askerResolved: retrieval.asker.resolved,
    clearanceApplied: retrieval.clearance,
    recordsUsed: visibleRecords.map((record) => record.id),
    recordsExcluded: retrieval.excluded.map((excluded) => ({
      id: excluded.record.id,
      classification: excluded.record.classification,
      reason: excluded.reason,
    })),
    rulesUsed: [],
    confidence,
    declined,
    answerText: answer,
  });

  return { answer, declined, auditEntryId, warning: retrieval.warning };
}
