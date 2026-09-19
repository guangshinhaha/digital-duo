import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import {
  CorrectionWriteError,
  NotActiveRuleError,
  writeCorrectionRule,
  writeRuleByHand,
} from "../src/derivation/rule-review.js";
import { listRules } from "../src/derivation/rules.js";
import { parseRuleFile } from "../src/derivation/rules-sync.js";
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

function ruleFile(ruleId: string): string {
  return join(duoDir(), "rules", `${ruleId}.md`);
}

describe("writeCorrectionRule — provenance (#39 AC1)", () => {
  it("carries the originating draft id and question into the rule's file and DB row, with a timestamp", () => {
    const storePath = initStore();
    const rule = writeCorrectionRule(storePath, PASSPHRASE, duoDir(), "office hours", "office hours are ten to six", "draft-123", "what are the office hours?");

    expect(rule.correctionDraftId).toBe("draft-123");
    expect(rule.correctionQuestion).toBe("what are the office hours?");
    expect(rule.createdAt).toBeTruthy();

    const fileContent = readFileSync(ruleFile(rule.id), "utf8");
    expect(fileContent).toContain('correction_draft_id: "draft-123"');
    expect(fileContent).toContain('correction_question: "what are the office hours?"');

    const stored = listRules(storePath, PASSPHRASE).find((r) => r.id === rule.id);
    expect(stored?.correctionDraftId).toBe("draft-123");
    expect(stored?.correctionQuestion).toBe("what are the office hours?");
  });

  it("leaves a plain hand-written rule (writeRuleByHand) with null provenance", () => {
    const storePath = initStore();
    const rule = writeRuleByHand(storePath, PASSPHRASE, duoDir(), "some topic", "some text");
    expect(rule.correctionDraftId).toBeNull();
    expect(rule.correctionQuestion).toBeNull();
    expect(rule.supersededByRuleId).toBeNull();
  });
});

describe("writeCorrectionRule — supersede (#39 AC3: retired, not duplicated)", () => {
  it("marks the old rule superseded with a pointer to its replacement, and only the replacement is active", () => {
    const storePath = initStore();
    const oldRule = writeRuleByHand(storePath, PASSPHRASE, duoDir(), "office hours", "office hours are nine to five");

    const newRule = writeCorrectionRule(
      storePath,
      PASSPHRASE,
      duoDir(),
      "office hours",
      "office hours are now ten to six",
      "draft-456",
      "what are the office hours?",
      oldRule.id,
    );

    const rules = listRules(storePath, PASSPHRASE);
    const storedOld = rules.find((r) => r.id === oldRule.id);
    const storedNew = rules.find((r) => r.id === newRule.id);

    expect(storedOld?.reviewStatus).toBe("superseded");
    expect(storedOld?.supersededByRuleId).toBe(newRule.id);
    expect(storedNew?.reviewStatus).toBe("approved");
    expect(storedNew?.supersededByRuleId).toBeNull();

    // The old rule's own file visibly shows it, readable in a plain editor (AC checklist).
    const oldFileContent = readFileSync(ruleFile(oldRule.id), "utf8");
    expect(oldFileContent).toContain("review_status: superseded");
    expect(oldFileContent).toContain(`superseded_by: "${newRule.id}"`);
  });

  it("refuses to supersede a rule that is not currently active", () => {
    const storePath = initStore();
    const rejectedTopicRule = writeRuleByHand(storePath, PASSPHRASE, duoDir(), "topic a", "text a");
    // Directly flip it to rejected via a second writeCorrectionRule chain is awkward; simplest is to
    // supersede it once (making it superseded), then try to supersede it again.
    const replacement = writeCorrectionRule(storePath, PASSPHRASE, duoDir(), "topic a", "text a v2", "draft-1", "q", rejectedTopicRule.id);

    expect(() =>
      writeCorrectionRule(storePath, PASSPHRASE, duoDir(), "topic a", "text a v3", "draft-2", "q", rejectedTopicRule.id),
    ).toThrow(NotActiveRuleError);
    // The already-superseded rule and its replacement are both untouched by the refused call.
    const rules = listRules(storePath, PASSPHRASE);
    expect(rules.find((r) => r.id === replacement.id)?.reviewStatus).toBe("approved");
  });

  it("throws RuleNotFoundError for an unknown supersedesRuleId", () => {
    const storePath = initStore();
    expect(() => writeCorrectionRule(storePath, PASSPHRASE, duoDir(), "topic a", "text a", "draft-1", "q", "no-such-rule")).toThrow();
  });
});

describe("writeCorrectionRule — a write failure leaves nothing half-applied (#39 AC2)", () => {
  it("fails with a clear message and writes nothing to the store when the rules directory can't be created", () => {
    const storePath = initStore();
    const dir = duoDir();
    // Force duo/rules to be unwritable-as-a-directory regardless of root:
    // make "rules" itself a plain file, so mkdirSync(..., {recursive:true})
    // throws ENOTDIR — the same class of failure the AC names (a read-only
    // directory or a full disk), without depending on DAC permission bits
    // a root-run test suite would otherwise ignore.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rules"), "not a directory", "utf8");

    expect(() => writeCorrectionRule(storePath, PASSPHRASE, dir, "topic a", "text a", "draft-1", "q")).toThrow(CorrectionWriteError);
    expect(listRules(storePath, PASSPHRASE)).toEqual([]);
  });

  it("leaves the rule being superseded untouched in the store when the write fails", () => {
    const storePath = initStore();
    const dir = duoDir();
    const oldRule = writeRuleByHand(storePath, PASSPHRASE, dir, "office hours", "office hours are nine to five");

    // Break the rules directory the same way, after the old rule already exists.
    rmSync(join(dir, "rules"), { recursive: true, force: true });
    writeFileSync(join(dir, "rules"), "not a directory", "utf8");

    expect(() =>
      writeCorrectionRule(storePath, PASSPHRASE, dir, "office hours", "office hours are ten to six", "draft-1", "q", oldRule.id),
    ).toThrow(CorrectionWriteError);

    const stored = listRules(storePath, PASSPHRASE).find((r) => r.id === oldRule.id);
    expect(stored?.reviewStatus).toBe("approved");
    expect(stored?.supersededByRuleId).toBeNull();
  });
});

describe("parseRuleFile — round-trips the new provenance/supersede fields", () => {
  it("parses null values back out for a plain rule", () => {
    const storePath = initStore();
    const rule = writeRuleByHand(storePath, PASSPHRASE, duoDir(), "topic a", "text a");
    const { rule: parsed } = parseRuleFile(ruleFile(rule.id), readFileSync(ruleFile(rule.id), "utf8"));
    expect(parsed.supersededByRuleId).toBeNull();
    expect(parsed.correctionDraftId).toBeNull();
    expect(parsed.correctionQuestion).toBeNull();
  });
});
