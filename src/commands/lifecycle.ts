import type { DuoConfig } from "../config.js";
import { archiveDuo, declareOrphaned, endDuoAndRecord, type DuoLifecycleRecord, type EndDuoResult } from "../continuity/lifecycle.js";
import { confirmTransfer, initiateTransfer, listTransfers, type TransferRequest } from "../continuity/transfer.js";
import { resolveOrCreatePassphrase } from "../store/passphrase.js";
import { requireStoreExists } from "../store/store.js";

/** Implements `duo continuity archive <decidedBy>` (#63 AC1). */
export function runArchive(decidedBy: string, config: DuoConfig, env: NodeJS.ProcessEnv = process.env): DuoLifecycleRecord {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);
  return archiveDuo(config.storePath, passphrase, config.duoDir, config.lifecycleLogPath, decidedBy);
}

/** Implements `duo continuity orphan <reportedBy> <reason>` (#63 AC4). */
export function runDeclareOrphaned(reportedBy: string, reason: string, config: DuoConfig): DuoLifecycleRecord {
  return declareOrphaned(config.duoDir, config.lifecycleLogPath, reportedBy, reason);
}

/** Implements `duo continuity transfer initiate <outgoingOwner> <receivingOwner>` (#63 AC2). */
export function runTransferInitiate(outgoingOwner: string, receivingOwner: string, config: DuoConfig): TransferRequest {
  return initiateTransfer(config.duoDir, config.lifecycleLogPath, outgoingOwner, receivingOwner);
}

/** Implements `duo continuity transfer confirm <transferId> <confirmingName>` (#63 AC2). */
export function runTransferConfirm(transferId: string, confirmingName: string, config: DuoConfig): TransferRequest {
  return confirmTransfer(config.duoDir, config.lifecycleLogPath, transferId, confirmingName);
}

/** Implements `duo continuity transfer list` (#63 AC2). */
export function runTransferList(config: DuoConfig): TransferRequest[] {
  return listTransfers(config.duoDir);
}

/**
 * Implements `duo continuity end [--yes] <decidedBy>` (#63 AC3). The
 * lifecycle event is recorded *after* `endDuo` returns, once it's known
 * for certain what was actually deleted (see `endDuoAndRecord`'s own doc
 * comment) — the log lives in its own directory, never inside the store
 * or `duoDir` being removed, so logging after deletion is exactly as safe
 * as logging before, and more honest about what actually happened.
 */
export function runEnd(decidedBy: string, confirmed: boolean, config: DuoConfig): EndDuoResult {
  return endDuoAndRecord(config.storePath, config.duoDir, config.lifecycleLogPath, decidedBy, confirmed);
}
