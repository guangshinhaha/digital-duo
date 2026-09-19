import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import {
  consultPredecessorDuo,
  isLiveMatterQuestion,
  stalenessHedge,
  stalenessLevel,
} from "../src/continuity/predecessor.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { InferenceProvider } from "../src/provider/types.js";
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

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string; timestamp: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

/**
 * Seeds one question/answer pair, timestamped `answerTimestamp` (so
 * evidence age is controllable per test), and backfills embeddings — the
 * same fake bag-of-synonyms provider `drafting-pipeline.test.ts` uses,
 * which is why every fixture's vocabulary below stays inside its "leave"
 * synonym group rather than using unrelated words the fake provider can't
 * recognise at all. The answer is marked "OFFICIAL (OPEN)" (same
 * convention `public-answer.test.ts` uses) because a predecessor
 * consultation is filtered to the same lowest-defined-clearance ceiling
 * public answering uses (see predecessor.ts's own doc comment) — a
 * successor is not the predecessor's own eyes, so unmarked ("unknown")
 * material stays invisible here exactly as it does for a public answer.
 * Both records carry the marking (not only the answer) purely so two
 * pieces of evidence clear the ceiling — matching this fixture's own
 * retrieval-strength math — not because a real predecessor's own question
 * text would realistically carry a classification marking.
 */
