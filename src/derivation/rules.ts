import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureRecordsSchema } from "../ingest/record-store.js";
import { embedRecords, ensureEmbeddingSchema } from "../ingest/embeddings.js";
import { ensureQaPairsSchema } from "./qa-pairs.js";

/**
 * v1-tech-design.md §1.5 step 3: one topic's pairs at a time, bounded
 * context, grounded output. `status` is the support filter's verdict
 * (step 4): `confirmed` rules are what the Mirror surfaces as policy,
 * `weak_signal` ones are thin-but-real candidates the owner can promote by
 * hand (AR-3 — too strict a bar leaves the Mirror empty), and
 * `inconsistent` ones are recorded, with their conflicting evidence, so
 * disagreement is visible rather than averaged away.
 *
 * One rule per topic in v1 — `id` is deliberately just `topicId` itself.
 * Multiple independent rules per topic isn't excluded by anything here,
 * but nothing in this issue's acceptance criteria asks for it either, and
 * keeping it 1:1 makes rule identity trivially stable across re-induction
 * (re-running always updates the same row rather than minting new ids).
 */
export const RULE_STATUSES = ["confirmed", "inconsistent", "weak_signal"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

/**
 * The owner's own review decision (#28) — orthogonal to `status` above.
 * `status` is derivation's confidence tier; `reviewStatus` is whether the
 * *owner* has looked at the evidence and signed off. A freshly (re-)induced
 * rule always starts/stays `pending` until the owner acts on it; `approved`
 * is what makes a rule "active" (usable by a future drafting/answering
 * pipeline); `rejected` means the owner disagreed and it must never
 * silently become active again, including across a later re-induction run
 * that recomputes its derivation `status` from new evidence (AC2).
 */
export const RULE_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type RuleReviewStatus = (typeof RULE_REVIEW_STATUSES)[number];

/**
 * `derived` is the normal case: induction proposed this rule, with
 * evidence. `owner_asserted` is #28 AC3 — a weak signal promoted by hand,
 * or a rule written from scratch with no supporting evidence at all —
 * recorded as the owner's own claim, not something the corpus backed.
 */
export const RULE_ORIGINS = ["derived", "owner_asserted"] as const;
export type RuleOrigin = (typeof RULE_ORIGINS)[number];

export interface Rule {
  readonly id: string;
  readonly topicId: string;
  readonly text: string;
  readonly status: RuleStatus;
  readonly supportCount: number;
  /** Average pairwise cosine similarity among this topic's answer embeddings; 1 when there's only one supporting pair. */
  readonly consistency: number;
  readonly createdAt: string;
  /** Set (to "now") every time this rule is recomputed as `confirmed`; null if it never has been. */
  readonly lastConfirmedAt: string | null;
  /** The owner's review decision (#28). Defaults to "pending" for a rule that has never been reviewed. */
  readonly reviewStatus: RuleReviewStatus;
  /** Whether induction proposed this rule or the owner asserted it by hand (#28 AC3). */
  readonly origin: RuleOrigin;
}

/** Below this many supporting pairs, a topic can never become `confirmed` regardless of consistency — it's a `weak_signal` instead (AC3). */
const DEFAULT_SUPPORT_THRESHOLD = 3;
/** Minimum average pairwise answer similarity to call a topic's answers "the same policy" rather than "conflicting" (AC1 vs AC2). */
const DEFAULT_CONSISTENCY_THRESHOLD = 0.7;

export function ensureRulesSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      support_count INTEGER NOT NULL,
      consistency REAL NOT NULL,
      created_at TEXT NOT NULL,
      last_confirmed_at TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending',
      origin TEXT NOT NULL DEFAULT 'derived'
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_evidence (
      rule_id TEXT NOT NULL,
      qa_pair_id TEXT NOT NULL,
      PRIMARY KEY (rule_id, qa_pair_id)
    ) STRICT
  `);
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** A single answer trivially agrees with itself; consistency across ≥2 answers is the mean of every pairwise similarity. */
function averagePairwiseSimilarity(vectors: readonly (readonly number[])[]): number {
  if (vectors.length <= 1) {
    return 1;
  }
  let total = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarity(vectors[i], vectors[j]);
      count += 1;
    }
  }
  return count === 0 ? 1 : total / count;
}

/** The answer whose embedding sits closest to the group's centroid — a deterministic stand-in for "the" representative answer, used as both the default rule text and the LLM generator's grounding example. */
function mostCentralText(answers: readonly { text: string; vector: readonly number[] }[]): string {
  const dimensions = answers[0]?.vector.length ?? 0;
  const centroid = new Array(dimensions).fill(0);
  for (const answer of answers) {
    for (let i = 0; i < dimensions; i++) {
      centroid[i] += answer.vector[i] / answers.length;
    }
  }
  let best = answers[0];
  let bestSimilarity = -Infinity;
  for (const answer of answers) {
    const similarity = cosineSimilarity(answer.vector, centroid);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = answer;
    }
  }
  return best.text;
}

export type RuleTextGenerator = (answerTexts: readonly string[], centralAnswer: string) => Promise<string>;

/** No-provider default: the most central answer, verbatim — the owner's own words, not a paraphrase invented from nothing. */
export async function defaultRuleText(_answerTexts: readonly string[], centralAnswer: string): Promise<string> {
  return centralAnswer;
}

/** LLM-backed rule phrasing (v1-tech-design.md §1.5 step 3: "ask for the consistent policy"). Used only for the `confirmed` case — never throws; falls back to defaultRuleText's central-answer default on any failure or empty response. */
export function createLlmRuleTextGenerator(provider: InferenceProvider): RuleTextGenerator {
  return async (answerTexts, centralAnswer) => {
    try {
      const response = await provider.complete(
        [
          "These are several of the owner's own answers to closely related questions, judged consistent with each other:",
          ...answerTexts.map((text) => `- ${text}`),
          "State the consistent policy in one or two plain-English sentences, in the owner's voice. No preamble, no citations, just the policy.",
        ].join("\n"),
      );
      const cleaned = response.trim();
      return cleaned.length > 0 ? cleaned : centralAnswer;
    } catch {
      return centralAnswer;
    }
  };
}

/** Deterministic, no LLM involved — AC2 asks that disagreement be visible, not smoothed over by a model's summary of it. */
function inconsistentRuleText(answerTexts: readonly string[]): string {
  const samples = answerTexts.slice(0, 3).map((text) => `"${text}"`);
  return `No consistent answer across ${answerTexts.length} pair(s) in this topic; examples: ${samples.join(" vs ")}.`;
}

export interface RuleInductionOptions {
  supportThreshold?: number;
  consistencyThreshold?: number;
  generateRuleText?: RuleTextGenerator;
}

export interface RuleInductionSummary {
  readonly rules: readonly Rule[];
  readonly confirmedCount: number;
  readonly inconsistentCount: number;
  readonly weakSignalCount: number;
}

interface TopicPair {
  pairId: string;
  answerText: string;
  vector: readonly number[];
}

/**
 * Recomputes one rule per topic from scratch, over every qa_pair currently
 * assigned to it — not just newly-added ones. A topic's overall consistency
 * and support genuinely change as more evidence arrives (a thin topic can
 * grow into a confirmed one; a confirmed one can turn out inconsistent once
 * a contradicting pair lands), so re-running this is meant to *update* each
 * topic's rule, not just extend it — unlike #24's topic ids, nothing here
 * requires this to be append-only. `rule_evidence` is fully replaced each
 * time for the same reason: it should always exactly reflect the current
 * supporting set, not accumulate stale citations.
 *
 * Backfills missing embeddings via #20's embedRecords first, same as #24's
 * runTopicAssignment — a topic whose answers aren't embeddable yet (e.g.
 * Ollama down) is simply skipped this run rather than failing the whole
 * pass, and picked up once embeddings succeed.
 */
export async function runRuleInduction(
  storePath: string,
  passphrase: string,
  embeddingProvider: EmbeddingProvider,
  options: RuleInductionOptions = {},
): Promise<RuleInductionSummary> {
  const supportThreshold = options.supportThreshold ?? DEFAULT_SUPPORT_THRESHOLD;
  const consistencyThreshold = options.consistencyThreshold ?? DEFAULT_CONSISTENCY_THRESHOLD;
  const generateRuleText = options.generateRuleText ?? defaultRuleText;

  await embedRecords(storePath, passphrase, embeddingProvider);

  const byTopic = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    ensureQaPairsSchema(db);
    ensureRulesSchema(db);
    ensureEmbeddingSchema(db);

    const rows = db
      .prepare(
        `
        SELECT qa_pairs.id AS pair_id, qa_pairs.topic_id AS topic_id, records.text AS answer_text, record_embeddings.vector AS vector
        FROM qa_pairs
        JOIN records ON records.id = qa_pairs.answer_id
        JOIN record_embeddings ON record_embeddings.record_id = qa_pairs.answer_id AND record_embeddings.model = ?
        WHERE qa_pairs.topic_id IS NOT NULL
        ORDER BY qa_pairs.topic_id, qa_pairs.id
      `,
      )
      .all(embeddingProvider.model) as unknown as { pair_id: string; topic_id: string; answer_text: string; vector: string }[];

    const grouped = new Map<string, TopicPair[]>();
    for (const row of rows) {
      const pair: TopicPair = { pairId: row.pair_id, answerText: row.answer_text, vector: JSON.parse(row.vector) as number[] };
      const bucket = grouped.get(row.topic_id);
      if (bucket) {
        bucket.push(pair);
      } else {
        grouped.set(row.topic_id, [pair]);
      }
    }
    return grouped;
  });

  const now = new Date().toISOString();
  const computed: { rule: Omit<Rule, "createdAt" | "lastConfirmedAt" | "reviewStatus" | "origin">; evidencePairIds: string[] }[] = [];

  for (const [topicId, pairs] of byTopic) {
    const consistency = averagePairwiseSimilarity(pairs.map((pair) => pair.vector));
    const supportCount = pairs.length;
    const central = mostCentralText(pairs.map((pair) => ({ text: pair.answerText, vector: pair.vector })));
    const answerTexts = pairs.map((pair) => pair.answerText);

    let status: RuleStatus;
    let text: string;
    if (supportCount < supportThreshold) {
      status = "weak_signal";
      text = await defaultRuleText(answerTexts, central);
    } else if (consistency >= consistencyThreshold) {
      status = "confirmed";
      text = await generateRuleText(answerTexts, central);
    } else {
      status = "inconsistent";
      text = inconsistentRuleText(answerTexts);
    }

    computed.push({
      rule: { id: topicId, topicId, text, status, supportCount, consistency },
      evidencePairIds: pairs.map((pair) => pair.pairId),
    });
  }

  const rules = withDatabase(storePath, passphrase, true, (db) => {
    ensureRulesSchema(db);
    const finalRules: Rule[] = [];
    for (const { rule, evidencePairIds } of computed) {
      const existing = readRuleRow(db, rule.id);
      const createdAt = existing?.createdAt ?? now;
      const lastConfirmedAt = rule.status === "confirmed" ? now : existing?.lastConfirmedAt ?? null;
      // #28 AC2: the owner's review decision (and whether it was owner-
      // asserted) survives a re-induction run untouched — only the
      // derivation-computed fields above (status/text/support/consistency)
      // are ever recomputed from fresh evidence.
      const reviewStatus = existing?.reviewStatus ?? "pending";
      const origin = existing?.origin ?? "derived";
      const finalRule: Rule = { ...rule, createdAt, lastConfirmedAt, reviewStatus, origin };
      putRule(db, finalRule, evidencePairIds);
      finalRules.push(finalRule);
    }
    return finalRules;
  });

  return {
    rules,
    confirmedCount: rules.filter((rule) => rule.status === "confirmed").length,
    inconsistentCount: rules.filter((rule) => rule.status === "inconsistent").length,
    weakSignalCount: rules.filter((rule) => rule.status === "weak_signal").length,
  };
}

interface RuleRow {
  id: string;
  topic_id: string;
  text: string;
  status: string;
  support_count: number;
  consistency: number;
  created_at: string;
  last_confirmed_at: string | null;
  review_status: string;
  origin: string;
}

function rowToRule(row: RuleRow): Rule {
  return {
    id: row.id,
    topicId: row.topic_id,
    text: row.text,
    status: row.status as RuleStatus,
    supportCount: row.support_count,
    consistency: row.consistency,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    reviewStatus: row.review_status as RuleReviewStatus,
    origin: row.origin as RuleOrigin,
  };
}

/** Reads one rule row on an already-open handle — the shared primitive both `runRuleInduction` and #26's file sync build on, rather than each re-deriving the upsert/read dance. */
export function readRuleRow(db: Database, id: string): Rule | undefined {
  ensureRulesSchema(db);
  const row = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as RuleRow | undefined;
  return row ? rowToRule(row) : undefined;
}

/** Upserts a rule row and fully replaces its evidence in one call, on an already-open handle. */
export function putRule(db: Database, rule: Rule, evidencePairIds: readonly string[]): void {
  ensureRulesSchema(db);
  db.prepare(
    `
    INSERT INTO rules (id, topic_id, text, status, support_count, consistency, created_at, last_confirmed_at, review_status, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      topic_id = excluded.topic_id, text = excluded.text, status = excluded.status, support_count = excluded.support_count,
      consistency = excluded.consistency, created_at = excluded.created_at, last_confirmed_at = excluded.last_confirmed_at,
      review_status = excluded.review_status, origin = excluded.origin
  `,
  ).run(
    rule.id,
    rule.topicId,
    rule.text,
    rule.status,
    rule.supportCount,
    rule.consistency,
    rule.createdAt,
    rule.lastConfirmedAt,
    rule.reviewStatus,
    rule.origin,
  );

  db.prepare(`DELETE FROM rule_evidence WHERE rule_id = ?`).run(rule.id);
  const insertEvidence = db.prepare(`INSERT INTO rule_evidence (rule_id, qa_pair_id) VALUES (?, ?)`);
  for (const pairId of evidencePairIds) {
    insertEvidence.run(rule.id, pairId);
  }
}

/** Deletes a rule and every rule_evidence row citing it, on an already-open handle — what #26's sync calls when a rule's file has been deleted (AC3). */
export function deleteRule(db: Database, id: string): void {
  ensureRulesSchema(db);
  db.prepare(`DELETE FROM rule_evidence WHERE rule_id = ?`).run(id);
  db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
}

export function listRules(storePath: string, passphrase: string): Rule[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    ensureRulesSchema(db);
    const rows = db.prepare(`SELECT * FROM rules`).all() as unknown as RuleRow[];
    return rows.map(rowToRule);
  });
}

/** Reads one rule's evidence on an already-open handle — the db-level primitive `listRuleEvidence` wraps, and what a caller that already holds an open `db` (e.g. #28's rule-review, mutating within its own `withDatabase`) must use instead of nesting a second top-level call over the same store file. */
export function readRuleEvidenceRows(db: Database, ruleId: string): string[] {
  ensureRulesSchema(db);
  const rows = db.prepare(`SELECT qa_pair_id FROM rule_evidence WHERE rule_id = ?`).all(ruleId) as unknown as {
    qa_pair_id: string;
  }[];
  return rows.map((row) => row.qa_pair_id);
}

/** The qa_pair ids a rule cites — "every rule carries at least one rule_evidence row" (AC4) is what a caller checks this against. */
export function listRuleEvidence(storePath: string, passphrase: string, ruleId: string): string[] {
  return withDatabase(storePath, passphrase, false, (db) => {
    return readRuleEvidenceRows(db, ruleId);
  });
}
