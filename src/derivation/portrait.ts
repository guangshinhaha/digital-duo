import { withDatabase } from "../store/store.js";
import { ensureQaPairsSchema } from "./qa-pairs.js";
import { readTopicsFile } from "./topics.js";

/**
 * v1-tech-design.md §1.6 / AR-3: the Mirror's opening screen needs no rule
 * induction at all — only pair extraction (#23) and topic assignment (#24)
 * — so it's the number worth forwarding to a director even when every topic
 * is still too thin to have a confirmed rule.
 *
 * "Who asks most" (issue #27's AC1) has no real answer in this schema yet:
 * `IngestRecord` carries no per-person asker identity (see qa-pairs.ts's
 * own note — only a multi-party source, e.g. Slack, would produce one, and
 * that's blocked on #15/#22). `threadId` is the closest thing the corpus
 * has to "who" today, so this reports the busiest *threads* and says so
 * plainly rather than pretending a thread id is a person's name.
 */
export interface TopicShare {
  readonly topicId: string;
  readonly label: string;
  readonly count: number;
  /** 0..1 of `totalQuestions`. */
  readonly share: number;
}

export interface ThreadShare {
  readonly threadId: string;
  readonly count: number;
  /** 0..1 of `totalQuestions`. */
  readonly share: number;
}

export interface InterruptionPortrait {
  readonly totalQuestions: number;
  /** Timestamp of the earliest extracted pair, or null when there are none. */
  readonly periodStart: string | null;
  /** Timestamp of the most recent extracted pair, or null when there are none. */
  readonly periodEnd: string | null;
  /** Every topic with at least one pair, most-asked first — never truncated, so a small topic is never simply absent from the data (AC3). */
  readonly topicBreakdown: readonly TopicShare[];
  /** Share of `totalQuestions` held by the five busiest topics (AC1). */
  readonly topFiveShare: number;
  /** The five busiest threads — see the module doc on why this isn't "who" yet. */
  readonly busiestThreads: readonly ThreadShare[];
  /** True when there isn't enough history to characterise (AC2) — the caller should show the plain "not enough history" message instead of the breakdown. */
  readonly tooThin: boolean;
  /** The threshold `tooThin` is judged against, surfaced so the message can name it. */
  readonly minimumQuestionsToCharacterize: number;
}

/**
 * Below this many extracted pairs, a "distribution across topics" is
 * mostly noise — a handful of questions rendered as percentages looks
 * confident but characterises nothing (AC2). Deliberately smaller than
 * rules.ts's own per-topic support threshold (3): this is a corpus-wide
 * floor, not a per-topic one, and the portrait's whole point (AR-3) is to
 * still say something useful well before any topic clears rule induction's
 * bar.
 */
const MIN_QUESTIONS_TO_CHARACTERIZE = 10;

interface QaPairRow {
  topic_id: string | null;
  thread_id: string;
  ts: string;
}

/** A pair not yet topic-assigned (#24 hasn't run, or hasn't gotten to it yet) is grouped under this key rather than dropped — it's still a real interruption. */
const UNASSIGNED_TOPIC_ID = "unassigned";
const UNASSIGNED_TOPIC_LABEL = "not yet assigned to a topic";

function shareOf(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/**
 * Builds the interruption portrait (v1-tech-design.md §1.6, AR-3) straight
 * from qa_pairs + duo/topics.json — the two artifacts #23/#24 already
 * produce, nothing from rule induction. Read-only: this never writes
 * anything, so opening the Mirror never has a side effect.
 */
export function buildInterruptionPortrait(storePath: string, passphrase: string, duoDir: string): InterruptionPortrait {
  const topics = readTopicsFile(duoDir);
  const topicLabels = new Map(topics.map((topic) => [topic.id, topic.label]));

  const rows = withDatabase(storePath, passphrase, false, (db) => {
    ensureQaPairsSchema(db);
    return db.prepare(`SELECT topic_id, thread_id, ts FROM qa_pairs ORDER BY ts ASC`).all() as unknown as QaPairRow[];
  });

  const total = rows.length;
  if (total === 0) {
    return {
      totalQuestions: 0,
      periodStart: null,
      periodEnd: null,
      topicBreakdown: [],
      topFiveShare: 0,
      busiestThreads: [],
      tooThin: true,
      minimumQuestionsToCharacterize: MIN_QUESTIONS_TO_CHARACTERIZE,
    };
  }

  const byTopic = new Map<string, number>();
  const byThread = new Map<string, number>();
  for (const row of rows) {
    const topicKey = row.topic_id ?? UNASSIGNED_TOPIC_ID;
    byTopic.set(topicKey, (byTopic.get(topicKey) ?? 0) + 1);
    byThread.set(row.thread_id, (byThread.get(row.thread_id) ?? 0) + 1);
  }

  const topicBreakdown: TopicShare[] = [...byTopic.entries()]
    .map(([topicId, count]) => ({
      topicId,
      label: topicId === UNASSIGNED_TOPIC_ID ? UNASSIGNED_TOPIC_LABEL : topicLabels.get(topicId) ?? topicId,
      count,
      share: shareOf(count, total),
    }))
    .sort((a, b) => b.count - a.count || a.topicId.localeCompare(b.topicId));

  const topFiveShare = topicBreakdown.slice(0, 5).reduce((sum, topic) => sum + topic.share, 0);

  const busiestThreads: ThreadShare[] = [...byThread.entries()]
    .map(([threadId, count]) => ({ threadId, count, share: shareOf(count, total) }))
    .sort((a, b) => b.count - a.count || a.threadId.localeCompare(b.threadId))
    .slice(0, 5);

  return {
    totalQuestions: total,
    periodStart: rows[0].ts,
    periodEnd: rows[rows.length - 1].ts,
    topicBreakdown,
    topFiveShare,
    busiestThreads,
    tooThin: total < MIN_QUESTIONS_TO_CHARACTERIZE,
    minimumQuestionsToCharacterize: MIN_QUESTIONS_TO_CHARACTERIZE,
  };
}
