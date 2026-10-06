import { ensureDraftLogSchema } from "../drafting/draft-log.js";
import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { Database } from "../store/store.js";
import { withDatabase } from "../store/store.js";
import { computeVoiceStats, type VoiceStats } from "./voice.js";

/**
 * guangshinhaha/duo#276: "how closely your duo still sounds like you" —
 * persona drift is a known failure mode nobody shows (Character.ai), so the
 * Portrait gets a trend instead of a one-off number.
 *
 * The measure is built entirely from what the draft log already records
 * (`drafting/draft-log.ts`'s `drafts` table) — the same table
 * `drafting/recipient-voice.ts` reads for its own per-recipient tone, and
 * the same `computeVoiceStats` extractor it shares with the general voice
 * profile (`derivation/voice.ts`). No new scoring model, no new store: a
 * draft's *own text* (what the duo actually produced, before any edit) is
 * compared against (1) the text the owner ultimately sent for that same
 * question — edit distance — and (2) the stylistic "anchor" of the owner's
 * own recent approved sends — the same handful of features recipient-voice
 * already measures (length, hedging, bullets, emoji, greeting/sign-off).
 *
 * The anchor re-derives ("re-anchors") only when a bucket's average score
 * drops below `VOICE_TREND_REANCHOR_THRESHOLD` (duo#276 AC3) — otherwise it
 * stays fixed, so the trend shows genuine drift against a stable baseline
 * rather than a baseline that quietly chases every dip back to zero.
 *
 * Read-only and additive: this touches no shared dispatch path — it is a
 * new query over a table other modules already read the same way
 * (recipient-voice.ts's own raw `SELECT ... FROM drafts` precedent), wired
 * to one new route (`GET /mirror/voice-trend`) that calls nothing else.
 */

export type VoiceTrendBucketing = "week" | "month";

/** How many of the most recent approved sends make up one anchor (recipient-voice.ts's own MAX_SENDS_CONSIDERED uses the same order of magnitude for the same reason: recent enough to track a changed voice, stable enough to mean something). */
export const VOICE_TREND_ANCHOR_SENDS = 20;

/** Below this many approved sends total, there has never been enough to establish even one anchor — the trend is honestly empty, not a flat line at zero. */
export const VOICE_TREND_MINIMUM_SENDS = VOICE_TREND_ANCHOR_SENDS;

/** A bucket's average score below this triggers a re-anchor for the bucket after it (duo#276 AC3). */
export const VOICE_TREND_REANCHOR_THRESHOLD = 0.5;

/** How many of a bucket's lowest-scored drafts are kept as "the worst recent examples" (duo#276 AC2). */
export const VOICE_TREND_WORST_EXAMPLES = 3;

const SNIPPET_MAX_CHARS = 160;

export interface VoiceTrendExample {
  readonly draftId: string;
  /** 0 (least like the anchor) .. 1 (matched it exactly). */
  readonly score: number;
  /** The draft's own text as the duo wrote it, marking-stripped and truncated — never the text the owner ended up sending. */
  readonly snippet: string;
}

export interface VoiceTrendBucket {
  readonly periodStart: string;
  readonly periodEnd: string;
  /** How many approved drafts in this bucket were actually scored — 0 before the first anchor exists. */
  readonly sampleSize: number;
  /** The bucket's average score, or null when `sampleSize` is 0 (nothing scored yet, never a fabricated zero). */
  readonly score: number | null;
  /** True when this bucket's low score (the one *before* it, below threshold) triggered the anchor this bucket is scored against to be rebuilt. */
  readonly reanchored: boolean;
  /** Worst-scoring drafts in this bucket, lowest first — empty when nothing was scored. */
  readonly worstExamples: readonly VoiceTrendExample[];
}

export interface VoiceTrend {
  readonly bucketing: VoiceTrendBucketing;
  /** Oldest first. */
  readonly buckets: readonly VoiceTrendBucket[];
  /** True when fewer than `minimumSendsToCharacterize` approved sends exist at all — there has never been a trend to show. */
  readonly tooThin: boolean;
  readonly minimumSendsToCharacterize: number;
  readonly totalApprovedSends: number;
}

interface SendRow {
  id: string;
  draft_text: string | null;
  sent_text: string | null;
  outcome: string;
  outcome_recorded_at: string;
}

