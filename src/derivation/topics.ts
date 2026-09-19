import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { ensureRecordsSchema } from "../ingest/record-store.js";
import { embedRecords, ensureEmbeddingSchema } from "../ingest/embeddings.js";
import { ensureQaPairsSchema } from "./qa-pairs.js";

/**
 * AR-8: clustering is not stable run to run, and the future trust grid is
 * keyed on (topic × tier) — an unstable topic id would silently invalidate
 * every permission grant. So a topic, once minted, keeps its id forever;
 * `label` is the only field a hand-edit to `duo/topics.json` should ever
 * change (see readTopicsFile/writeTopicsFile below — "files win").
 */
export interface Topic {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
}

function topicsFilePath(duoDir: string): string {
  return join(duoDir, "topics.json");
}

/** Reads `duo/topics.json`. Returns [] if the file (or the directory) doesn't exist yet — a brand-new corpus has no topics, not an error. */
export function readTopicsFile(duoDir: string): Topic[] {
  const path = topicsFilePath(duoDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed ${path}: expected a JSON array of topics`);
  }
  return parsed as Topic[];
}

/** Writes `duo/topics.json`, sorted by createdAt then id for a stable, diffable file — the whole point of AC4 ("safe to hand-edit"). */
export function writeTopicsFile(duoDir: string, topics: readonly Topic[]): void {
  const path = topicsFilePath(duoDir);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...topics].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/** Mirrors `duo/topics.json` into the `topics` table. `duo/topics.json` is the source of truth for `label` (AR-8); this table is a projection retrieval reads, always rebuilt from the file rather than the other way round. */
function ensureTopicsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT
  `);
}

function syncTopicsTable(db: Database, topics: readonly Topic[]): void {
  ensureTopicsSchema(db);
  db.exec(`DELETE FROM topics`);
  const insert = db.prepare(`INSERT INTO topics (id, label, created_at) VALUES (?, ?, ?)`);
  for (const topic of topics) {
    insert.run(topic.id, topic.label, topic.createdAt);
  }
}

