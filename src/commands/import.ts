import { readFileSync } from "node:fs";
import type { DuoConfig } from "../config.js";
import { MalformedExportError, parseClaudeExport } from "../ingest/adapters/claude-export.js";
import { MalformedTranscriptError, parsePastedTranscript } from "../ingest/adapters/paste.js";
import { importPastedRecords, NOT_WORK_RELEVANT_SUMMARY, type PasteImportSummary } from "../ingest/paste-import.js";
import { ingestRecords } from "../ingest/two-phase.js";
import { parseClassificationCeiling } from "../permissions/classification.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/**
 * Reads `path` as UTF-8, wrapping a filesystem failure (missing file, no
 * permission) in the same error type as a malformed *contents* failure —
 * both AC2 ("a malformed or unrecognised export is refused" / "exits
 * non-zero naming what it expected") apply equally to "this path doesn't
 * point at an export at all".
 */
function readSourceFile<E extends Error>(path: string, ErrorType: new (message: string) => E): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new ErrorType(`Could not read "${path}": ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface ClaudeImportSummary {
  conversationCount: number;
  workRelevantConversationCount: number;
  written: number;
  skipped: number;
  discardedAboveCeiling: number;
}

/**
 * Every import path runs its records through the two-phase pipeline
 * (#21), even one like the Claude export adapter that never produces
 * `author: "other"` or DM content: the retention boundary is a property
 * of the *pipeline*, not something each adapter has to remember to
 * enforce for itself. It's a no-op filter for this source today and a
 * real one the moment a multi-party source (e.g. Slack) exists.
 */
export function runImportClaude(path: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): ClaudeImportSummary {
  const raw = readSourceFile(path, MalformedExportError);
  const { records, conversationCount, workRelevantConversationCount } = parseClaudeExport(raw);

  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const ceiling = parseClassificationCeiling(config.classificationCeiling);
  const outcome = ingestRecords(config.storePath, passphrase, records, { ceiling });

  return {
    conversationCount,
    workRelevantConversationCount,
    written: outcome.written,
    skipped: outcome.alreadyPresent,
    discardedAboveCeiling: outcome.discardedAboveCeiling,
  };
}

export type { PasteImportSummary } from "../ingest/paste-import.js";

export function runImportPaste(path: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PasteImportSummary {
  const raw = readSourceFile(path, MalformedTranscriptError);
  const { records, workRelevant } = parsePastedTranscript(raw);

  if (!workRelevant) {
    return NOT_WORK_RELEVANT_SUMMARY;
  }

  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  // The ingest-and-summarize tail is the module function POST
  // /corpus/import-paste (#176) also feeds — one import path, two surfaces.
  return importPastedRecords(config.storePath, passphrase, records, config.classificationCeiling);
}
