import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import {
  InvalidReviewActionError,
  RefusalConflictError,
  RuleNotFoundError,
  approveRule,
  describeRuleWithEvidence,
  listActiveRules,
  listRefusalConflicts,
  listRulesForReview,
  promoteRule,
  rejectRule,
  writeRuleByHand,
} from "../src/derivation/rule-review.js";
import { parseRuleFile } from "../src/derivation/rules-sync.js";
import { listRules, runRuleInduction } from "../src/derivation/rules.js";
import { readTopicsFile } from "../src/derivation/topics.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";
import { upsertRefusal } from "../src/trust/refusals.js";
import { readFileSync } from "node:fs";

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

/** Seeds one rule for `topicId` at the given derivation status by controlling how many (and how consistent) supporting pairs it gets. */
async function seedRule(
  storePath: string,
  topicId: string,
  answerTexts: string[],
): Promise<void> {
  const records = answerTexts.flatMap((text) => {
    const question = record({ kind: "question_to_me", author: "other", text: "a question" });
    const answer = record({ kind: "my_answer", author: "me", text, threadId: question.threadId });
    return [question, answer];
  });
  writeRecords(storePath, PASSPHRASE, records);
  const { pairs } = await extractQaPairs(records);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
  await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
}

const CONFIRMED_ANSWERS = ["five days per quarter, vacation policy", "five days per quarter, vacation policy", "five days per quarter, vacation policy"];
const WEAK_ANSWERS = ["only one supporting pair, vacation"];
const INCONSISTENT_ANSWERS = ["vacation policy is five days", "printer is broken today", "budget report due friday"];

describe("approveRule — AC1: approving a confirmed rule with visible evidence", () => {
  it("marks a confirmed rule approved and rewrites its file", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-leave", CONFIRMED_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;

    const approved = approveRule(storePath, PASSPHRASE, dir, ruleId);
    expect(approved.reviewStatus).toBe("approved");
    expect(approved.origin).toBe("derived");

    const fileContent = readFileSync(ruleFile(ruleId), "utf8");
    expect(parseRuleFile(ruleFile(ruleId), fileContent).rule.reviewStatus).toBe("approved");
  });

  it("shows the exchanges a rule's citations point to", async () => {
    const storePath = initStore();
    await seedRule(storePath, "topic-leave", CONFIRMED_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;

    const { rule, evidence } = describeRuleWithEvidence(storePath, PASSPHRASE, ruleId);
    expect(rule.id).toBe(ruleId);
    expect(evidence.length).toBe(3);
    for (const exchange of evidence) {
      expect(exchange.questionText).toBe("a question");
      expect(exchange.answerText).toBe("five days per quarter, vacation policy");
    }
  });

  it("refuses to approve a weak_signal or inconsistent rule, naming the actual status", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-thin", WEAK_ANSWERS);
    const weakId = listRules(storePath, PASSPHRASE)[0].id;
    expect(() => approveRule(storePath, PASSPHRASE, dir, weakId)).toThrow(InvalidReviewActionError);
    expect(() => approveRule(storePath, PASSPHRASE, dir, weakId)).toThrow(/weak_signal/);
  });

  it("throws RuleNotFoundError for an unknown rule id", () => {
    const storePath = initStore();
    expect(() => approveRule(storePath, PASSPHRASE, duoDir(), "no-such-rule")).toThrow(RuleNotFoundError);
  });
});

describe("rejectRule — AC2: a rejected rule stays rejected across re-induction", () => {
  it("marks any status rejected, and re-running induction does not reset it to pending", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-leave", CONFIRMED_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;

    const rejected = rejectRule(storePath, PASSPHRASE, dir, ruleId);
    expect(rejected.reviewStatus).toBe("rejected");

    // More confirming evidence arrives; induction recomputes support/consistency...
    await seedRule(storePath, "topic-leave", ["five days per quarter, vacation policy"]);
    const rules = listRules(storePath, PASSPHRASE);
    expect(rules[0].status).toBe("confirmed"); // derivation status still recomputed
    expect(rules[0].reviewStatus).toBe("rejected"); // ...but the rejection itself is not undone
  });

  it("rejects an inconsistent rule too", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-mixed", INCONSISTENT_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;
    expect(listRules(storePath, PASSPHRASE)[0].status).toBe("inconsistent");
    const rejected = rejectRule(storePath, PASSPHRASE, dir, ruleId);
    expect(rejected.reviewStatus).toBe("rejected");
  });
});

describe("promoteRule — AC3: a weak signal promoted by hand is owner-asserted, not evidence-backed", () => {
  it("marks a weak_signal rule approved with origin owner_asserted", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-thin", WEAK_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;

    const promoted = promoteRule(storePath, PASSPHRASE, dir, ruleId);
    expect(promoted.reviewStatus).toBe("approved");
    expect(promoted.origin).toBe("owner_asserted");
    expect(listActiveRules(storePath, PASSPHRASE, dir).map((rule) => rule.id)).toContain(ruleId);
  });

  it("refuses to promote a rule that isn't a weak signal", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-leave", CONFIRMED_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;
    expect(() => promoteRule(storePath, PASSPHRASE, dir, ruleId)).toThrow(InvalidReviewActionError);
  });
});

