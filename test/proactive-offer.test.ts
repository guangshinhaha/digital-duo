import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { muteChannel, muteThread } from "../src/drafting/channel-mutes.js";
import { listGateDecisions } from "../src/drafting/gate-log.js";
import { offerDraftForMention } from "../src/drafting/proactive-offer.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

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

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

/** A confirmed, approved rule on "topic-printer", backed by evidence timestamped years in the past — for #47 AC2's staleness check. */
async function seedStalePrinterTopic(storePath: string): Promise<void> {
  const question = record({
    kind: "question_to_me",
    author: "other",
    text: "printer hardware broken on the third floor",
    threadId: "printer-thread",
    timestamp: "2020-01-01T00:00:00.000Z",
  });
  const answer = record({
    text: "IT handles printer hardware issues on that floor",
    threadId: "printer-thread",
    timestamp: "2020-01-01T00:05:00.000Z",
  });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  const embeddingProvider = createFakeEmbeddingProvider();
  await embedRecords(storePath, PASSPHRASE, embeddingProvider);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-printer" })));
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-printer",
        topicId: "topic-printer",
        text: "IT handles printer hardware issues.",
        status: "confirmed",
        supportCount: 3,
        consistency: 0.95,
        createdAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
        reviewStatus: "approved",
        origin: "derived",
        supersededByRuleId: null,
        correctionDraftId: null,
        correctionQuestion: null,
      },
      pairs.map((pair) => pair.id),
    );
  });
}

describe("offerDraftForMention — a mention produces a private offer (#47 AC1)", () => {
  it("offers a draft with one action to post it, after the gate passes", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("offer");
    if (outcome.kind !== "offer") throw new Error("expected an offer");
    expect(outcome.text).toContain("IT handles that");
    expect(outcome.draftId.length).toBeGreaterThan(0);

    const decisions = listGateDecisions(storePath, PASSPHRASE);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].passes).toBe(true);
  });

  it("makes no offer, and logs why, when the gate declines (noise or ambiguous)", async () => {
    const storePath = initStore();
    const dir = duoDir();

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Thanks so much for the help!", from: "bob" },
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("gate_declined");
    if (outcome.kind !== "gate_declined") throw new Error("expected gate_declined");
    expect(outcome.reason).toBe("noise");
  });

  it("reports no_draft, still logging the gate pass, when there is nothing to ground a draft in", async () => {
    const storePath = initStore();
    const dir = duoDir();

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you review the budget doc before Friday?", from: "carol" },
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("no_draft");
    if (outcome.kind !== "no_draft") throw new Error("expected no_draft");
    expect(outcome.reason.length).toBeGreaterThan(0);
  });
});

describe("offerDraftForMention — evidence age is surfaced on the draft (#47 AC2)", () => {
  it("states the staleness of years-old evidence directly on the offered text", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );

    if (outcome.kind !== "offer") throw new Error("expected an offer");
    expect(outcome.evidenceAgeDays).toBeGreaterThan(365);
    expect(outcome.text).toMatch(/\d+ day\(s\) old/);
    expect(outcome.text).toMatch(/check before sending/i);
  });
});

describe("offerDraftForMention — the owner can mute proactive offers per channel (#47 AC3)", () => {
  it("makes no offer at all from a muted channel, and never even runs the gate", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);
    muteChannel(dir, "#printer-support");

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice", channel: "#printer-support" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("muted");
    expect(listGateDecisions(storePath, PASSPHRASE)).toHaveLength(0);
  });

  it("still offers from a different, unmuted channel", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);
    muteChannel(dir, "#printer-support");

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice", channel: "#general" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("offer");
  });

  it("makes no offer from a muted thread either — same muted path, gate never runs (#172)", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);
    muteThread(dir, "#printer-support", "C0123456789.1660000000");

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice", channel: "#printer-support", threadId: "C0123456789.1660000000" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("muted");
    expect(listGateDecisions(storePath, PASSPHRASE)).toHaveLength(0);
  });

  it("a thread mute does not mute the channel: other threads, and channel-only mentions, still offer (#172)", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);
    muteThread(dir, "#printer-support", "C0123456789.1660000000");

    const otherThread = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice", channel: "#printer-support", threadId: "C9999999999.1660000001" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );
    expect(otherThread.kind).toBe("offer");

    const noThread = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice", channel: "#printer-support" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );
    expect(noThread.kind).toBe("offer");
  });

  it("a mention with no channel at all is never treated as muted", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedStalePrinterTopic(storePath);

    const outcome = await offerDraftForMention(
      storePath,
      PASSPHRASE,
      dir,
      { text: "Can you check on the printer hardware issue on the third floor?", from: "alice" },
      createFakeEmbeddingProvider(),
      agreeingProvider("IT handles that — I'll check on it."),
      CONFIDENCE_CONFIG,
    );

    expect(outcome.kind).toBe("offer");
  });
});