interface ScoredEntry {
  readonly draftId: string;
  readonly ts: string;
  readonly draftText: string;
  readonly finalText: string;
}

function cleanText(text: string): string {
  return stripMarkingLine({ text, classification: detectClassification(text) }).trim();
}

/** What the owner actually sent for this draft — `edited` outcomes use the recorded sent text; `sent` outcomes use it too when present, else the draft text itself (the owner kept it unchanged). Undefined when there is nothing usable to compare. */
function finalTextOf(row: SendRow): string | undefined {
  const text = row.outcome === "edited" ? row.sent_text : row.sent_text ?? row.draft_text;
  if (row.draft_text === null || text === null || text.trim().length === 0 || row.draft_text.trim().length === 0) {
    return undefined;
  }
  return cleanText(text);
}

function readApprovedSends(db: Database): ScoredEntry[] {
  ensureDraftLogSchema(db);
  const rows = db
    .prepare(
      `
      SELECT id, draft_text, sent_text, outcome, outcome_recorded_at
      FROM drafts
      WHERE outcome IN ('sent', 'edited') AND draft_text IS NOT NULL AND outcome_recorded_at IS NOT NULL
      ORDER BY outcome_recorded_at ASC, id ASC
    `,
    )
    .all() as unknown as SendRow[];
  const entries: ScoredEntry[] = [];
  for (const row of rows) {
    const finalText = finalTextOf(row);
    if (finalText === undefined) {
      continue;
    }
    entries.push({ draftId: row.id, ts: row.outcome_recorded_at, draftText: cleanText(row.draft_text as string), finalText });
  }
  return entries;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Levenshtein distance, capped so one very long draft can never make this
 * O(n*m) blow up — a trend score only needs to know "roughly how much
 * changed", not an exact edit script over an arbitrarily long message.
 */
const DISTANCE_CAP_CHARS = 1000;

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** 1 when the two texts are identical, falling toward 0 as more of the longer text would need to change to produce the other. */
export function editCloseness(draftText: string, finalText: string): number {
  if (draftText === finalText) {
    return 1;
  }
  const a = draftText.slice(0, DISTANCE_CAP_CHARS);
  const b = finalText.slice(0, DISTANCE_CAP_CHARS);
  const maxLen = Math.max(a.length, b.length, 1);
  return clamp01(1 - levenshteinDistance(a, b) / maxLen);
}

/** How close one draft's own measured style sits to the anchor population's rates — the same six features computeVoiceStats already extracts, each read as a single text's 0/1 against the anchor's rate. */
export function styleCloseness(draftText: string, anchor: VoiceStats): number {
  const own = computeVoiceStats([draftText]);
  const lengthCloseness = 1 - Math.min(1, Math.abs(own.medianWordCount - anchor.medianWordCount) / Math.max(anchor.medianWordCount, 1));
  const closenesses = [
    lengthCloseness,
    1 - Math.abs(own.hedgeRate - anchor.hedgeRate),
    1 - Math.abs(own.bulletRate - anchor.bulletRate),
    1 - Math.abs(own.emojiRate - anchor.emojiRate),
    1 - Math.abs(own.greetingRate - anchor.greetingRate),
    1 - Math.abs(own.signOffRate - anchor.signOffRate),
  ];
  return clamp01(closenesses.reduce((sum, value) => sum + value, 0) / closenesses.length);
}

/** One draft's voice-match score against `anchor` — half how little the owner had to change it, half how closely its own style sits to the anchor's recent-sends profile. */
export function scoreDraftVoiceMatch(draftText: string, finalText: string, anchor: VoiceStats): number {
  return clamp01(0.5 * editCloseness(draftText, finalText) + 0.5 * styleCloseness(draftText, anchor));
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The Monday (UTC) starting the ISO week `ts` falls in. */
function weekStart(ts: string): Date {
  const date = new Date(ts);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  utc.setUTCDate(utc.getUTCDate() + diff);
  return utc;
}

function bucketKeyAndRange(ts: string, bucketing: VoiceTrendBucketing): { key: string; start: Date; end: Date } {
  if (bucketing === "month") {
    const date = new Date(ts);
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, -1));
    return { key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, start, end };
  }
  const start = weekStart(ts);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return { key: start.toISOString().slice(0, 10), start, end };
}