describe("writeRuleByHand — AC4: writing a rule from scratch when nothing cleared threshold", () => {
  it("mints a new topic and an approved, owner-asserted rule with no evidence", () => {
    const storePath = initStore();
    const dir = duoDir();
    const rule = writeRuleByHand(storePath, PASSPHRASE, dir, "Expense approvals", "I never approve expenses over $500 without finance sign-off.");

    expect(rule.status).toBe("confirmed");
    expect(rule.reviewStatus).toBe("approved");
    expect(rule.origin).toBe("owner_asserted");
    expect(rule.supportCount).toBe(0);
    expect(rule.text).toBe("I never approve expenses over $500 without finance sign-off.");

    const topics = readTopicsFile(dir);
    expect(topics.find((topic) => topic.id === rule.topicId)?.label).toBe("Expense approvals");
    expect(listActiveRules(storePath, PASSPHRASE, dir).map((r) => r.id)).toContain(rule.id);
  });

  it("refuses an empty label or empty text", () => {
    const storePath = initStore();
    const dir = duoDir();
    expect(() => writeRuleByHand(storePath, PASSPHRASE, dir, "  ", "some text")).toThrow(InvalidReviewActionError);
    expect(() => writeRuleByHand(storePath, PASSPHRASE, dir, "a label", "  ")).toThrow(InvalidReviewActionError);
  });
});

describe("listRulesForReview — AC4: no rules cleared threshold at all", () => {
  it("reports zero awaiting approval and surfaces weak signals instead", async () => {
    const storePath = initStore();
    await seedRule(storePath, "topic-thin", WEAK_ANSWERS);

    const listing = listRulesForReview(storePath, PASSPHRASE);
    expect(listing.awaitingApproval).toEqual([]);
    expect(listing.weakSignals).toHaveLength(1);
    expect(listing.weakSignals[0].status).toBe("weak_signal");
  });

  it("splits confirmed-but-unreviewed from already approved/rejected rules", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-a", CONFIRMED_ANSWERS);
    await seedRule(storePath, "topic-b", CONFIRMED_ANSWERS);
    const rules = listRules(storePath, PASSPHRASE);
    approveRule(storePath, PASSPHRASE, dir, rules.find((r) => r.topicId === "topic-a")!.id);

    const listing = listRulesForReview(storePath, PASSPHRASE);
    expect(listing.approved).toHaveLength(1);
    expect(listing.awaitingApproval).toHaveLength(1);
    expect(listing.awaitingApproval[0].topicId).toBe("topic-b");
  });

  it("excludes a rejected rule from weakSignals/inconsistent even though its derivation status still matches", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-thin", WEAK_ANSWERS);
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;
    rejectRule(storePath, PASSPHRASE, dir, ruleId);

    const listing = listRulesForReview(storePath, PASSPHRASE);
    expect(listing.weakSignals).toEqual([]);
    expect(listing.rejected).toHaveLength(1);
  });
});

describe("refusal conflicts — #29 AC3: a refusal outranks a conflicting derived rule", () => {
  it("refuses to approve a confirmed rule whose topic conflicts with a standing refusal", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-leave", CONFIRMED_ANSWERS);
    // The topic's own label, from #24's default labeler, is one of the answer texts truncated —
    // simplest to just refuse by the topic id directly, which findConflictingRefusal also matches.
    upsertRefusal(dir, "topic-leave", "Never speak for me on leave policy.");

    expect(() => approveRule(storePath, PASSPHRASE, dir, "topic-leave")).toThrow(RefusalConflictError);
    expect(listRules(storePath, PASSPHRASE)[0].reviewStatus).toBe("pending"); // untouched
  });

  it("refuses to promote a weak signal whose topic conflicts with a standing refusal", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-thin", WEAK_ANSWERS);
    upsertRefusal(dir, "topic-thin", "reason");

    expect(() => promoteRule(storePath, PASSPHRASE, dir, "topic-thin")).toThrow(RefusalConflictError);
  });

  it("refuses to write a hand rule whose label conflicts with a standing refusal, before minting a topic", () => {
    const storePath = initStore();
    const dir = duoDir();
    upsertRefusal(dir, "Headcount", "Never speak for me on this.");

    expect(() => writeRuleByHand(storePath, PASSPHRASE, dir, "Headcount", "some rule text")).toThrow(RefusalConflictError);
    expect(readTopicsFile(dir)).toEqual([]); // no topic minted for the refused attempt
  });

  it("a refusal written AFTER approval still suppresses the rule from listActiveRules (the guarantee holds unconditionally)", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedRule(storePath, "topic-leave", CONFIRMED_ANSWERS);
    const approved = approveRule(storePath, PASSPHRASE, dir, "topic-leave");
    expect(listActiveRules(storePath, PASSPHRASE, dir).map((r) => r.id)).toContain(approved.id);

    upsertRefusal(dir, "topic-leave", "Changed my mind — never speak on this.");

    expect(listActiveRules(storePath, PASSPHRASE, dir).map((r) => r.id)).not.toContain(approved.id);
    // The stored decision itself is untouched — it really was approved at the time.
    expect(listRules(storePath, PASSPHRASE)[0].reviewStatus).toBe("approved");

    const conflicts = listRefusalConflicts(storePath, PASSPHRASE, dir);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].rule.id).toBe(approved.id);
    expect(conflicts[0].refusal.heading).toBe("topic-leave");
  });
});
