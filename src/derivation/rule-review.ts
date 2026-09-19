import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDatabase } from "../store/store.js";
import { getRecord } from "../ingest/record-store.js";
import { listQaPairs } from "./qa-pairs.js";
import { serializeRuleFile } from "./rules-sync.js";
import { listRuleEvidence, listRules, putRule, readRuleEvidenceRows, readRuleRow, type Rule } from "./rules.js";
import { readTopicsFile, writeTopicsFile, type Topic } from "./topics.js";

/**
 * The Mirror's rule review screen (#28, docs/concept.md §7): the owner
 * approves, rejects, or promotes what #25's induction proposed, and can
 * write a rule from scratch. Every mutation here immediately rewrites the
 * rule's file under `duo/rules/` — `duo/rules/*.md` is the source of truth
 * for humans (v1-tech-design.md §1.3), so a review decision has to land
 * there right away, not wait for the next `duo derive sync`, or the very
 * next induction run would recompute a fresh unreviewed rule text and
 * `duo derive sync` (files win) would silently re-materialize *that* over
 * an approval nobody wrote down anywhere durable.
 */
export class RuleNotFoundError extends Error {
  constructor(ruleId: string) {
    super(`No rule with id "${ruleId}"`);
    this.name = "RuleNotFoundError";
  }
}

/** Thrown when a review action's precondition on the rule's derivation `status` isn't met (e.g. approving something that isn't `confirmed`). Names the rule, its actual status, and what was required. */
export class InvalidReviewActionError extends Error {}

function requireRule(storePath: string, passphrase: string, ruleId: string): Rule {
  const rule = withDatabase(storePath, passphrase, false, (db) => readRuleRow(db, ruleId));
  if (!rule) {
    throw new RuleNotFoundError(ruleId);
  }
  return rule;
}

/** Rewrites `duo/rules/<id>.md` from the rule's current DB state — the one thing every review action does after mutating the row, so the file the owner reads never lags behind the decision. */
function materializeRuleFile(storePath: string, passphrase: string, duoDir: string, rule: Rule): void {
  const dir = join(duoDir, "rules");
  mkdirSync(dir, { recursive: true });
  const evidence = listRuleEvidence(storePath, passphrase, rule.id);
  writeFileSync(join(dir, `${rule.id}.md`), serializeRuleFile(rule, evidence));
}

/**
 * Reads this rule's current evidence and rewrites its row within *one*
 * open handle, then writes the file afterward (a plain filesystem write,
 * no store access, so it never needs to nest another `withDatabase` call
 * either). Deliberately does not call `listRuleEvidence`/`getRecord`-style
 * top-level helpers from inside the callback below — each of those opens
 * its own independent `withDatabase`, which decrypts to the very same
 * temp file path (`${storePath}.rw-tmp`) this call already has open and
 * would delete out from under it; `readRuleEvidenceRows(db, …)` is the
 * db-level primitive that exists precisely so this doesn't happen.
 */
function saveReviewedRule(storePath: string, passphrase: string, duoDir: string, rule: Rule): Rule {
  withDatabase(storePath, passphrase, true, (db) => {
    const evidence = readRuleEvidenceRows(db, rule.id);
    putRule(db, rule, evidence);
  });
  materializeRuleFile(storePath, passphrase, duoDir, rule);
  return rule;
}

/**
 * AC1: approving a `confirmed` rule marks it active. Deliberately refuses
 * on any other derivation status — approving an `inconsistent` rule would
 * mean actively endorsing an averaged-over disagreement, and approving a
 * `weak_signal` isn't "approval" at all, it's promotion (see promoteRule),
 * which is recorded differently (AC3: owner-asserted, not evidence-backed).
 */
