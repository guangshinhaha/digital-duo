import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { appendDraft, recordDraftOutcome } from "../src/drafting/draft-log.js";
import {
  computeVoiceTrend,
  editCloseness,
  scoreDraftVoiceMatch,
  styleCloseness,
  VOICE_TREND_ANCHOR_SENDS,
  VOICE_TREND_REANCHOR_THRESHOLD,
} from "../src/derivation/voice-trend.js";
import { computeVoiceStats } from "../src/derivation/voice.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

/** Appends a draft and records its outcome, backdating `outcome_recorded_at` directly (test/recipient-autonomy.test.ts's own precedent) so a trend can be built across calendar buckets without waiting real time. */
function decide(storePath: string, draftText: string, outcome: "sent" | "edited", sentText: string | undefined, at: Date): string {
  const id = appendDraft(storePath, PASSPHRASE, {
    question: "how do I phrase this",
    threadContext: null,
    draftText,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.9,
    sources: [],
  });
  recordDraftOutcome(storePath, PASSPHRASE, id, outcome, outcome === "edited" ? sentText : undefined);
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    db.prepare(`UPDATE drafts SET outcome_recorded_at = ? WHERE id = ?`).run(at.toISOString(), id);
  });
  return id;
}

describe("scoreDraftVoiceMatch and its two halves", () => {
  it("edit closeness is 1 for identical text and falls as more of it changes", () => {
    expect(editCloseness("thanks, that works", "thanks, that works")).toBe(1);
    const closeButEdited = editCloseness("thanks, that works for me", "thanks, that works for me!");
    expect(closeButEdited).toBeGreaterThan(0.8);
    expect(closeButEdited).toBeLessThan(1);
    const rewritten = editCloseness("thanks, that works", "I would be grateful if you could confirm the arrangement at your earliest convenience");
    expect(rewritten).toBeLessThan(0.3);
  });

  it("style closeness falls as a draft's own measured features drift from the anchor's", () => {
    const anchor = computeVoiceStats(["hey thanks!", "hey cool, thanks!", "hey no worries, thanks!"]);
    const matching = styleCloseness("hey great, thanks!", anchor);
    const formalInstead = styleCloseness(
      "Dear Sir, I would be grateful if you could confirm the arrangement at your earliest convenience. Kind regards",
      anchor,
    );
    expect(matching).toBeGreaterThan(formalInstead);
  });

  it("composes both halves, clamped to 0..1 — a draft identical to the anchor's own text scores exactly 1", () => {
    const anchor = computeVoiceStats(["hey thanks!"]);
    const score = scoreDraftVoiceMatch("hey thanks!", "hey thanks!", anchor);
    expect(score).toBe(1);
    const driftedScore = scoreDraftVoiceMatch(
      "hey thanks!",
      "Dear Sir, I would be grateful for your confirmation at your earliest convenience.",
      anchor,
    );
    expect(driftedScore).toBeGreaterThanOrEqual(0);
    expect(driftedScore).toBeLessThan(score);
  });
});

