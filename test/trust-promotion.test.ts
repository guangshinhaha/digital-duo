import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NoPendingPromotionOfferError,
  PROMOTION_THRESHOLD,
  REOFFER_MARGIN,
  acceptPromotionOffer,
  declinePromotionOffer,
  getPendingPromotionOffers,
  recordCleanInstance,
} from "../src/trust/promotion.js";
import { getCellRow } from "../src/trust/grid.js";
import { listLedgerEntries } from "../src/trust/ledger.js";
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

describe("recordCleanInstance", () => {
  it("increments the streak and appends a ledger entry, without changing the level", () => {
    const storePath = initStore();
    recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    const cell = recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    expect(cell.cleanStreak).toBe(2);
    expect(cell.level).toBe("ask");

    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0" });
    expect(entries.map((e) => e.eventType)).toEqual(["instance", "instance"]);
  });
});

describe("getPendingPromotionOffers — a clean run produces an offer (#54 AC1)", () => {
  it("offers a promotion once the threshold is met, and not before", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");

    for (let i = 0; i < PROMOTION_THRESHOLD - 1; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    expect(getPendingPromotionOffers(storePath, PASSPHRASE, duoDir())).toEqual([]);

    recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    const offers = getPendingPromotionOffers(storePath, PASSPHRASE, duoDir());
    expect(offers).toEqual([
      { topicId: "topic-a", topicLabel: "Topic A", tier: "T0", currentLevel: "ask", offeredLevel: "approve", cleanStreak: PROMOTION_THRESHOLD },
    ]);
  });

  it("changes nothing itself — the level and streak are unaffected by merely being listed", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    getPendingPromotionOffers(storePath, PASSPHRASE, duoDir());
    getPendingPromotionOffers(storePath, PASSPHRASE, duoDir());
    withDatabase(storePath, PASSPHRASE, false, (db) => {
      const cell = getCellRow(db, "topic-a", "T0");
      expect(cell?.level).toBe("ask");
      expect(cell?.cleanStreak).toBe(PROMOTION_THRESHOLD);
    });
  });
});

describe("acceptPromotionOffer — no cell promotes without explicit acceptance (#54 AC3)", () => {
  it("moves the cell up one level and resets the streak", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }

    const promoted = acceptPromotionOffer(storePath, PASSPHRASE, "topic-a", "T0");
    expect(promoted).toMatchObject({ level: "approve", source: "earned", cleanStreak: 0 });

    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0" });
    expect(entries.at(-1)).toMatchObject({ eventType: "promotion_accepted", detail: { fromLevel: "ask", toLevel: "approve" } });
  });

  it("throws when there is no pending offer (streak below threshold)", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    expect(() => acceptPromotionOffer(storePath, PASSPHRASE, "topic-a", "T0")).toThrow(NoPendingPromotionOfferError);
  });

  it("throws when the cell is already at the top level ('auto')", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    acceptPromotionOffer(storePath, PASSPHRASE, "topic-a", "T0"); // ask -> approve
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    acceptPromotionOffer(storePath, PASSPHRASE, "topic-a", "T0"); // approve -> auto
    expect(() => acceptPromotionOffer(storePath, PASSPHRASE, "topic-a", "T0")).toThrow(NoPendingPromotionOfferError);
  });
});

describe("declinePromotionOffer — declining does not re-ask immediately (#54 AC2)", () => {
  it("stops offering right after a decline, then offers again only past the reoffer margin", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    declinePromotionOffer(storePath, PASSPHRASE, "topic-a", "T0");
    expect(getPendingPromotionOffers(storePath, PASSPHRASE, duoDir())).toEqual([]);

    // One more clean instance: still short of the materially-higher bar.
    recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    expect(getPendingPromotionOffers(storePath, PASSPHRASE, duoDir())).toEqual([]);

    // Enough additional clean instances to clear PROMOTION_THRESHOLD + REOFFER_MARGIN.
    for (let i = 0; i < REOFFER_MARGIN - 1; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    const offers = getPendingPromotionOffers(storePath, PASSPHRASE, duoDir());
    expect(offers).toHaveLength(1);
    expect(offers[0].cleanStreak).toBe(PROMOTION_THRESHOLD + REOFFER_MARGIN);
  });

  it("records the decline in the ledger", () => {
    const storePath = initStore();
    seedTopic("topic-a", "Topic A");
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
    }
    declinePromotionOffer(storePath, PASSPHRASE, "topic-a", "T0");
    const entries = listLedgerEntries(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0" });
    expect(entries.at(-1)?.eventType).toBe("promotion_declined");
  });
});

describe("promotion offers appear in the batched digest, not as individual pings (#54 also-true-when-done)", () => {
  it("returns every due cell together from one call, across several topics", () => {
    const storePath = initStore();
    writeTopicsFile(duoDir(), [
      { id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "topic-b", label: "Topic B", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
      recordCleanInstance(storePath, PASSPHRASE, "topic-b", "T1");
    }
    const offers = getPendingPromotionOffers(storePath, PASSPHRASE, duoDir());
    expect(offers.map((o) => `${o.topicId}/${o.tier}`).sort()).toEqual(["topic-a/T0", "topic-b/T1"]);
  });
});
