import { parsePastedTranscript } from "./adapters/paste.js";
import type { IngestRecord } from "./record.js";
import { ingestRecords } from "./two-phase.js";
import { parseClassificationCeiling } from "../permissions/classification.js";

export interface PasteImportSummary {
  workRelevant: boolean;
  written: number;
  skipped: number;
  discardedAboveCeiling: number;
}

/**
 * What a transcript judged not work-relevant always returns — no records,
 * nothing written, nothing skipped, nothing discarded. One constant so the
 * CLI command and the HTTP route (#176) report the identical shape from the
 * identical place rather than each spelling "imported nothing" its own way.
 */
export const NOT_WORK_RELEVANT_SUMMARY: PasteImportSummary = Object.freeze({
  workRelevant: false,
  written: 0,
  skipped: 0,
  discardedAboveCeiling: 0,
});

/**
 * The tail of the paste import: records (already parsed, already judged
 * work-relevant) through the two-phase pipeline under the classification
 * ceiling, mapped to the summary both surfaces report. Split out so
 * `duo import paste` (commands/import.ts) and POST /corpus/import-paste
 * (#176) run literally this code — there is no second import path to drift.
 */
export function importPastedRecords(
  storePath: string,
  passphrase: string,
  records: readonly IngestRecord[],
  classificationCeiling: string,
): PasteImportSummary {
  const ceiling = parseClassificationCeiling(classificationCeiling);
  const outcome = ingestRecords(storePath, passphrase, records, { ceiling });
  return {
    workRelevant: true,
    written: outcome.written,
    skipped: outcome.alreadyPresent,
    discardedAboveCeiling: outcome.discardedAboveCeiling,
  };
}

/**
 * The whole paste import over raw transcript text: parse (the paste
 * adapter's own turn grammar — a malformed transcript throws
 * MalformedTranscriptError before anything is touched), the work-relevance
 * gate (AR-11: a transcript judged personal produces no records at all),
 * then the shared ingest tail. This is the one function both `duo import
 * paste` and POST /corpus/import-paste feed text into (#176): the daemon
 * holds the store path, passphrase, and ceiling at boot where the CLI
 * resolves them per run, but everything after the text is identical by
 * construction.
 */
export function importPastedTranscript(
  storePath: string,
  passphrase: string,
  raw: string,
  classificationCeiling: string,
): PasteImportSummary {
  const { records, workRelevant } = parsePastedTranscript(raw);
  if (!workRelevant) {
    return NOT_WORK_RELEVANT_SUMMARY;
  }
  return importPastedRecords(storePath, passphrase, records, classificationCeiling);
}
