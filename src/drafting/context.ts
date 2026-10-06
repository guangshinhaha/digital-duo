import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import type { ClassificationLevel, RecordClassification } from "../ingest/record.js";
import { ensureRecordsSchema } from "../ingest/record-store.js";
import { ensureEmbeddingSchema, hybridSearch } from "../ingest/embeddings.js";
import { isVisibleToClearance } from "../permissions/classification.js";
import { ensureQaPairsSchema } from "../derivation/qa-pairs.js";
import { ensureRulesSchema, readRuleRow, type Rule } from "../derivation/rules.js";
import { findConflictingRefusal } from "../trust/refusals.js";
import type { RecipientVoice } from "./recipient-voice.js";

/** One piece of past evidence the draft can cite — a retrieved record, with a real cosine similarity to the question (not just an ordinal rank). */
export interface DraftEvidenceItem {
  readonly recordId: string;
  readonly text: string;
  readonly timestamp: string;
  readonly similarity: number;
  /**
   * The record's own classification, carried through from retrieval (#155):
   * the text stays verbatim here, but extractiveDraft needs the
   * classification alongside it to strip the record's raw marking line
   * before echoing that text into an answer — the same strip
   * src/permissions/answer.ts's fallback performs on full records.
   */
  readonly classification: RecordClassification;
}

export interface DraftContext {
  readonly evidence: readonly DraftEvidenceItem[];
  /** The confirmed rule directly covering this question, if retrieval turned up evidence backing one — the "explicit rule hit" signal (v1-tech-design.md §1.8). */
  readonly ruleHit: Rule | undefined;
  /**
   * The topic id this question's evidence belongs to, if any — independent
   * of `ruleHit`'s stricter confirmed+approved+non-refused filter, since a
   * topic can hold a trust-grid autonomy grant (#53) without ever having a
   * rule derived for it at all. `undefined` when there's no evidence, or
   * evidence exists but was never assigned a topic (#24 hasn't run, or the
   * pairs are too new). Public answering (#43) is this field's first real
   * consumer — it's what gets checked against the T0 cell for the topic.
   */
  readonly topicId: string | undefined;
  /** Age, in days, of the freshest evidence item — null when there's no evidence at all. What #33's computeRecencyDecay decays, and what a caller states per its AC3. */
  readonly freshestEvidenceAgeDays: number | null;
  /** The freshest evidence item's own timestamp (an ISO string), alongside its age — null exactly when `freshestEvidenceAgeDays` is null. A predecessor-duo consultation (#61 AC1) needs the actual date to state "as of", not only how old it is. */
  readonly freshestEvidenceTimestamp: string | null;
  /** Raw text of duo/voice.md, or a plain "not enough data" placeholder when it doesn't exist yet — conditions generation, never invented. */
  readonly voiceText: string;
  /**
   * How the owner writes to this draft's recipient specifically (duo#262) —
   * present only when the pipeline was told who the draft is for AND enough
   * approved sends to them exist (`drafting/recipient-voice.ts`). Refines
   * `voiceText`, never replaces it. Set by `draftReply`, not here: this
   * function retrieves evidence for a question, and who the reply goes to
   * has no bearing on that.
   */
  readonly recipientVoice?: RecipientVoice;
  readonly usedEmbeddings: boolean;
  readonly warning?: string;
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

function readStoredVectors(db: Database, recordIds: readonly string[], model: string): Map<string, number[]> {
  ensureEmbeddingSchema(db);
  const result = new Map<string, number[]>();
  if (recordIds.length === 0) {
    return result;
  }
  const placeholders = recordIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT record_id, vector FROM record_embeddings WHERE model = ? AND record_id IN (${placeholders})`)
    .all(model, ...recordIds) as unknown as { record_id: string; vector: string }[];
  for (const row of rows) {
    result.set(row.record_id, JSON.parse(row.vector) as number[]);
  }
  return result;
}

/**
 * Whether any of `recordIds` is the answer half of a qa_pair whose topic
 * has a rule that is both `confirmed` (derivation's confidence tier) and
 * `approved` (#28: the owner's own review decision — "what makes a rule
 * active, usable by a future drafting/answering pipeline"; this is that
 * pipeline). A `confirmed`-but-`pending`-or-`rejected` rule is deliberately
 * not a hit: the owner hasn't signed off on it, or explicitly disagreed
 * with it, either way it isn't "a standing order" yet.
 *
 * Also excludes a topic with a conflicting refusal, same as
 * rule-review.ts's listActiveRules — "the refusal wins", re-checked on
 * every call rather than only at approval time (#29 AC3). Without this, a
 * refusal written after approval would suppress a rule everywhere the
 * Mirror shows it but still let a live `duo draft` answer ground itself
 * on that exact rule text.
 *
 * Only the matching id is picked here; the row itself is re-read through
 * readRuleRow so this stays correct as rules.ts's own row shape evolves,
 * rather than duplicating its column list. Deterministic among ties: the
 * matching rule with the highest consistency wins, then lowest id — but a
 * refused candidate is skipped in favor of the next one down that
 * ordering, rather than declaring no hit outright when a different
 * matched topic is still active.
 */
function findRuleHit(db: Database, recordIds: readonly string[], duoDir: string): Rule | undefined {
  ensureQaPairsSchema(db);
  ensureRulesSchema(db);
  if (recordIds.length === 0) {
    return undefined;
  }
  const placeholders = recordIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT DISTINCT rules.id
      FROM qa_pairs
      JOIN rules ON rules.topic_id = qa_pairs.topic_id AND rules.status = 'confirmed' AND rules.review_status = 'approved'
      WHERE qa_pairs.answer_id IN (${placeholders})
      ORDER BY rules.consistency DESC, rules.id ASC
    `,
    )
    .all(...recordIds) as unknown as { id: string }[];
  for (const row of rows) {
    const rule = readRuleRow(db, row.id);
    if (rule && findConflictingRefusal(duoDir, rule.topicId) === undefined) {
      return rule;
    }
  }
  return undefined;
}

