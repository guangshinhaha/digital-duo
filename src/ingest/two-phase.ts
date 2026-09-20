import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLASSIFICATION_CEILING, isWithinCeiling } from "../permissions/classification.js";
import { createEncryptedStore, dataDirFor, withDatabase } from "../store/store.js";
import type { ClassificationLevel, IngestRecord } from "./record.js";
import { listRecords, writeRecords } from "./record-store.js";
import { recordImportRunOnHandle } from "./import-runs.js";

/**
 * Where phase A's transient staging database lives for one ingest run:
 * the same data directory as the retained store, named `import-*.staging.db`
 * so `duo purge` (#17) already sweeps it up if a crash ever leaves one
 * behind — that naming convention was chosen in #17 specifically to
 * anticipate this.
 */
function stagingPathFor(storePath: string): string {
  return join(dataDirFor(storePath), `import-${randomBytes(8).toString("hex")}.staging.db`);
}

function deleteStagingFile(stagingPath: string): void {
  if (existsSync(stagingPath)) {
    unlinkSync(stagingPath);
  }
}

/**
 * The retention boundary, stated in the same words told to the team
 * (docs/v1-tech-design.md §1.4): "we keep questions put to you, we
 * discard everything else others said." A record authored by `other`
 * survives only when it's a question addressed to the owner
 * (`kind: "question_to_me"`). `me` and `assistant` records are never
 * "someone else's message" in the first place — a private chat's own
 * replies aren't a third party's speech — so this rule doesn't apply to
 * them at all; they're always kept.
 */
export function isRetainedAcrossBoundary(record: IngestRecord): boolean {
  return record.author !== "other" || record.kind === "question_to_me";
}

export interface IngestOptions {
  /** Explicit opt-in required before any direct-message record is retained (import-adapters.md §5: "never ingest DMs unless explicitly opted in, per conversation"). Defaults to false. */
  includeDMs?: boolean;
  /**
   * The classification ceiling enforced in phase B (#48 AC1): material
   * above it is staged in phase A — so `staged`/`discardedAboveCeiling`
   * still give a full picture of what came in — but never copied into the
   * retained store. Defaults to DEFAULT_CLASSIFICATION_CEILING when a
   * caller doesn't pass one explicitly; a real call site (duo import)
   * always passes the configured, policy-set ceiling instead.
   */
  ceiling?: ClassificationLevel;
}

export interface IngestOutcome {
  /** Records written to the staging database in phase A, before any filtering. */
  staged: number;
  /** Records newly written to the retained store in phase B. */
  written: number;
  /** Records phase B kept but that were already present in the retained store (re-import, not a duplicate). */
  alreadyPresent: number;
  /** Distinct DM conversations (threads) skipped because DMs weren't opted in. */
  skippedDmConversations: number;
  /** Non-DM records phase A staged but phase B discarded: someone else's text that wasn't a question addressed to the owner. */
  discardedOtherText: number;
  /** Records phase A staged but phase B discarded because their classification sits above the configured ceiling (#48 AC1) — never written to the retained store at all. */
  discardedAboveCeiling: number;
}

/**
 * Runs a batch of records through the two-phase ingest v1-tech-design.md
 * §1.4 calls for: phase A stages everything — including `author: "other"`
 * text, needed for context — in its own transient database; phase B
 * copies only what survives the retention boundary into `storePath`; the
 * staging database is then deleted. This is enforced with two separate
 * database handles rather than one, so the boundary is a property of the
 * system (#21's "also true when done") rather than something every future
 * adapter has to remember to apply on its own:
 *
 * - Phase A's `writeRecords` call only ever opens `stagingPath`.
 * - Phase B's `writeRecords` call only ever opens `storePath`.
 * - There is no code path here through which one phase's handle could
 *   write to the other phase's file.
 *
 * The staging file is deleted in a `finally`, so a failure at any point
 * during phase A (an invalid record, a disk error) still removes it,
 * reports the failure by letting it propagate, and never reaches phase B
 * — `storePath` is untouched on any phase A failure, by construction:
 * phase B's `writeRecords` call is the only line that can write to it,
 * and it only runs after phase A has already fully succeeded.
 */
export function ingestRecords(
  storePath: string,
  passphrase: string,
  records: readonly unknown[],
  options: IngestOptions = {},
): IngestOutcome {
  const stagingPath = stagingPathFor(storePath);
  createEncryptedStore(stagingPath, passphrase);

  try {
    writeRecords(stagingPath, passphrase, records);
    const staged = listRecords(stagingPath, passphrase);

    const includeDMs = options.includeDMs ?? false;
    const dmRecords = staged.filter((record) => record.audience === "dm");
    const skippedDmConversations = includeDMs ? 0 : new Set(dmRecords.map((record) => record.threadId ?? record.id)).size;

    const afterDmFilter = includeDMs ? staged : staged.filter((record) => record.audience !== "dm");
    const retained = afterDmFilter.filter(isRetainedAcrossBoundary);
    const discardedOtherText = afterDmFilter.length - retained.length;

    const ceiling = options.ceiling ?? DEFAULT_CLASSIFICATION_CEILING;
    const withinCeiling = retained.filter((record) => isWithinCeiling(record.classification, ceiling));
    const discardedAboveCeiling = retained.length - withinCeiling.length;

    const writeResult = writeRecords(storePath, passphrase, withinCeiling);

    const outcome: IngestOutcome = {
      staged: staged.length,
      written: writeResult.written,
      alreadyPresent: writeResult.skipped,
      skippedDmConversations,
      discardedOtherText,
      discardedAboveCeiling,
    };

    // #175: record the run for later ("when did the last import run"), in a
    // separate write *after* phase B succeeded — a crash in between loses
    // only this advisory row, never a retained record.
    withDatabase(storePath, passphrase, true, (db) => recordImportRunOnHandle(db, outcome));

    return outcome;
  } finally {
    deleteStagingFile(stagingPath);
  }
}