describe("computeVoiceTrend", () => {
  it("reports tooThin with no bucket at all below the minimum approved-sends floor", () => {
    const storePath = initStore();
    for (let i = 0; i < VOICE_TREND_ANCHOR_SENDS - 1; i++) {
      decide(storePath, `hey thanks ${i}`, "sent", undefined, new Date("2026-09-01T00:00:00.000Z"));
    }
    const trend = computeVoiceTrend(storePath, PASSPHRASE, "week");
    expect(trend.tooThin).toBe(true);
    expect(trend.buckets).toHaveLength(0);
    expect(trend.totalApprovedSends).toBe(VOICE_TREND_ANCHOR_SENDS - 1);
  });

  it("scores a later bucket against an anchor built from the approved sends before it, highest for sends that needed no edit at all", () => {
    const storePath = initStore();
    const anchorWeek = new Date("2026-08-03T00:00:00.000Z"); // a Monday
    for (let i = 0; i < VOICE_TREND_ANCHOR_SENDS; i++) {
      decide(storePath, `hey thanks for the update ${i}!`, "sent", undefined, new Date(anchorWeek.getTime() + i * 1000));
    }
    const nextWeek = new Date(anchorWeek.getTime() + WEEK_MS);
    decide(storePath, "hey thanks for the update!", "sent", undefined, nextWeek);

    const trend = computeVoiceTrend(storePath, PASSPHRASE, "week");
    expect(trend.tooThin).toBe(false);
    // First bucket (the anchor's own sends) has nothing to score against yet.
    expect(trend.buckets[0]!.sampleSize).toBe(0);
    expect(trend.buckets[0]!.score).toBeNull();
    // Second bucket is scored against the anchor and matches it closely.
    const second = trend.buckets[1]!;
    expect(second.sampleSize).toBe(1);
    expect(second.score).not.toBeNull();
    expect(second.score!).toBeGreaterThan(0.9);
  });

  it("surfaces the worst-scoring drafts in a bucket, with a snippet of the duo's own (unedited) draft text", () => {
    const storePath = initStore();
    const anchorWeek = new Date("2026-08-03T00:00:00.000Z");
    for (let i = 0; i < VOICE_TREND_ANCHOR_SENDS; i++) {
      decide(storePath, `hey thanks for the update ${i}!`, "sent", undefined, new Date(anchorWeek.getTime() + i * 1000));
    }
    const nextWeek = new Date(anchorWeek.getTime() + WEEK_MS);
    const goodIds = [0, 1, 2, 3].map((i) =>
      decide(storePath, `hey thanks for the update ${i}!`, "sent", undefined, new Date(nextWeek.getTime() + i * 1000)),
    );
    const badId = decide(
      storePath,
      "hey thanks!",
      "edited",
      "Dear Sir, I would be grateful if you could confirm receipt of the attached documentation at your earliest convenience. Kind regards.",
      new Date(nextWeek.getTime() + 5000),
    );

    const trend = computeVoiceTrend(storePath, PASSPHRASE, "week");
    const second = trend.buckets[1]!;
    expect(second.sampleSize).toBe(5);
    expect(second.worstExamples).toHaveLength(3);
    expect(second.worstExamples[0]!.draftId).toBe(badId);
    expect(second.worstExamples[0]!.score).toBeLessThan(second.worstExamples[1]!.score);
    // The bad draft's score is well below any of the four matching ones, so
    // it can never be crowded out of the worst-3 by ties among the good ones.
    for (const goodId of goodIds) {
      const inWorst = second.worstExamples.find((example) => example.draftId === goodId);
      if (inWorst) {
        expect(inWorst.score).toBeGreaterThan(second.worstExamples[0]!.score);
      }
    }
    expect(second.worstExamples[0]!.snippet).toContain("hey thanks");
  });

  it("re-anchors the bucket after one whose score fell below the threshold", () => {
    const storePath = initStore();
    const anchorWeek = new Date("2026-08-03T00:00:00.000Z");
    for (let i = 0; i < VOICE_TREND_ANCHOR_SENDS; i++) {
      decide(storePath, `hey thanks for the update ${i}!`, "sent", undefined, new Date(anchorWeek.getTime() + i * 1000));
    }
    // A whole week of heavily-edited, totally different drafts — far enough
    // from the anchor that the bucket average must fall below threshold.
    const driftWeek = new Date(anchorWeek.getTime() + WEEK_MS);
    for (let i = 0; i < VOICE_TREND_ANCHOR_SENDS; i++) {
      decide(
        storePath,
        "hey thanks!",
        "edited",
        `Dear Sir, I would be grateful if you could confirm the arrangement at your earliest convenience regarding matter number ${i}. Kind regards.`,
        new Date(driftWeek.getTime() + i * 1000),
      );
    }
    const thirdWeek = new Date(driftWeek.getTime() + WEEK_MS);
    decide(storePath, "hey thanks for the update!", "sent", undefined, thirdWeek);

    const trend = computeVoiceTrend(storePath, PASSPHRASE, "week");
    expect(trend.buckets[1]!.score!).toBeLessThan(VOICE_TREND_REANCHOR_THRESHOLD);
    expect(trend.buckets[2]!.reanchored).toBe(true);
  });

  it("buckets by month when asked", () => {
    const storePath = initStore();
    const start = new Date("2026-08-01T00:00:00.000Z");
    for (let i = 0; i < VOICE_TREND_ANCHOR_SENDS; i++) {
      decide(storePath, `hey thanks for the update ${i}!`, "sent", undefined, new Date(start.getTime() + i * 1000));
    }
    decide(storePath, "hey thanks for the update!", "sent", undefined, new Date("2026-09-15T00:00:00.000Z"));
    const trend = computeVoiceTrend(storePath, PASSPHRASE, "month");
    expect(trend.bucketing).toBe("month");
    expect(trend.buckets).toHaveLength(2);
  });
});