/**
 * Builds the voice-match trend (duo#276) straight from the draft log's own
 * approved sends — nothing staged, nothing cached: every read sees exactly
 * what the owner has sent and edited so far.
 */
export function computeVoiceTrend(storePath: string, passphrase: string, bucketing: VoiceTrendBucketing = "week"): VoiceTrend {
  const entries = withDatabase(storePath, passphrase, false, (db) => readApprovedSends(db));

  if (entries.length < VOICE_TREND_MINIMUM_SENDS) {
    return { bucketing, buckets: [], tooThin: true, minimumSendsToCharacterize: VOICE_TREND_MINIMUM_SENDS, totalApprovedSends: entries.length };
  }

  // Group chronologically into calendar buckets, preserving order within each.
  const byKey = new Map<string, { start: Date; end: Date; entries: ScoredEntry[] }>();
  const order: string[] = [];
  for (const entry of entries) {
    const { key, start, end } = bucketKeyAndRange(entry.ts, bucketing);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { start, end, entries: [] };
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.entries.push(entry);
  }

  let anchor: VoiceStats | null = null;
  let anchorWindow: string[] = [];
  let pendingReanchor = false;
  const outBuckets: VoiceTrendBucket[] = [];

  for (const key of order) {
    const bucket = byKey.get(key)!;
    // Seed or rebuild the anchor from the most recent VOICE_TREND_ANCHOR_SENDS
    // approved sends up to (not including) this bucket — never from this
    // bucket's own entries, so a bucket is always scored against something
    // measured before it, not against itself.
    if (anchor === null && anchorWindow.length >= VOICE_TREND_ANCHOR_SENDS) {
      anchor = computeVoiceStats(anchorWindow.slice(-VOICE_TREND_ANCHOR_SENDS));
    } else if (pendingReanchor) {
      anchor = computeVoiceStats(anchorWindow.slice(-VOICE_TREND_ANCHOR_SENDS));
      pendingReanchor = false;
    }

    const scored = anchor
      ? bucket.entries.map((entry) => ({ entry, score: scoreDraftVoiceMatch(entry.draftText, entry.finalText, anchor!) }))
      : [];
    const averageScore = scored.length > 0 ? scored.reduce((sum, s) => sum + s.score, 0) / scored.length : null;
    const worstExamples: VoiceTrendExample[] = [...scored]
      .sort((a, b) => a.score - b.score)
      .slice(0, VOICE_TREND_WORST_EXAMPLES)
      .map(({ entry, score }) => ({ draftId: entry.draftId, score, snippet: truncate(entry.draftText, SNIPPET_MAX_CHARS) }));

    outBuckets.push({
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      sampleSize: scored.length,
      score: averageScore,
      // Set for real in the second pass below, once every bucket's score is known.
      reanchored: false,
      worstExamples,
    });

    // Feed this bucket's own approved sends into the rolling window *after*
    // scoring it, and flag the *next* bucket for a re-anchor if this one's
    // average fell below threshold (duo#276 AC3).
    for (const entry of bucket.entries) {
      anchorWindow.push(entry.finalText);
    }
    if (anchorWindow.length > VOICE_TREND_ANCHOR_SENDS * 4) {
      anchorWindow = anchorWindow.slice(-VOICE_TREND_ANCHOR_SENDS * 4);
    }
    if (averageScore !== null && averageScore < VOICE_TREND_REANCHOR_THRESHOLD) {
      pendingReanchor = true;
    }
  }

  // Second pass: mark `reanchored` on the bucket whose anchor was actually
  // rebuilt (the one right after a sub-threshold bucket) — computed above
  // as a side effect of the loop's own `pendingReanchor` transitions, but
  // cleaner to derive directly from the scores than to thread booleans
  // through the scoring loop above.
  for (let i = 1; i < outBuckets.length; i++) {
    const prev = outBuckets[i - 1]!;
    outBuckets[i] = { ...outBuckets[i]!, reanchored: prev.score !== null && prev.score < VOICE_TREND_REANCHOR_THRESHOLD };
  }

  return {
    bucketing,
    buckets: outBuckets,
    tooThin: false,
    minimumSendsToCharacterize: VOICE_TREND_MINIMUM_SENDS,
    totalApprovedSends: entries.length,
  };
}
