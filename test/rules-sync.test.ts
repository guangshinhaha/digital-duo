import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { listRuleEvidence, listRules, runRuleInduction } from "../src/derivation/rules.js";
import { parseRuleFile, serializeRuleFile, syncRulesFiles } from "../src/derivation/rules-sync.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";

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

function ruleFile(topicId: string): string {
  return join(duoDir(), "rules", `${topicId}.md`);
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

async function seedConfirmedRule(storePath: string, topicId: string): Promise<void> {
  const records = ["five days per quarter, vacation policy", "five days per quarter, vacation policy", "five days per quarter, vacation policy"].flatMap(
    (text) => {
      const question = record({ kind: "question_to_me", author: "other", text: "a question" });
      const answer = record({ kind: "my_answer", author: "me", text, threadId: question.threadId });
      return [question, answer];
    },
  );
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
  await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
}

describe("syncRulesFiles — a rule round-trips between file and store", () => {
  it("materializes a freshly induced rule to a file, and a hand-edit to that file wins on the next sync", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");

    const first = syncRulesFiles(storePath, PASSPHRASE, dir);
    expect(first.synced).toEqual(["topic-leave"]);
    expect(existsSync(ruleFile("topic-leave"))).toBe(true);

    const rule = listRules(storePath, PASSPHRASE)[0];
    expect(rule.text).toBe("five days per quarter, vacation policy");

    // Hand-edit, as an owner would in an editor.
    const content = readFileSync(ruleFile("topic-leave"), "utf8");
    const edited = content.replace(rule.text, "Employees get five paid vacation days per quarter.");
    writeFileSync(ruleFile("topic-leave"), edited);

    const second = syncRulesFiles(storePath, PASSPHRASE, dir);
    expect(second.synced).toEqual(["topic-leave"]);
    expect(second.malformed).toEqual([]);

    const updated = listRules(storePath, PASSPHRASE)[0];
    expect(updated.text).toBe("Employees get five paid vacation days per quarter.");
  });

  it("re-running duo derive rules afterward does not clobber the hand-edit, because sync runs after it", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");
    syncRulesFiles(storePath, PASSPHRASE, dir);

    const content = readFileSync(ruleFile("topic-leave"), "utf8");
    writeFileSync(ruleFile("topic-leave"), content.replace("five days per quarter, vacation policy", "Edited policy text."));

    // Induction alone (without a following sync) would recompute the rule from the corpus again...
    await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
    expect(listRules(storePath, PASSPHRASE)[0].text).not.toBe("Edited policy text.");

    // ...but syncing afterward re-asserts the file's edit.
    syncRulesFiles(storePath, PASSPHRASE, dir);
    expect(listRules(storePath, PASSPHRASE)[0].text).toBe("Edited policy text.");
  });
});

describe("syncRulesFiles — a malformed hand-edit is reported, not silently dropped", () => {
  it("names the file and the problem, leaves the previous good version in the store, and does not delete the file", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");
    syncRulesFiles(storePath, PASSPHRASE, dir);
    const goodText = listRules(storePath, PASSPHRASE)[0].text;

    writeFileSync(ruleFile("topic-leave"), "this is not valid frontmatter at all");

    const result = syncRulesFiles(storePath, PASSPHRASE, dir);

    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].file).toBe(ruleFile("topic-leave"));
    expect(result.malformed[0].reason).toMatch(/frontmatter/i);
    expect(result.deleted).toEqual([]);

    // Previous good version untouched in the store.
    expect(listRules(storePath, PASSPHRASE)[0].text).toBe(goodText);
    // File itself is left in place, not deleted.
    expect(existsSync(ruleFile("topic-leave"))).toBe(true);
  });

  it("catches a bad status value, a non-numeric support count, and a missing id, each independently", () => {
    const base = {
      id: "topic-x",
      topicId: "topic-x",
      status: "confirmed" as const,
      supportCount: 3,
      consistency: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastConfirmedAt: null,
      reviewStatus: "pending" as const,
      origin: "derived" as const,
      text: "some rule text",
    };

    expect(() => parseRuleFile("f", serializeRuleFile({ ...base, status: "bogus" as never }, []))).toThrow(/status/i);
    expect(() =>
      parseRuleFile("f", serializeRuleFile(base, []).replace("support: 3", "support: not-a-number")),
    ).toThrow(/support/i);
    expect(() => parseRuleFile("f", serializeRuleFile(base, []).replace('id: "topic-x"\n', ""))).toThrow(/id/i);
  });
});

