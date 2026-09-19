import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureRecordsSchema } from "../ingest/record-store.js";
import { ensureEmbeddingSchema, hybridSearch } from "../ingest/embeddings.js";
import { ensureQaPairsSchema } from "../derivation/qa-pairs.js";
import { ensureRulesSchema, type Rule } from "../derivation/rules.js";

/** One piece of past evidence the draft can cite — a retrieved record, with a real cosine similarity to the question (not just an ordinal rank). */
export interface DraftEvidenceItem {
  readonly recordId: string;
  readonly text: string;
  readonly timestamp: string;
  readonly similarity: number;
}

export interface DraftContext {
  readonly evidence: readonly DraftEvidenceItem[];
  /** The confirmed rule directly covering this question, if retrieval turned up evidence backing one — the "explicit rule hit" signal (v1-tech-design.md §1.8). */
  readonly ruleHit: Rule | undefined;
  /** Age, in days, of the freshest evidence item — null when there's no evidence at all. What #33's computeRecencyDecay decays, and what a caller states per its AC3. */
  readonly freshestEvidenceAgeDays: number | null;
  /** Raw text of duo/voice.md, or a plain "not enough data" placeholder when it doesn't exist yet — conditions generation, never invented. */
  readonly voiceText: string;
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
 * has a `confirmed` rule — "a standing order directly covers this"
 * (v1-tech-design.md §1.8), grounded in retrieval that already turned up
 * supporting evidence, rather than a separate rule-text embedding lookup.
 * Deterministic among ties: the confirmed rule with the highest
 * consistency wins, then lowest id.
 */
function findRuleHit(db: Database, recordIds: readonly string[]): Rule | undefined {
  ensureQaPairsSchema(db);
  ensureRulesSchema(db);
  if (recordIds.length === 0) {
    return undefined;
  }
  const placeholders = recordIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT DISTINCT rules.*
      FROM qa_pairs
      JOIN rules ON rules.topic_id = qa_pairs.topic_id AND rules.status = 'confirmed'
      WHERE qa_pairs.answer_id IN (${placeholders})
      ORDER BY rules.consistency DESC, rules.id ASC
    `,
    )
    .all(...recordIds) as unknown as {
    id: string;
    topic_id: string;
    text: string;
    status: string;
    support_count: number;
    consistency: number;
    created_at: string;
    last_confirmed_at: string | null;
  }[];
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    topicId: row.topic_id,
    text: row.text,
    status: row.status as Rule["status"],
    supportCount: row.support_count,
    consistency: row.consistency,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
}

function ageInDays(timestamp: string, now: Date): number | null {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  return Math.max(0, (now.getTime() - then) / (1000 * 60 * 60 * 24));
}

function readVoiceText(duoDir: string): string {
  const path = join(duoDir, "voice.md");
  if (!existsSync(path)) {
    return "Not enough of the owner's own writing has been ingested yet to describe their voice.";
  }
  return readFileSync(path, "utf8");
}

/**
 * Gathers everything the draft pipeline needs to generate and score a
 * draft, for the *owner's own* personal duo — unlike
 * src/permissions/retrieval.ts's retrieveForAsker, there is no asker or
 * clearance to resolve here: the owner sees everything in their own store.
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
): Promise<DraftContext> {
  const hybrid = await hybridSearch(storePath, passphrase, question, embeddingProvider, limit);

  let queryVector: readonly number[] | undefined;
  if (hybrid.usedEmbeddings) {
    try {
      queryVector = await embeddingProvider.embed(question);
    } catch {
      queryVector = undefined;
    }
  }

  const recordIds = hybrid.results.map((result) => result.record.id);
  const now = new Date();

  const { vectors, ruleHit } = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    return {
      vectors: queryVector ? readStoredVectors(db, recordIds, embeddingProvider.model) : new Map<string, number[]>(),
      ruleHit: findRuleHit(db, recordIds),
    };
  });

  const evidence: DraftEvidenceItem[] = hybrid.results.map((result, index) => {
    const stored = vectors.get(result.record.id);
    const similarity = queryVector && stored ? cosineSimilarity(queryVector, stored) : 1 / (1 + index);
    return { recordId: result.record.id, text: result.record.text, timestamp: result.record.timestamp, similarity };
  });

  const ages = evidence.map((item) => ageInDays(item.timestamp, now)).filter((age): age is number => age !== null);
  const freshestEvidenceAgeDays = ages.length > 0 ? Math.min(...ages) : null;

  return {
    evidence,
    ruleHit,
    freshestEvidenceAgeDays,
    voiceText: readVoiceText(duoDir),
    usedEmbeddings: hybrid.usedEmbeddings,
    warning: hybrid.warning,
  };
}