export function approveRule(storePath: string, passphrase: string, duoDir: string, ruleId: string): Rule {
  const rule = requireRule(storePath, passphrase, ruleId);
  if (rule.status !== "confirmed") {
    throw new InvalidReviewActionError(
      `Rule "${ruleId}" has derivation status "${rule.status}", not "confirmed" — only a confirmed rule can be approved. ` +
        `A weak signal can be promoted instead (\`duo mirror rules promote\`).`,
    );
  }
  return saveReviewedRule(storePath, passphrase, duoDir, { ...rule, reviewStatus: "approved" });
}

/**
 * AC2: rejecting works on a rule in any derivation status — the owner may
 * disagree with a confirmed rule, an inconsistent one, or a weak signal
 * alike. `reviewStatus: "rejected"` persists across every later
 * re-induction run (rules.ts's runRuleInduction carries it forward
 * unchanged), which is what makes it "not re-proposed unchanged" true: the
 * text/support/consistency may keep being recomputed as evidence changes,
 * but the rejection itself never resets to pending on its own.
 */
export function rejectRule(storePath: string, passphrase: string, duoDir: string, ruleId: string): Rule {
  const rule = requireRule(storePath, passphrase, ruleId);
  return saveReviewedRule(storePath, passphrase, duoDir, { ...rule, reviewStatus: "rejected" });
}

/**
 * AC3: promotes a below-threshold weak signal straight to active,
 * recorded as `origin: "owner_asserted"` rather than `"derived"` — the
 * owner is vouching for it, the corpus hasn't (yet). Refuses on anything
 * else: a `confirmed` rule is approved, not promoted (approveRule already
 * covers it and doesn't need the owner-asserted flag); promoting an
 * `inconsistent` topic would hide a genuine disagreement behind a single
 * asserted answer, which is exactly what AC2 (of #25/#28 combined) means
 * to keep visible instead.
 */
export function promoteRule(storePath: string, passphrase: string, duoDir: string, ruleId: string): Rule {
  const rule = requireRule(storePath, passphrase, ruleId);
  if (rule.status !== "weak_signal") {
    throw new InvalidReviewActionError(
      `Rule "${ruleId}" has derivation status "${rule.status}", not "weak_signal" — only a weak signal can be promoted. ` +
        `A confirmed rule is approved instead (\`duo mirror rules approve\`).`,
    );
  }
  return saveReviewedRule(storePath, passphrase, duoDir, { ...rule, reviewStatus: "approved", origin: "owner_asserted" });
}

/**
 * AC4: "offers to write a rule by hand" when nothing cleared threshold.
 * Mints a brand-new topic (so the existing one-rule-per-topic invariant
 * from rules.ts holds without any special-casing) and a rule under it with
 * no supporting evidence at all — `origin: "owner_asserted"`,
 * `reviewStatus: "approved"` directly, since writing it *is* the owner's
 * approval. `status: "confirmed"` here doesn't claim the corpus backs it
 * (it plainly doesn't — `supportCount` is 0); it's what makes this rule
 * indistinguishable, to any future consumer that filters on derivation
 * status, from an evidence-backed one — exactly the point of "it becomes
 * an active rule" (AC3's own wording, reused here for AC4's hand-written
 * case).
 */
export function writeRuleByHand(storePath: string, passphrase: string, duoDir: string, label: string, text: string): Rule {
  const trimmedLabel = label.trim();
  const trimmedText = text.trim();
  if (trimmedLabel.length === 0) {
    throw new InvalidReviewActionError("A hand-written rule needs a non-empty topic label.");
  }
  if (trimmedText.length === 0) {
    throw new InvalidReviewActionError("A hand-written rule needs non-empty text.");
  }

  const topics = readTopicsFile(duoDir);
  const now = new Date().toISOString();
  const topic: Topic = { id: `topic-${randomUUID()}`, label: trimmedLabel, createdAt: now };
  writeTopicsFile(duoDir, [...topics, topic]);

  const rule: Rule = {
    id: topic.id,
    topicId: topic.id,
    text: trimmedText,
    status: "confirmed",
    supportCount: 0,
    consistency: 1,
    createdAt: now,
    lastConfirmedAt: now,
    reviewStatus: "approved",
    origin: "owner_asserted",
  };
  return saveReviewedRule(storePath, passphrase, duoDir, rule);
}