describe("syncRulesFiles — deleting a rule file removes it from retrieval", () => {
  it("removes the rule and its evidence from the store once its file is deleted and sync is run", async () => {
    const { unlinkSync } = await import("node:fs");
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");
    syncRulesFiles(storePath, PASSPHRASE, dir);
    expect(listRules(storePath, PASSPHRASE)).toHaveLength(1);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;
    expect(listRuleEvidence(storePath, PASSPHRASE, ruleId).length).toBeGreaterThan(0);

    unlinkSync(ruleFile("topic-leave"));
    const result = syncRulesFiles(storePath, PASSPHRASE, dir);

    expect(result.deleted).toEqual(["topic-leave"]);
    expect(listRules(storePath, PASSPHRASE)).toEqual([]);
    expect(listRuleEvidence(storePath, PASSPHRASE, ruleId)).toEqual([]);
  });

  it("does not delete a freshly induced rule that has simply never been materialized to a file yet", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");

    // First sync ever — nothing to delete, only to materialize.
    const result = syncRulesFiles(storePath, PASSPHRASE, dir);
    expect(result.deleted).toEqual([]);
    expect(result.synced).toEqual(["topic-leave"]);
  });
});

describe("duo/rules/*.md is one file per rule with YAML frontmatter", () => {
  it("carries id, topic, support, evidence, and timestamps, with the rule text as the markdown body", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");
    syncRulesFiles(storePath, PASSPHRASE, dir);

    const content = readFileSync(ruleFile("topic-leave"), "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/id: "topic-leave"/);
    expect(content).toMatch(/topic: "topic-leave"/);
    expect(content).toMatch(/support: 3/);
    expect(content).toMatch(/evidence:\n(\s+- ".+"\n)+/);
    expect(content).toMatch(/created_at: ".+"/);
    expect(content).toContain("five days per quarter, vacation policy");
  });
});

describe("duo/rules/*.md carries the owner's review decision (#28)", () => {
  it("writes review_status and origin, defaulting to pending/derived for a freshly induced rule", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedConfirmedRule(storePath, "topic-leave");
    syncRulesFiles(storePath, PASSPHRASE, dir);

    const content = readFileSync(ruleFile("topic-leave"), "utf8");
    expect(content).toMatch(/review_status: pending/);
    expect(content).toMatch(/origin: derived/);
  });

  it("parses a pre-#28 file with neither field, defaulting to pending/derived rather than failing", () => {
    const base = {
      id: "topic-x",
      topicId: "topic-x",
      status: "confirmed" as const,
      supportCount: 3,
      consistency: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastConfirmedAt: null,
      reviewStatus: "pending" as const,
      origin: "derived" as const,
      text: "some rule text",
    };
    const legacyContent = serializeRuleFile(base, [])
      .replace(/review_status: pending\n/, "")
      .replace(/origin: derived\n/, "");
    const { rule } = parseRuleFile("f", legacyContent);
    expect(rule.reviewStatus).toBe("pending");
    expect(rule.origin).toBe("derived");
  });

  it("rejects an invalid review_status or origin value", () => {
    const base = {
      id: "topic-x",
      topicId: "topic-x",
      status: "confirmed" as const,
      supportCount: 3,
      consistency: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastConfirmedAt: null,
      reviewStatus: "pending" as const,
      origin: "derived" as const,
      text: "some rule text",
    };
    expect(() =>
      parseRuleFile("f", serializeRuleFile(base, []).replace("review_status: pending", "review_status: bogus")),
    ).toThrow(/review_status/i);
    expect(() => parseRuleFile("f", serializeRuleFile(base, []).replace("origin: derived", "origin: bogus"))).toThrow(/origin/i);
  });
});
