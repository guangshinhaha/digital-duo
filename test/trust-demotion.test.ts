import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCorrection, resolveAutonomyForAnswering } from "../src/trust/demotion.js";
import { getCellRow } from "../src/trust/grid.js";
import { listLedgerEntries } from "../src/trust/ledger.js";
import { acceptPromotionOffer, declinePromotionOffer, getPendingPromotionOffers, recordCleanInstance, PROMOTION_THRESHOLD } from "../src/trust/promotion.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

function seedTopic(id: string, label: string): void {
  writeTopicsFile(duoDir(), [{ id, label, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

/** Promotes a fresh cell all the way from "ask" to "auto" so demotion tests start from a cell that has somewhere to fall. */
function promoteToAuto(storePath: string, topicId: string, tier: "T0" | "T1" | "T2" | "T3"): void {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, topicId, tier);
    }
    acceptPromotionOffer(storePath, PASSPHRASE, topicId, tier);
  }
}

describe("applyCorrection — a correction demotes the cell at once (#55 AC1)", () => {
  it("drops the cell one level immediately", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    promoteToAuto(storePath, "topic-a", "T0");

    const result = applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-123" });
    expect(result).toEqual({ topicId: "topic-a", tier: "T0", fromLevel: "auto", toLevel: "approve", demoted: true });

    withDatabase(storePath, PASSPHRASE, false, (db) => {
      expect(getCellRow(db, "topic-a", "T0")?.level).toBe("approve");
    });
  });

  it("is a no-op (but still recorded) at the floor level, since there's nowhere lower to go", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    // Never touched: the cell starts at "ask", the floor.
    const result = applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-1" });
    expect(result).toEqual({ topicId: "topic-a", tier: "T0", fromLevel: "ask", toLevel: "ask", demoted: false });

    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ eventType: "demoted", detail: { correctionRef: "audit-1", atFloor: true } });
  });
});

describe("applyCorrection — the demotion is announced (#55 AC2)", () => {
  it("states the reason exactly once, on the next question about that cell", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    promoteToAuto(storePath, "topic-a", "T0");
    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-123" });

    const first = resolveAutonomyForAnswering(storePath, PASSPHRASE, duoDir(), "topic-a", "T0");
    expect(first.level).toBe("approve");
    expect(first.demotionNotice).toMatch(/got that wrong/i);

    const second = resolveAutonomyForAnswering(storePath, PASSPHRASE, duoDir(), "topic-a", "T0");
    expect(second.demotionNotice).toBeUndefined();
  });

  it("never announces anything for a cell that has never been demoted", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    const result = resolveAutonomyForAnswering(storePath, PASSPHRASE, duoDir(), "topic-a", "T0");
    expect(result).toEqual({ level: "ask", stale: false, demotionNotice: undefined });
  });

  it("never announces anything for a stale cell (its topic gone)", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    promoteToAuto(storePath, "topic-a", "T0");
    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-1" });
    writeTopicsFile(duoDir(), []); // the topic is merged/removed

    const result = resolveAutonomyForAnswering(storePath, PASSPHRASE, duoDir(), "topic-a", "T0");
    expect(result).toEqual({ level: "ask", stale: true, demotionNotice: undefined });
  });
});

describe("applyCorrection — cannot be reversed by the same evidence that caused it (#55 AC3)", () => {
  it("restarts the promotion counter: the streak that preceded the correction does not count toward re-promotion", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    promoteToAuto(storePath, "topic-a", "T0"); // now at "auto", streak reset to 0 by the last accept

    // Manufacture a nonzero streak at "auto" before correcting, to prove it doesn't survive.
    recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");

    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-1" });

    withDatabase(storePath, PASSPHRASE, false, (db) => {
      const cell = getCellRow(db, "topic-a", "T0");
      expect(cell?.cleanStreak).toBe(0);
      expect(cell?.lastOfferStreak).toBeNull();
      expect(cell?.lastOfferStatus).toBeNull();
    });

    // Only PROMOTION_THRESHOLD - 1 more instances: not enough on its own, proving the pre-correction streak wasn't silently retained.
    for (let i = 0; i < PROMOTION_THRESHOLD - 1; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    expect(getPendingPromotionOffers(storePath, PASSPHRASE, duoDir())).toEqual([]);
  });

  it("clears a pending decline gate left over from before the correction", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    declinePromotionOffer(storePath, PASSPHRASE, "topic-a", "T0");

    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-1" });

    withDatabase(storePath, PASSPHRASE, false, (db) => {
      const cell = getCellRow(db, "topic-a", "T0");
      expect(cell?.lastOfferStreak).toBeNull();
      expect(cell?.lastOfferStatus).toBeNull();
    });
  });
});

describe("every demotion is recorded in the ledger with the correction that triggered it (#55 also-true-when-done)", () => {
  it("carries the correctionRef and both levels", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    promoteToAuto(storePath, "topic-a", "T0");

    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-entry-42" });

    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0" });
    const demotion = entries.at(-1);
    expect(demotion).toMatchObject({
      eventType: "demoted",
      detail: { correctionRef: "audit-entry-42", fromLevel: "auto", toLevel: "approve" },
    });
  });
});