/**
 * The topic id evidence for this question belongs to (see `DraftContext.topicId`
 * above). Prefers `ruleHit`'s own topic when one exists — already computed,
 * and a rule hit is strong evidence of *which* topic — otherwise falls back
 * to the most-cited topic among the retrieved evidence's own qa_pairs (a
 * topic can exist, and hold a trust grant, with no rule ever derived for
 * it). Ties broken by lowest topic id, for a deterministic result.
 */
function resolveEvidenceTopicId(db: Database, recordIds: readonly string[], ruleHit: Rule | undefined): string | undefined {
  if (ruleHit) {
    return ruleHit.topicId;
  }
  if (recordIds.length === 0) {
    return undefined;
  }
  ensureQaPairsSchema(db);
  const placeholders = recordIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT topic_id FROM qa_pairs WHERE answer_id IN (${placeholders}) AND topic_id IS NOT NULL`)
    .all(...recordIds) as unknown as { topic_id: string }[];
  if (rows.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.topic_id, (counts.get(row.topic_id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function ageInDays(timestamp: string, now: Date): number | null {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  return Math.max(0, (now.getTime() - then) / (1000 * 60 * 60 * 24));
}

/** Exported for #263's rewrite endpoint (rewrite.ts), which conditions on the same voice profile drafting does, rather than re-reading duo/voice.md a second way. */
export function readVoiceText(duoDir: string): string {
  const path = join(duoDir, "voice.md");
  if (!existsSync(path)) {
    return "Not enough of the owner's own writing has been ingested yet to describe their voice.";
  }
  return readFileSync(path, "utf8");
}

/**
 * Rebuilds a draft's grounding from the sources it already cites
 * (guangshinhaha/duo#258) — the re-entry point for regenerating a draft
 * without re-running retrieval. Every evidence source is re-read by its
 * record id and the standing order by its rule id: the same pool, by
 * construction, so a reshaped draft can never lean on evidence its
 * original could not cite (and a draft held under a clearance ceiling,
 * whose sources were filtered before they were ever stored, stays under
 * it). A source whose record has since been deleted, or whose standing
 * order is no longer active, simply drops out — it is not there to cite
 * any more. Attachment sources carry no text (the bytes grounded one draft
 * and were dropped, #190), so a shape of an attachment-grounded draft
 * leans on the draft's own text for them.
 *
 * The rebuilt context is for generation only, never for scoring, so no
 * similarity is recomputed: each item reads as 1.
 */
export function rebuildDraftContext(
  storePath: string,
  passphrase: string,
  duoDir: string,
  sources: readonly { readonly kind: string; readonly id: string }[],
): DraftContext {
  const evidenceIds = sources.filter((source) => source.kind === "evidence").map((source) => source.id);
  const ruleId = sources.find((source) => source.kind === "rule")?.id;
  const { evidence, ruleHit } = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const items: DraftEvidenceItem[] = [];
    for (const id of evidenceIds) {
      const row = db.prepare(`SELECT id, text, timestamp, classification FROM records WHERE id = ?`).get(id) as
        | { id: string; text: string; timestamp: string; classification: RecordClassification }
        | undefined;
      if (row) {
        items.push({
          recordId: row.id,
          text: row.text,
          timestamp: row.timestamp,
          similarity: 1,
          classification: row.classification,
        });
      }
    }
    let rule: Rule | undefined;
    if (ruleId !== undefined) {
      ensureRulesSchema(db);
      const candidate = readRuleRow(db, ruleId);
      // Re-checked exactly as findRuleHit checks it on every draft: a rule
      // the owner has since rejected, or a refusal written after the draft,
      // wins over the draft's own citation — "the refusal wins" (#29 AC3).
      if (
        candidate &&
        candidate.status === "confirmed" &&
        candidate.reviewStatus === "approved" &&
        findConflictingRefusal(duoDir, candidate.topicId) === undefined
      ) {
        rule = candidate;
      }
    }
    return { evidence: items, ruleHit: rule };
  });
  return {
    evidence,
    ruleHit,
    topicId: ruleHit?.topicId,
    freshestEvidenceAgeDays: null,
    freshestEvidenceTimestamp: null,
    voiceText: readVoiceText(duoDir),
    usedEmbeddings: false,
  };
}

/**
 * Gathers everything the draft pipeline needs to generate and score a
 * draft. For the *owner's own* personal duo (the default: `clearanceCeiling`
 * omitted) there is no asker or clearance to resolve — unlike
 * src/permissions/retrieval.ts's retrieveForAsker, the owner sees everything
 * in their own store. `clearanceCeiling`, when given, filters retrieved
 * candidates through #48's `isVisibleToClearance` *before* anything below
 * this point (rule-hit lookup, topic resolution, evidence, confidence) ever
 * sees them — the same "filtered before generation, not after" shape
 * `retrieveForAsker` uses. Public answering (#43) is the one caller that
 * passes it: colleagues are not the owner, so material above the public
 * ceiling must never reach a publicly-postable draft, even though (per #43's
 * own scope) *which* colleague is asking makes no difference to the filter
 * applied — one uniform ceiling, not a per-asker one.
 *
 * Real per-item cosine similarity is computed directly against the stored
 * vectors (rather than reusing hybridSearch's ordinal rank), which is what
 * lets #33's confidence scoring measure retrieval strength honestly.
 */
export async function gatherDraftContext(
  storePath: string,
  passphrase: string,
  duoDir: string,
  question: string,
  embeddingProvider: EmbeddingProvider,
  limit = 5,
  clearanceCeiling?: ClassificationLevel,
): Promise<DraftContext> {
  const hybrid = await hybridSearch(storePath, passphrase, question, embeddingProvider, limit);
  const admissible =
    clearanceCeiling === undefined
      ? hybrid.results
      : hybrid.results.filter((result) => isVisibleToClearance(result.record.classification, clearanceCeiling));

  let queryVector: readonly number[] | undefined;
  if (hybrid.usedEmbeddings) {
    try {
      queryVector = await embeddingProvider.embed(question);
    } catch {
      queryVector = undefined;
    }
  }

  const recordIds = admissible.map((result) => result.record.id);
  const now = new Date();

  const { vectors, ruleHit, topicId } = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const hit = findRuleHit(db, recordIds, duoDir);
    return {
      vectors: queryVector ? readStoredVectors(db, recordIds, embeddingProvider.model) : new Map<string, number[]>(),
      ruleHit: hit,
      topicId: resolveEvidenceTopicId(db, recordIds, hit),
    };
  });

  const evidence: DraftEvidenceItem[] = admissible.map((result, index) => {
    const stored = vectors.get(result.record.id);
    const similarity = queryVector && stored ? cosineSimilarity(queryVector, stored) : 1 / (1 + index);
    return { recordId: result.record.id, text: result.record.text, timestamp: result.record.timestamp, similarity, classification: result.record.classification };
  });

  const dated = evidence
    .map((item) => ({ timestamp: item.timestamp, age: ageInDays(item.timestamp, now) }))
    .filter((item): item is { timestamp: string; age: number } => item.age !== null)
    .sort((a, b) => a.age - b.age);
  const freshest = dated[0];

  return {
    evidence,
    ruleHit,
    topicId,
    freshestEvidenceAgeDays: freshest?.age ?? null,
    freshestEvidenceTimestamp: freshest?.timestamp ?? null,
    voiceText: readVoiceText(duoDir),
    usedEmbeddings: hybrid.usedEmbeddings,
    warning: hybrid.warning,
  };
}