/** One cited exchange behind a rule — the question and answer text #28 AC1 asks the owner to be able to follow. */
export interface RuleEvidenceExchange {
  readonly qaPairId: string;
  readonly questionText: string | null;
  readonly answerText: string | null;
}

/** A rule together with the exchanges its evidence cites, resolved to real question/answer text — what `duo mirror rules show` renders (AC1: "follows its citations, sees the exchanges"). */
export interface RuleWithEvidence {
  readonly rule: Rule;
  readonly evidence: readonly RuleEvidenceExchange[];
}

/**
 * Resolves a rule's rule_evidence rows to the actual question/answer text
 * they cite, by joining back through qa_pairs to records. A citation whose
 * underlying qa_pair or record has since been removed resolves to `null`
 * rather than throwing — evidence tracing degrades gracefully, the same
 * shape #20/#23-#26's other best-effort reads use, rather than making the
 * whole rule unviewable over one stale citation.
 */
export function describeRuleWithEvidence(storePath: string, passphrase: string, ruleId: string): RuleWithEvidence {
  const rule = requireRule(storePath, passphrase, ruleId);
  const evidenceIds = listRuleEvidence(storePath, passphrase, ruleId);
  const pairsById = new Map(listQaPairs(storePath, passphrase).map((pair) => [pair.id, pair]));

  const evidence: RuleEvidenceExchange[] = evidenceIds.map((qaPairId) => {
    const pair = pairsById.get(qaPairId);
    if (!pair) {
      return { qaPairId, questionText: null, answerText: null };
    }
    const question = getRecord(storePath, passphrase, pair.questionId);
    const answer = getRecord(storePath, passphrase, pair.answerId);
    return { qaPairId, questionText: question?.text ?? null, answerText: answer?.text ?? null };
  });

  return { rule, evidence };
}

/**
 * Groups every rule for the review screen's listing (`duo mirror rules`):
 * rules the owner still hasn't acted on, split by whether they're
 * confirmed (ready to approve) or weak/inconsistent (context, not
 * actionable the same way), plus what's already been approved/rejected.
 * AC4's "no rules were derived at all" case is exactly
 * `awaitingApproval.length === 0` here — the caller names why (nothing
 * cleared threshold) and shows `weakSignals` instead.
 */
export interface RuleReviewListing {
  readonly awaitingApproval: readonly Rule[];
  readonly weakSignals: readonly Rule[];
  readonly inconsistent: readonly Rule[];
  readonly approved: readonly Rule[];
  readonly rejected: readonly Rule[];
}

export function listRulesForReview(storePath: string, passphrase: string): RuleReviewListing {
  const rules = listRules(storePath, passphrase);
  return {
    awaitingApproval: rules.filter((rule) => rule.status === "confirmed" && rule.reviewStatus === "pending"),
    weakSignals: rules.filter((rule) => rule.status === "weak_signal" && rule.reviewStatus !== "rejected"),
    inconsistent: rules.filter((rule) => rule.status === "inconsistent" && rule.reviewStatus !== "rejected"),
    approved: rules.filter((rule) => rule.reviewStatus === "approved"),
    rejected: rules.filter((rule) => rule.reviewStatus === "rejected"),
  };
}

/**
 * What a future drafting/answering pipeline should treat as this duo's
 * active policy: approved, regardless of derivation status or origin —
 * evidence-backed and owner-asserted rules are equally "the owner signed
 * off on this" once approved. No consumer calls this yet (drafting is a
 * separate epic), but the filter exists now so that epic needs no rules.ts
 * changes to start reading it, the same "field present, logic deferred"
 * idiom #50's `rulesUsed` already uses.
 */
export function listActiveRules(storePath: string, passphrase: string): Rule[] {
  return listRules(storePath, passphrase).filter((rule) => rule.reviewStatus === "approved");
}