async function seedExchange(storePath: string, questionText: string, answerText: string, answerTimestamp: string): Promise<void> {
  const question = record({ kind: "question_to_me", author: "other", text: `OFFICIAL (OPEN)\n${questionText}`, timestamp: answerTimestamp, threadId: "shared" });
  const answer = record({ text: `OFFICIAL (OPEN)\n${answerText}`, timestamp: answerTimestamp, threadId: "shared" });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  await embedRecords(storePath, PASSPHRASE, createFakeEmbeddingProvider());
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("stalenessLevel / stalenessHedge — #61 AC3: staleness increases visibly with time", () => {
  it("moves through fresh, aging, stale, very_stale as age increases, never staying constant", () => {
    expect(stalenessLevel(0)).toBe("fresh");
    expect(stalenessLevel(29)).toBe("fresh");
    expect(stalenessLevel(30)).toBe("aging");
    expect(stalenessLevel(89)).toBe("aging");
    expect(stalenessLevel(90)).toBe("stale");
    expect(stalenessLevel(179)).toBe("stale");
    expect(stalenessLevel(180)).toBe("very_stale");
    expect(stalenessLevel(400)).toBe("very_stale");
  });

  it("treats no dated evidence at all as maximally cautious, not as neutral or fresh", () => {
    expect(stalenessLevel(null)).toBe("very_stale");
  });

  it("hedges more strongly as the level climbs, for the same stated date", () => {
    const date = "2026-01-01T00:00:00.000Z";
    const fresh = stalenessHedge("fresh", 5, date);
    const aging = stalenessHedge("aging", 40, date);
    const stale = stalenessHedge("stale", 100, date);
    const veryStale = stalenessHedge("very_stale", 200, date);
    expect(fresh).not.toMatch(/out of date|stale/);
    expect(aging).toContain("treat this as dated");
    expect(stale).toContain("may well be out of date");
    expect(veryStale).toContain("likely stale");
    // Strictly more cautious wording at each step — never the same text twice.
    expect(new Set([fresh, aging, stale, veryStale]).size).toBe(4);
  });
});

describe("isLiveMatterQuestion — #61 AC2's live-matter detector", () => {
  it("matches present-tense phrasing", () => {
    expect(isLiveMatterQuestion("what is the current policy on this")).toBe(true);
    expect(isLiveMatterQuestion("is this still the policy")).toBe(true);
    expect(isLiveMatterQuestion("what should I do right now")).toBe(true);
  });

  it("does not match a plain historical question, and is not fooled by a word merely containing the substring 'now'", () => {
    expect(isLiveMatterQuestion("why was the freeze window set to 3 days")).toBe(false);
    expect(isLiveMatterQuestion("I don't know why that decision was made")).toBe(false);
  });
});

describe("consultPredecessorDuo — #61 AC1: answers as a historical record", () => {
  it("names the predecessor, states the answer is historical, and states the evidence's date prominently", async () => {
    const storePath = initStore();
    const timestamp = daysAgo(5);
    await seedExchange(storePath, "how many days of leave do I get", "Leave is five days per quarter.", timestamp);
    const embeddingProvider = createFakeEmbeddingProvider();
    const inferenceProvider = agreeingProvider("Leave is five days per quarter.");

    const result = await consultPredecessorDuo(
      storePath,
      PASSPHRASE,
      duoDir(),
      "Alice",
      "how many days of leave do I get",
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("historical");
    expect(result.text).toContain("Alice");
    expect(result.text).toContain("historical record");
    expect(result.text).toContain(timestamp.slice(0, 10));
    expect(result.stalenessLevel).toBe("fresh");
    expect(result.evidenceTimestamp).toBe(timestamp);
  });
});

describe("consultPredecessorDuo — #61 AC2: cannot speak in the present tense about live matters", () => {
  it("declines to answer as though current, offers the historical position, and says the position may have changed", async () => {
    const storePath = initStore();
    const timestamp = daysAgo(200);
    await seedExchange(storePath, "how many days of leave do I get", "Leave is five days per quarter.", timestamp);
    const embeddingProvider = createFakeEmbeddingProvider();
    const inferenceProvider = agreeingProvider("Leave is five days per quarter.");

    const result = await consultPredecessorDuo(
      storePath,
      PASSPHRASE,
      duoDir(),
      "Alice",
      "is leave still five days per quarter right now",
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("declined_live");
    expect(result.text).toContain("cannot speak to the current position");
    expect(result.text).toContain("may have changed since");
    // Still offers the historical position rather than an empty refusal.
    expect(result.text).toContain("Leave is five days per quarter.");
  });
});

describe("consultPredecessorDuo — #61 AC3: staleness increases visibly with time", () => {
  it("hedges more strongly for a duo dormant many months than for one consulted about recent evidence", async () => {
    const freshStore = initStore();
    await seedExchange(freshStore, "how many days of leave do I get", "Leave is five days per quarter.", daysAgo(2));
    const staleStore = join(tempDir(), "stale", "data", "duo.db");
    createEncryptedStore(staleStore, PASSPHRASE);
    await seedExchange(staleStore, "how many days of leave do I get", "Leave is five days per quarter.", daysAgo(300));

    const embeddingProvider = createFakeEmbeddingProvider();
    const inferenceProvider = agreeingProvider("Leave is five days per quarter.");

    const fresh = await consultPredecessorDuo(
      freshStore,
      PASSPHRASE,
      duoDir(),
      "Alice",
      "how many days of leave do I get",
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );
    const stale = await consultPredecessorDuo(
      staleStore,
      PASSPHRASE,
      join(tempDir(), "stale", "duo"),
      "Alice",
      "how many days of leave do I get",
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );

    expect(fresh.stalenessLevel).toBe("fresh");
    expect(stale.stalenessLevel).toBe("very_stale");
    expect(stale.text).toContain("likely stale");
    expect(fresh.text).not.toContain("likely stale");
  });
});

describe("consultPredecessorDuo — an escalation with no grounding passes through unrenamed", () => {
  it("names the predecessor's duo has nothing dated to answer from, without inventing a historical position", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await consultPredecessorDuo(
      storePath,
      PASSPHRASE,
      duoDir(),
      "Alice",
      "why is the freeze window 3 days",
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    expect(result.text).toContain("Alice's duo has nothing dated to answer this from");
    expect(result.stalenessLevel).toBeNull();
    expect(result.evidenceTimestamp).toBeNull();
  });
});

describe("consultPredecessorDuo — never exposes unmarked ('unknown') material to a successor who is not the predecessor's own eyes", () => {
  it("escalates instead of answering from an unmarked record, even though the predecessor's own `duo draft` would answer confidently from the same corpus", async () => {
    const storePath = initStore();
    const questionText = "how many days of leave do I get";
    const answerText = "Leave is five days per quarter.";
    // Deliberately not going through seedExchange (which always marks the
    // answer "OFFICIAL (OPEN)"): this is exactly the unmarked ("unknown")
    // case a successor must never see, the same boundary #43 established
    // for public answering.
    const question = record({ kind: "question_to_me", author: "other", text: questionText, timestamp: daysAgo(2), threadId: "shared" });
    const answer = record({ text: answerText, timestamp: daysAgo(2), threadId: "shared" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    await embedRecords(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    const result = await consultPredecessorDuo(
      storePath,
      PASSPHRASE,
      duoDir(),
      "Alice",
      questionText,
      createFakeEmbeddingProvider(),
      agreeingProvider(answerText),
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    expect(result.text).not.toContain("five days");
  });
});
