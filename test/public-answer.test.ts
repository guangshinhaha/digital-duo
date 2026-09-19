import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { getDraft } from "../src/drafting/draft-log.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { writeRefusalsFile } from "../src/trust/refusals.js";
import { listGrid } from "../src/trust/grid.js";
import { answerPublicly, PUBLIC_PASSED_ON_MESSAGE, PUBLIC_REFUSAL_MESSAGE } from "../src/permissions/public-answer.js";
import { listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;
const OWNER_NAME = "Dana Cole";

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

/** A confirmed, approved rule on "topic-leave", the corpus's answer publicly markable (or not) via `markPublic`. */
async function seedLeaveTopic(storePath: string, markPublic: boolean): Promise<void> {
  const answerText = "five days per quarter, per the vacation policy";
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: markPublic ? `OFFICIAL (OPEN)\n${answerText}` : answerText, threadId: "shared" });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  const embeddingProvider = createFakeEmbeddingProvider();
  await embedRecords(storePath, PASSPHRASE, embeddingProvider);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-leave",
        topicId: "topic-leave",
        text: "Standard leave is five days per quarter.",
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

function writeLeaveTopicFile(dir: string): void {
  writeTopicsFile(dir, [{ id: "topic-leave", label: "Vacation leave", createdAt: new Date().toISOString() }]);
}

describe("answerPublicly — a granted topic is answered directly (#43 AC1)", () => {
  it("answers in thread with its sources, and logs the exchange against the owner", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-1",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");
    expect(outcome.text).toContain("Five days per quarter, per policy.");
    expect(outcome.topicId).toBe("topic-leave");
    expect(outcome.sources.length).toBeGreaterThan(0);

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: "answered", askerRef: "colleague-1", topicId: "topic-leave" });
  });
});

describe("answerPublicly — an ungranted topic is not answered (#43 AC2)", () => {
  it("keeps the answer private and tells the asker it was passed on, without ever granting T0 first", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    // No grantAutonomy call — "topic-leave" stays at the default "ask".

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-2",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("passed_on");
    if (outcome.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(outcome.message).toContain(PUBLIC_PASSED_ON_MESSAGE);
    expect(outcome.message).not.toMatch(/five days/i);
    expect(outcome.topicId).toBe("topic-leave");

    // The v1 private draft still ran underneath, exactly as it always does.
    const privateDraft = getDraft(storePath, PASSPHRASE, outcome.draftId);
    expect(privateDraft?.draftText).toBe("Five days per quarter, per policy.");
    expect(privateDraft?.escalated).toBe(false);

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0].outcome).toBe("passed_on");
    expect(logged[0].text).toBe(outcome.message);
  });
});

describe("answerPublicly — a refused subject is declined visibly (#43 AC3)", () => {
  it("says plainly it does not speak for the owner, without hinting at the answer, even though the topic is granted", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });
    writeRefusalsFile(dir, [{ heading: "vacation", reason: "Leave policy is under review; don't speak for me on it." }]);

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-3",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("declined_refused");
    if (outcome.kind !== "declined_refused") throw new Error("expected a declined_refused outcome");
    expect(outcome.message).toContain(PUBLIC_REFUSAL_MESSAGE);
    expect(outcome.message).not.toMatch(/five days/i);
    expect(outcome.message).not.toMatch(/under review/i);

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0].outcome).toBe("declined_refused");
  });
});

describe("answerPublicly — low confidence escalates instead of hedging (#43 AC4)", () => {
  it("passes the question on rather than posting a vague-but-defensible public answer", async () => {
    const storePath = initStore();
    const dir = duoDir();

    const question = record({ kind: "question_to_me", author: "other", text: "third floor printer broken, who do I call", threadId: "printer-thread" });
    const answer = record({ text: "OFFICIAL (OPEN)\nIT handles printer hardware issues on that floor", threadId: "printer-thread" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);
    const { pairs } = await extractQaPairs([question, answer]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-printer" })));
    // Deliberately no confirmed rule for this topic — only the weak evidence signal exists.
    writeTopicsFile(dir, [{ id: "topic-printer", label: "Printer support", createdAt: new Date().toISOString() }]);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "printer support", tier: "T0", topicId: "topic-printer" });
    expect(listGrid(storePath, PASSPHRASE, dir).find((row) => row.topicId === "topic-printer")?.level).toBe("auto");

    // Every sample disagrees with the last and embeds to an all-zero vector
    // (no synonym-group word in common) — self-consistency scores 0, and
    // the self-report ask is equally unparseable, defaulting to neutral.
    let calls = 0;
    const disagreeingProvider: InferenceProvider = {
      name: "fake",
      async complete() {
        calls += 1;
        return `alternative reply number ${calls}`;
      },
    };

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "third floor printer broken, who do I call",
      "colleague-4",
      embeddingProvider,
      disagreeingProvider,
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("passed_on");
    if (outcome.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(outcome.message).toContain(PUBLIC_PASSED_ON_MESSAGE);
  });
});

describe("answerPublicly — never exposes unmarked ('unknown') material, even to a granted, confident topic", () => {
  it("keeps an unmarked answer private, the same as an ungranted one, because it fails the uniform public clearance ceiling", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, false); // no "OFFICIAL (OPEN)" marking — classification defaults to "unknown"
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-5",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    // The owner's own private `duo draft` would answer this confidently
    // (same corpus as the AC1 test, minus the marking) — but public
    // answering must never expose unmarked material to a wide audience.
    expect(outcome.kind).toBe("passed_on");
    if (outcome.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(outcome.message).not.toMatch(/five days/i);
  });
});

describe("answerPublicly — every public answer is labelled, never as the owner (#44 AC1)", () => {
  it("attributes an actual answer to the owner's duo, states confidence and evidence age, and links each source to its origin", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-6",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");
    expect(outcome.text).toContain(OWNER_NAME);
    expect(outcome.text).toMatch(/duo/i);
    // Attributed to the duo speaking, not phrased as the owner speaking in the first person.
    expect(outcome.text).not.toMatch(new RegExp(`^I am ${OWNER_NAME}`, "i"));
    expect(outcome.text).toContain(`Confidence: ${outcome.confidence.score.toFixed(2)}`);
    // A rule (the owner's own standing order) and a retrieved past exchange are both named, and told apart.
    expect(outcome.text).toMatch(/owner's own standing order/);
    expect(outcome.text).toMatch(/retrieved past exchange/);

    // The exact same labelled text is what got logged — there is no
    // unlabelled version of this answer anywhere.
    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged[0].text).toBe(outcome.text);
  });

  it("labels a passed-on message and a refusal too, without stating confidence or evidence age for either", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    // Ungranted — passed_on path.
    const passedOn = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-7",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );
    if (passedOn.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(passedOn.message).toContain(OWNER_NAME);
    expect(passedOn.message).not.toMatch(/confidence/i);

    writeRefusalsFile(dir, [{ heading: "vacation", reason: "under review" }]);
    const refused = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-8",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );
    if (refused.kind !== "declined_refused") throw new Error("expected a declined_refused outcome");
    expect(refused.message).toContain(OWNER_NAME);
    expect(refused.message).not.toMatch(/confidence/i);
  });

  it("names a different owner when configured with a different one — attribution is data, not a fixed string", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      "colleague-9",
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      "Priya Nair",
    );
    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");
    expect(outcome.text).toContain("Priya Nair");
    expect(outcome.text).not.toContain(OWNER_NAME);
  });
});