/** One embedding vector per topic, used only for matching a new cluster to an existing topic — never exposed in `duo/topics.json`, which stays plain and human-readable (AC4). */
function ensureTopicCentroidSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_centroids (
      topic_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector TEXT NOT NULL,
      pair_count INTEGER NOT NULL
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

/** Running mean, weighted by how many pairs already contributed to each side — so a topic's centroid keeps tracking its true center as more pairs join it over time, rather than getting stuck at its first cluster's shape. */
function weightedAverage(a: readonly number[], countA: number, b: readonly number[], countB: number): number[] {
  const total = countA + countB;
  return a.map((value, index) => (value * countA + b[index] * countB) / total);
}

export type TopicLabeler = (sampleQuestions: readonly string[]) => Promise<string>;

/** No-provider default: the first sample question, truncated — an honest placeholder ("this is literally an example from the cluster") the owner can rename via `duo/topics.json` (AC4's whole point). */
export function defaultTopicLabel(sampleQuestions: readonly string[]): string {
  const first = (sampleQuestions[0] ?? "untitled topic").trim();
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || "untitled topic";
}

/** LLM-backed labeler (v1-tech-design.md §1.5 step 2: "label each cluster with an LLM"). Never throws: any provider failure or empty response falls back to defaultTopicLabel, the same default used when no provider is configured at all. */
export function createLlmTopicLabeler(provider: InferenceProvider): TopicLabeler {
  return async (sampleQuestions) => {
    try {
      const response = await provider.complete(
        [
          "These are example questions from one recurring topic in a work conversation history:",
          ...sampleQuestions.map((question) => `- ${question}`),
          "Reply with only a short (2-6 word) plain-English label for this topic. No punctuation, no quotes.",
        ].join("\n"),
      );
      const cleaned = response.trim().replace(/^["'`]+|["'`]+$/g, "");
      return cleaned.length > 0 ? cleaned : defaultTopicLabel(sampleQuestions);
    } catch {
      return defaultTopicLabel(sampleQuestions);
    }
  };
}

export interface TopicAssignmentOptions {
  /** Minimum cosine similarity for two of *this run's* new questions to join the same cluster. Defaults to 0.75. */
  clusterThreshold?: number;
  /** Minimum cosine similarity between a new cluster's centroid and an existing topic's centroid to count as the same topic. Defaults to 0.75. */
  matchThreshold?: number;
  labelTopic?: TopicLabeler;
}

export interface TopicAssignmentResult {
  /** qa_pairs newly given a topic_id this run (matched or newly minted alike). */
  readonly assignedPairs: number;
  /** Existing topic ids that gained at least one new pair this run. */
  readonly matchedTopicIds: readonly string[];
  /** Brand-new topics minted this run — surfaced for the owner to review (AC2), never force-fitted into an existing topic. */
  readonly newTopics: readonly Topic[];
}

interface UnassignedPair {
  pairId: string;
  questionText: string;
  vector: readonly number[];
}

interface Cluster {
  centroid: number[];
  memberPairIds: string[];
  questionTexts: string[];
}

/**
 * Greedy single-pass clustering: each item joins the most similar cluster
 * seen so far if it clears `threshold`, else starts a new one. Deliberately
 * simple — no k-means, no external clustering library — matching #20's
 * "brute-force cosine is enough at this corpus's scale" precedent; a
 * personal corpus's topic count is small enough that this is bounded and
 * fast, and it's fully deterministic given a stable input order.
 */
function clusterBySimilarity(items: readonly UnassignedPair[], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    let best: Cluster | undefined;
    let bestSimilarity = -Infinity;
    for (const cluster of clusters) {
      const similarity = cosineSimilarity(item.vector, cluster.centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = cluster;
      }
    }
    if (best && bestSimilarity >= threshold) {
      best.centroid = weightedAverage(best.centroid, best.memberPairIds.length, item.vector, 1);
      best.memberPairIds.push(item.pairId);
      best.questionTexts.push(item.questionText);
    } else {
      clusters.push({ centroid: [...item.vector], memberPairIds: [item.pairId], questionTexts: [item.questionText] });
    }
  }
  return clusters;
}

/**
 * Topic assignment (v1-tech-design.md §1.5 step 2): embeds every
 * not-yet-topic'd qa_pair's question, clusters the new batch, and matches
 * each cluster against existing topics by centroid similarity before
 * minting anything new. Only pairs with `topic_id IS NULL` are considered —
 * once assigned, a pair's topic_id never moves on a later run, which is
 * what makes AC1 ("existing topics keep their ids") trivially true rather
 * than something this has to work to preserve.
 *
 * `duo/topics.json` is read first and is authoritative for every existing
 * topic's `label` (AR-8); the DB `topics` table is unconditionally rebuilt
 * from it at the end of every run, so a hand-rename made between runs is
 * exactly what the next run's DB reflects (AC3) — matching is keyed by id
 * and centroid, neither of which the file carries, so a label rename can
 * never perturb which pairs belong to which topic.
 *
 * Deliberately does not write back to `IngestRecord.topics`: record-store.ts
 * documents records as insert-only ("only ever inserted, never updated or
 * deleted"), and this respects that invariant rather than reopening it.
 * Topic linkage lives entirely on `qa_pairs.topic_id`.
 */
export async function runTopicAssignment(
  storePath: string,
  passphrase: string,
  duoDir: string,
  embeddingProvider: EmbeddingProvider,
  options: TopicAssignmentOptions = {},
): Promise<TopicAssignmentResult> {
  const clusterThreshold = options.clusterThreshold ?? 0.75;
  const matchThreshold = options.matchThreshold ?? 0.75;
  const labelTopic = options.labelTopic ?? defaultTopicLabel;

  // Backfill any missing question/answer embeddings first, so this never
  // silently skips a pair just because `duo embed` wasn't run beforehand.
  await embedRecords(storePath, passphrase, embeddingProvider);

  const existingTopics = readTopicsFile(duoDir);

  const { unassigned, existingCentroids } = withDatabase(storePath, passphrase, false, (db) => {
    ensureRecordsSchema(db);
    ensureQaPairsSchema(db);
    ensureTopicCentroidSchema(db);
    ensureEmbeddingSchema(db);

    const pairRows = db
      .prepare(
        `
        SELECT qa_pairs.id AS pair_id, records.text AS question_text, record_embeddings.vector AS vector
        FROM qa_pairs
        JOIN records ON records.id = qa_pairs.question_id
        JOIN record_embeddings ON record_embeddings.record_id = qa_pairs.question_id AND record_embeddings.model = ?
        WHERE qa_pairs.topic_id IS NULL
        ORDER BY qa_pairs.id
      `,
      )
      .all(embeddingProvider.model) as unknown as { pair_id: string; question_text: string; vector: string }[];

    const centroidRows = db.prepare(`SELECT topic_id, vector, pair_count FROM topic_centroids WHERE model = ?`).all(
      embeddingProvider.model,
    ) as unknown as { topic_id: string; vector: string; pair_count: number }[];

    return {
      unassigned: pairRows.map((row) => ({
        pairId: row.pair_id,
        questionText: row.question_text,
        vector: JSON.parse(row.vector) as number[],
      })),
      existingCentroids: new Map(
        centroidRows.map((row) => [row.topic_id, { vector: JSON.parse(row.vector) as number[], pairCount: row.pair_count }]),
      ),
    };
  });

  if (unassigned.length === 0) {
    // Still resync the DB projection in case topics.json was hand-edited since the last run.
    withDatabase(storePath, passphrase, true, (db) => syncTopicsTable(db, existingTopics));
    return { assignedPairs: 0, matchedTopicIds: [], newTopics: [] };
  }

  const clusters = clusterBySimilarity(unassigned, clusterThreshold);

  const matchedTopicIds: string[] = [];
  const newTopics: Topic[] = [];
  const pairTopicAssignments: { pairId: string; topicId: string }[] = [];
  const centroidUpdates: { topicId: string; vector: number[]; pairCount: number }[] = [];

  for (const cluster of clusters) {
    let bestTopicId: string | undefined;
    let bestSimilarity = -Infinity;
    for (const [topicId, centroid] of existingCentroids) {
      const similarity = cosineSimilarity(cluster.centroid, centroid.vector);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestTopicId = topicId;
      }
    }

    if (bestTopicId !== undefined && bestSimilarity >= matchThreshold) {
      const existing = existingCentroids.get(bestTopicId)!;
      const mergedVector = weightedAverage(existing.vector, existing.pairCount, cluster.centroid, cluster.memberPairIds.length);
      const mergedCount = existing.pairCount + cluster.memberPairIds.length;
      centroidUpdates.push({ topicId: bestTopicId, vector: mergedVector, pairCount: mergedCount });
      existingCentroids.set(bestTopicId, { vector: mergedVector, pairCount: mergedCount });
      matchedTopicIds.push(bestTopicId);
      for (const pairId of cluster.memberPairIds) {
        pairTopicAssignments.push({ pairId, topicId: bestTopicId });
      }
    } else {
      // Labeling one cluster at a time, sequentially, keeps each prompt
      // small and any provider failure attributable to a specific cluster.
      const label = await labelTopic(cluster.questionTexts.slice(0, 3));
      const topic: Topic = { id: `topic-${randomUUID()}`, label, createdAt: new Date().toISOString() };
      newTopics.push(topic);
      centroidUpdates.push({ topicId: topic.id, vector: cluster.centroid, pairCount: cluster.memberPairIds.length });
      for (const pairId of cluster.memberPairIds) {
        pairTopicAssignments.push({ pairId, topicId: topic.id });
      }
    }
  }

  const finalTopics = [...existingTopics, ...newTopics];
  writeTopicsFile(duoDir, finalTopics);

  withDatabase(storePath, passphrase, true, (db) => {
    ensureQaPairsSchema(db);
    ensureTopicCentroidSchema(db);

    const updatePair = db.prepare(`UPDATE qa_pairs SET topic_id = ? WHERE id = ?`);
    for (const { pairId, topicId } of pairTopicAssignments) {
      updatePair.run(topicId, pairId);
    }

    const upsertCentroid = db.prepare(`
      INSERT INTO topic_centroids (topic_id, model, dimensions, vector, pair_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions, vector = excluded.vector, pair_count = excluded.pair_count
    `);
    for (const update of centroidUpdates) {
      upsertCentroid.run(update.topicId, embeddingProvider.model, update.vector.length, JSON.stringify(update.vector), update.pairCount);
    }

    syncTopicsTable(db, finalTopics);
  });

  return {
    assignedPairs: pairTopicAssignments.length,
    matchedTopicIds: [...new Set(matchedTopicIds)],
    newTopics,
  };
}
