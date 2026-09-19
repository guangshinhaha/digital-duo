import { existsSync, readFileSync } from "node:fs";
import type { DuoConfig } from "../config.js";
import { MalformedExportError, parseClaudeExport } from "../ingest/adapters/claude-export.js";
import { MalformedTranscriptError, parsePastedTranscript } from "../ingest/adapters/paste.js";
import { writeRecords } from "../ingest/record-store.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { StoreNotInitializedError } from "../store/store.js";

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

/**
 * Every import command needs the store to already exist (`duo init`
 * first) before it resolves or generates a passphrase — checking this
 * first avoids the side effect of generating and persisting a brand-new
 * passphrase file for a store that doesn't exist yet, only to then fail.
 */
function requireInitializedStore(storePath: string): void {
  if (!existsSync(storePath)) {
    throw new StoreNotInitializedError(storePath);
  }
}

export interface ClaudeImportSummary {
  conversationCount: number;
  workRelevantConversationCount: number;
  written: number;
  skipped: number;
}

export function runImportClaude(path: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): ClaudeImportSummary {
  const raw = readSourceFile(path, MalformedExportError);
  const { records, conversationCount, workRelevantConversationCount } = parseClaudeExport(raw);

  requireInitializedStore(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const result = writeRecords(config.storePath, passphrase, records);

  return { conversationCount, workRelevantConversationCount, written: result.written, skipped: result.skipped };
}

export interface PasteImportSummary {
  workRelevant: boolean;
  written: number;
  skipped: number;
}

export function runImportPaste(path: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): PasteImportSummary {
  const raw = readSourceFile(path, MalformedTranscriptError);
  const { records, workRelevant } = parsePastedTranscript(raw);

  if (!workRelevant) {
    return { workRelevant: false, written: 0, skipped: 0 };
  }

  requireInitializedStore(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  const result = writeRecords(config.storePath, passphrase, records);

  return { workRelevant: true, written: result.written, skipped: result.skipped };
}
