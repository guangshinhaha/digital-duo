import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadLifecycleLog } from "../src/continuity/lifecycle-log.js";
import { readLifecycle } from "../src/continuity/lifecycle.js";
import { InvalidTransferError, TransferNotFoundError, confirmTransfer, getTransfer, initiateTransfer, listTransfers } from "../src/continuity/transfer.js";

const tempDir = useTempDir();

function duoDir(): string {
  return join(tempDir(), "duo");
}

function lifecycleLogPath(): string {
  return join(tempDir(), "lifecycle-log", "events.json");
}

describe("initiateTransfer — #63 AC2: a transfer request effects nothing on its own", () => {
  it("creates a pending request confirmed by neither party", () => {
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    expect(request.status).toBe("pending");
    expect(request.outgoingConfirmed).toBe(false);
    expect(request.receivingConfirmed).toBe(false);
    expect(listTransfers(duoDir())).toHaveLength(1);
    expect(loadLifecycleLog(lifecycleLogPath()).map((e) => e.eventType)).toEqual(["transfer_initiated"]);
  });

  it("refuses blank names or transferring to oneself", () => {
    expect(() => initiateTransfer(duoDir(), lifecycleLogPath(), "", "Bob")).toThrow(InvalidTransferError);
    expect(() => initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "")).toThrow(InvalidTransferError);
    expect(() => initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "alice")).toThrow(InvalidTransferError);
  });
});

describe("confirmTransfer — #63 AC2: completes only once both named parties have confirmed", () => {
  it("stays pending after only one party confirms", () => {
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    const afterOne = confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Alice");
    expect(afterOne.status).toBe("pending");
    expect(afterOne.outgoingConfirmed).toBe(true);
    expect(afterOne.receivingConfirmed).toBe(false);
    expect(readLifecycle(duoDir()).transferredAt).toBeNull();
  });

  it("completes once both parties have confirmed, and records it on duo/lifecycle.json", () => {
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Alice");
    const completed = confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Bob");

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();

    const lifecycle = readLifecycle(duoDir());
    expect(lifecycle.transferredFrom).toBe("Alice");
    expect(lifecycle.transferredTo).toBe("Bob");
    expect(lifecycle.transferredAt).toBeTruthy();
    // A transfer changes ownership, not liveness — the duo stays active.
    expect(lifecycle.status).toBe("active");

    const eventTypes = loadLifecycleLog(lifecycleLogPath()).map((e) => e.eventType);
    expect(eventTypes).toEqual(["transfer_initiated", "transfer_confirmed", "transfer_confirmed", "transfer_completed"]);
  });

  it("never completes from a single call, even one naming both parties' intent — there is no such call", () => {
    // Structural check: confirmTransfer only ever accepts one name per
    // call, so a single invocation can mark at most one party confirmed.
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    const result = confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Alice");
    expect(result.status).toBe("pending");
  });

  it("is idempotent: the same party confirming twice doesn't complete it alone", () => {
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Alice");
    const again = confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "alice");
    expect(again.status).toBe("pending");
    expect(again.outgoingConfirmed).toBe(true);
    expect(again.receivingConfirmed).toBe(false);
  });

  it("refuses a name that is party to neither side", () => {
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    expect(() => confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Carol")).toThrow(InvalidTransferError);
  });

  it("refuses confirming an already-completed transfer again", () => {
    const request = initiateTransfer(duoDir(), lifecycleLogPath(), "Alice", "Bob");
    confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Alice");
    confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Bob");
    expect(() => confirmTransfer(duoDir(), lifecycleLogPath(), request.id, "Alice")).toThrow(InvalidTransferError);
  });

  it("throws for an unknown transfer id", () => {
    expect(() => confirmTransfer(duoDir(), lifecycleLogPath(), "nonexistent", "Alice")).toThrow(TransferNotFoundError);
    expect(getTransfer(duoDir(), "nonexistent")).toBeUndefined();
  });
});
