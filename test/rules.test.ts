import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, listQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { listRuleEvidence, listRules, runRuleInduction } from "../src/derivation/rules.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: `ref-${counter}`,
    kind: "my_thinking",
    author: "other",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** Seeds one question/answer pair per given answer text (each in its own thread), all pre-assigned to `topicId`. Returns the pair ids in order. */
async function seedTopicPairs(storePath: string, topicId: string, answerTexts: string[]): Promise<string[]> {
  const records = answerTexts.flatMap((text) => {
    const question = record({ kind: "question_to_me", author: "other", text: "a question" });
    const answer = record({ kind: "my_answer", author: "me", text, threadId: question.threadId });
    return [question, answer];
  });
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
  return pairs.map((pair) => pair.id);
}

describe("runRuleInduction — a consistent pattern becomes a cited rule", () => {
  it("produces a rule with citations to the supporting pairs and a support count", async () => {
    const storePath = initStore();
    const pairIds = await seedTopicPairs(storePath, "topic-leave", [
      "five days per quarter, per the vacation policy",
      "five days per quarter, per the vacation policy",
      "five days per quarter, per the vacation policy",
    ]);

    const result = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    expect(result.confirmedCount).toBe(1);
    const rule = result.rules[0];
    expect(rule.status).toBe("confirmed");
    expect(rule.supportCount).toBe(3);
    expect(rule.text).toBe("five days per quarter, per the vacation policy");
    expect(rule.lastConfirmedAt).not.toBeNull();

    const evidence = listRuleEvidence(storePath, PASSPHRASE, rule.id);
    expect(evidence.sort()).toEqual([...pairIds].sort());
    expect(evidence.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runRuleInduction — an inconsistent topic produces no confident rule", () => {
  it("records the topic as inconsistent with its conflicting examples instead of promoting a rule", async () => {
    const storePath = initStore();
    await seedTopicPairs(storePath, "topic-mixed", [
      "five days per quarter, vacation policy",
      "the printer on the third floor is broken, hardware issue",
      "finalize the budget report, deadline finance",
    ]);

    const result = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    expect(result.confirmedCount).toBe(0);
    expect(result.inconsistentCount).toBe(1);
    const rule = result.rules[0];
    expect(rule.status).toBe("inconsistent");
    expect(rule.text).toMatch(/no consistent answer/i);
    expect(rule.text).toContain("vacation");
    // Still carries evidence — the disagreement itself is visible, not silently dropped.
    expect(listRuleEvidence(storePath, PASSPHRASE, rule.id).length).toBe(3);
  });
});

describe("runRuleInduction — thin topics become weak signals, not silence", () => {
  it("produces a below-threshold candidate for a topic with only one or two pairs", async () => {
    const storePath = initStore();
    await seedTopicPairs(storePath, "topic-thin", ["only one supporting pair so far, vacation"]);

    const result = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    expect(result.weakSignalCount).toBe(1);
    expect(result.confirmedCount).toBe(0);
    const rule = result.rules[0];
    expect(rule.status).toBe("weak_signal");
    expect(rule.supportCount).toBe(1);
    expect(listRuleEvidence(storePath, PASSPHRASE, rule.id)).toHaveLength(1);
  });
});

describe("runRuleInduction — every rule carries at least one rule_evidence row, and support/consistency are stored", () => {
  it("stores support_count and consistency as real columns, not just used and discarded", async () => {
    const storePath = initStore();
    await seedTopicPairs(storePath, "topic-leave", [
      "five days per quarter, vacation policy",
      "five days per quarter, vacation policy",
      "five days per quarter, vacation policy",
    ]);
    await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    const rules = listRules(storePath, PASSPHRASE);
    expect(rules).toHaveLength(1);
    expect(rules[0].supportCount).toBe(3);
    expect(rules[0].consistency).toBeGreaterThan(0.9);
    expect(listRuleEvidence(storePath, PASSPHRASE, rules[0].id).length).toBeGreaterThanOrEqual(1);
  });
});

describe("runRuleInduction — re-running updates the same rule rather than duplicating it", () => {
  it("keeps created_at stable and updates last_confirmed_at as new confirming evidence arrives", async () => {
    const storePath = initStore();
    await seedTopicPairs(storePath, "topic-leave", ["only one pair, vacation"]);
    const first = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
    expect(first.rules[0].status).toBe("weak_signal");
    const createdAt = first.rules[0].createdAt;

    await seedTopicPairs(storePath, "topic-leave", [
      "five days per quarter, vacation policy",
      "five days per quarter, vacation policy",
    ]);
    const second = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    expect(listRules(storePath, PASSPHRASE)).toHaveLength(1); // still one rule, not two
    const rule = second.rules[0];
    expect(rule.status).toBe("confirmed");
    expect(rule.createdAt).toBe(createdAt);
    expect(rule.supportCount).toBe(3);
  });

  it("fully replaces rule_evidence on each run rather than accumulating stale citations", async () => {
    const storePath = initStore();
    const firstPairIds = await seedTopicPairs(storePath, "topic-leave", ["vacation policy answer one"]);
    const first = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
    expect(listRuleEvidence(storePath, PASSPHRASE, first.rules[0].id)).toEqual(firstPairIds);

    // Reassign that pair away from the topic entirely (simulating a later re-derivation), leaving nothing for this topic.
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.prepare(`UPDATE qa_pairs SET topic_id = NULL WHERE id = ?`).run(firstPairIds[0]);
    });
    expect(listQaPairs(storePath, PASSPHRASE).filter((pair) => pair.topicId === "topic-leave")).toEqual([]);

    const secondPairIds = await seedTopicPairs(storePath, "topic-leave", ["vacation policy answer two"]);
    await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());

    expect(listRuleEvidence(storePath, PASSPHRASE, "topic-leave")).toEqual(secondPairIds);
  });
});

describe("runRuleInduction — labeling", () => {
  it("uses a supplied rule-text generator only for the confirmed case", async () => {
    const storePath = initStore();
    await seedTopicPairs(storePath, "topic-leave", [
      "five days per quarter, vacation policy",
      "five days per quarter, vacation policy",
      "five days per quarter, vacation policy",
    ]);

    const result = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider(), {
      generateRuleText: async () => "Employees get five paid vacation days per quarter.",
    });

    expect(result.rules[0].text).toBe("Employees get five paid vacation days per quarter.");
  });
});

describe("runRuleInduction — an empty store is a no-op", () => {
  it("induces nothing when there are no topic-assigned pairs", async () => {
    const storePath = initStore();
    const result = await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
    expect(result).toEqual({ rules: [], confirmedCount: 0, inconsistentCount: 0, weakSignalCount: 0 });
  });
});
