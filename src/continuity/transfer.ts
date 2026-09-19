import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLifecycleEvent } from "./lifecycle-log.js";
import { readLifecycle, writeLifecycle } from "./lifecycle.js";

/**
 * #63 AC2: "a duo cannot be transferred without both parties acting...
 * completes only with both the outgoing owner's and the receiving owner's
 * explicit confirmation, and never by an administrator alone." Enforced
 * structurally, the same "no execute parameter exists at all" idiom
 * `actions/binding.ts` uses for T3: there is no function anywhere in this
 * module that can mark both parties confirmed in one call — only
 * `confirmTransfer`, called once per party, each identified by their own
 * name rather than a caller-asserted role (see its own doc comment for
 * why).
 */
export interface TransferRequest {
  readonly id: string;
  readonly createdAt: string;
  readonly outgoingOwner: string;
  readonly receivingOwner: string;
  readonly outgoingConfirmed: boolean;
  readonly receivingConfirmed: boolean;
  readonly status: "pending" | "completed";
  readonly completedAt: string | null;
}

function transfersFilePath(duoDir: string): string {
  return join(duoDir, "transfers.json");
}

/** Returns `[]` when the file doesn't exist yet — no transfer has ever been requested, not an error. */
export function readTransfers(duoDir: string): TransferRequest[] {
  const path = transfersFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new InvalidTransferError(`Malformed ${path}: expected a JSON array of transfer requests`);
  }
  return parsed as TransferRequest[];
}

function writeTransfers(duoDir: string, transfers: readonly TransferRequest[]): void {
  const path = transfersFilePath(duoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(transfers, null, 2)}\n`, "utf8");
}

export class InvalidTransferError extends Error {}

export class TransferNotFoundError extends Error {
  constructor(transferId: string) {
    super(`No transfer request with id "${transferId}"`);
    this.name = "TransferNotFoundError";
  }
}

/** Every transfer request ever made for this duo, oldest first — the owner-facing "what's pending" read. */
export function listTransfers(duoDir: string): TransferRequest[] {
  return [...readTransfers(duoDir)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getTransfer(duoDir: string, transferId: string): TransferRequest | undefined {
  return readTransfers(duoDir).find((request) => request.id === transferId);
}

/** #63 AC2: initiates a transfer request — recorded, but effects nothing on its own; only `confirmTransfer`, called by both named parties, ever completes it. */
export function initiateTransfer(duoDir: string, lifecycleLogPath: string, outgoingOwner: string, receivingOwner: string): TransferRequest {
  const outgoing = outgoingOwner.trim();
  const receiving = receivingOwner.trim();
  if (outgoing.length === 0 || receiving.length === 0) {
    throw new InvalidTransferError("A transfer needs both an outgoing owner and a receiving owner, by name.");
  }
  if (outgoing.toLowerCase() === receiving.toLowerCase()) {
    throw new InvalidTransferError("The outgoing and receiving owner can't be the same person.");
  }
  const request: TransferRequest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    outgoingOwner: outgoing,
    receivingOwner: receiving,
    outgoingConfirmed: false,
    receivingConfirmed: false,
    status: "pending",
    completedAt: null,
  };
  writeTransfers(duoDir, [...readTransfers(duoDir), request]);
  appendLifecycleEvent(lifecycleLogPath, {
    eventType: "transfer_initiated",
    actor: outgoing,
    detail: { transferId: request.id, outgoingOwner: outgoing, receivingOwner: receiving },
  });
  return request;
}

/**
 * #63 AC2: records one named party's confirmation. `confirmingName` is
 * matched (case-insensitively) against the request's own `outgoingOwner`/
 * `receivingOwner` rather than accepted as a caller-asserted role string —
 * this codebase has no independent identity system, so a name that
 * matches neither party is refused outright rather than silently letting
 * anyone confirm as "whichever side they claim." Completing (both now
 * confirmed) is the only side effect: it writes `duo/lifecycle.json`'s
 * transfer history and logs a second, distinct event, so "initiated,"
 * "each confirmation," and "completed" are all separately traceable.
 */
export function confirmTransfer(duoDir: string, lifecycleLogPath: string, transferId: string, confirmingName: string): TransferRequest {
  const request = getTransfer(duoDir, transferId);
  if (!request) {
    throw new TransferNotFoundError(transferId);
  }
  if (request.status === "completed") {
    throw new InvalidTransferError(`Transfer "${transferId}" already completed on ${request.completedAt}.`);
  }
  const trimmed = confirmingName.trim();
  const isOutgoing = trimmed.toLowerCase() === request.outgoingOwner.toLowerCase();
  const isReceiving = trimmed.toLowerCase() === request.receivingOwner.toLowerCase();
  if (!isOutgoing && !isReceiving) {
    throw new InvalidTransferError(
      `"${confirmingName}" is not a party to transfer "${transferId}" (outgoing: ${request.outgoingOwner}, receiving: ${request.receivingOwner}).`,
    );
  }

  const now = new Date().toISOString();
  const outgoingConfirmed = request.outgoingConfirmed || isOutgoing;
  const receivingConfirmed = request.receivingConfirmed || isReceiving;
  const bothConfirmed = outgoingConfirmed && receivingConfirmed;
  const updated: TransferRequest = {
    ...request,
    outgoingConfirmed,
    receivingConfirmed,
    status: bothConfirmed ? "completed" : "pending",
    completedAt: bothConfirmed ? now : null,
  };

  writeTransfers(
    duoDir,
    readTransfers(duoDir).map((candidate) => (candidate.id === transferId ? updated : candidate)),
  );
  appendLifecycleEvent(lifecycleLogPath, {
    eventType: "transfer_confirmed",
    actor: trimmed,
    detail: { transferId, asParty: isOutgoing ? "outgoing" : "receiving" },
  });

  if (bothConfirmed) {
    const lifecycle = readLifecycle(duoDir);
    writeLifecycle(duoDir, { ...lifecycle, transferredFrom: request.outgoingOwner, transferredTo: request.receivingOwner, transferredAt: now });
    appendLifecycleEvent(lifecycleLogPath, {
      eventType: "transfer_completed",
      actor: trimmed,
      detail: { transferId, outgoingOwner: request.outgoingOwner, receivingOwner: request.receivingOwner },
    });
  }

  return updated;
}
