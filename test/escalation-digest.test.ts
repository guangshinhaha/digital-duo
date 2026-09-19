import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { draftReply } from "../src/drafting/pipeline.js";
import { queueStandingOrderCandidate } from "../src/drafting/standing-order-candidates.js";
import {
  assembleEscalationDigest,
  checkUrgentEscalations,
  escalationUrgencyRate,
  listEscalationDigests,
} from "../src/escalation/digest.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

/** Escalates unconditionally: no evidence and no rule exist for these questions in a fresh store, so draftReply always returns kind "escalation" (refused: false) regardless of provider. */
async function escalate(storePath: string, question: string): Promise<string> {
  const result = await draftReply(storePath, PASSPHRASE, duoDir(), question, null, createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG);
  if (result.kind !== "escalation") {
    throw new Error(`expected an escalation, got ${result.kind}`);
  }
  return result.draftId;
}

describe("assembleEscalationDigest — several escalations arrive as one digest (#46 AC1)", () => {
  it("lists every escalation since the last digest, with enough context to answer each in place", async () => {
    const storePath = initStore();
    await escalate(storePath, "how much vacation leave do I get");
    await escalate(storePath, "what is the printer's IP address");

    const result = assembleEscalationDigest(storePath, PASSPHRASE);

    expect(result.sent).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.question)).toEqual(
      expect.arrayContaining(["how much vacation leave do I get", "what is the printer's IP address"]),
    );
    for (const item of result.items) {
      expect(item.escalationReason).not.toBeNull();
      expect(item.escalationReason!.length).toBeGreaterThan(0);
    }

    const history = listEscalationDigests(storePath, PASSPHRASE);
    expect(history).toHaveLength(1);
    expect(history[0].itemCount).toBe(2);
  });
});

describe("assembleEscalationDigest — an empty digest is not sent (#46 AC2)", () => {
  it("sends nothing, and records nothing, when there is nothing new since the last digest", async () => {
    const storePath = initStore();

    const firstResult = assembleEscalationDigest(storePath, PASSPHRASE);
    expect(firstResult.sent).toBe(false);
    expect(firstResult.items).toEqual([]);
    expect(listEscalationDigests(storePath, PASSPHRASE)).toHaveLength(0);

    // Also true once a real digest has already emptied the backlog: a
    // second call right after finds nothing new either.
    await escalate(storePath, "how much vacation leave do I get");
    const sent = assembleEscalationDigest(storePath, PASSPHRASE);
    expect(sent.sent).toBe(true);
    const secondResult = assembleEscalationDigest(storePath, PASSPHRASE);
    expect(secondResult.sent).toBe(false);
    expect(listEscalationDigests(storePath, PASSPHRASE)).toHaveLength(1); // still just the one real digest
  });
});

describe("checkUrgentEscalations — urgent escalations interrupt, and stay out of the ordinary digest (#46 AC3)", () => {
  it("surfaces an urgent escalation immediately, exactly once, and never inside the batched digest", async () => {
    const storePath = initStore();
    await escalate(storePath, "how much vacation leave do I get"); // normal
    await escalate(storePath, "production is down, nobody can log in"); // urgent

    const firstCheck = checkUrgentEscalations(storePath, PASSPHRASE);
    expect(firstCheck.items).toHaveLength(1);
    expect(firstCheck.items[0].question).toBe("production is down, nobody can log in");

    // Notified exactly once — a second check finds nothing new.
    const secondCheck = checkUrgentEscalations(storePath, PASSPHRASE);
    expect(secondCheck.items).toHaveLength(0);

    // The urgent one never appears in the ordinary digest at all.
    const digest = assembleEscalationDigest(storePath, PASSPHRASE);
    expect(digest.items).toHaveLength(1);
    expect(digest.items[0].question).toBe("how much vacation leave do I get");
  });

  it("tracks the urgent share so drift away from rare is visible (#46 AC3)", async () => {
    const storePath = initStore();
    await escalate(storePath, "how much vacation leave do I get");
    await escalate(storePath, "what is the printer's IP address");
    await escalate(storePath, "production is down, nobody can log in");

    const rate = escalationUrgencyRate(storePath, PASSPHRASE);
    expect(rate.total).toBe(3);
    expect(rate.urgent).toBe(1);
    expect(rate.rate).toBeCloseTo(1 / 3, 5);
  });

  it("reports a rate of exactly 0, never NaN, with nothing classified yet", () => {
    const storePath = initStore();
    const rate = escalationUrgencyRate(storePath, PASSPHRASE);
    expect(rate).toEqual({ total: 0, urgent: 0, rate: 0 });
  });
});

describe("an escalation answered in the thread before the digest is dropped (#46 AC4)", () => {
  it("omits an escalation the owner already answered directly, from both the digest and the urgent check", async () => {
    const storePath = initStore();
    const answeredDraftId = await escalate(storePath, "production is down, nobody can log in");
    await escalate(storePath, "how much vacation leave do I get");

    // The owner answers the urgent one directly (`duo draft-answer`) before either surface ever runs.
    queueStandingOrderCandidate(storePath, PASSPHRASE, answeredDraftId, "It was a false alarm, systems are fine.");

    const urgentCheck = checkUrgentEscalations(storePath, PASSPHRASE);
    expect(urgentCheck.items).toHaveLength(0);

    const digest = assembleEscalationDigest(storePath, PASSPHRASE);
    expect(digest.items).toHaveLength(1);
    expect(digest.items[0].question).toBe("how much vacation leave do I get");

    // Still counted toward the all-time rate — it *was* a real escalation, just a resolved one.
    const rate = escalationUrgencyRate(storePath, PASSPHRASE);
    expect(rate.total).toBe(2);
    expect(rate.urgent).toBe(1);
  });
});
