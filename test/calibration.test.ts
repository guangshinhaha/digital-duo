import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import {
  CalibrationItemNotFoundError,
  CalibrationSessionNotFoundError,
  HELD_OUT_CAVEAT,
  InvalidCalibrationJudgementError,
  buildCalibrationSummary,
  findIncompleteCalibrationSession,
  findLatestCalibrationSession,
  listCalibrationJudgements,
  nextUnjudgedItem,
  recordCalibrationJudgement,
  startOrResumeCalibration,
} from "../src/derivation/calibration.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { getDraft } from "../src/drafting/draft-log.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { confirmNoRefusals, RefusalsNotDecidedError } from "../src/trust/refusals.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** Seeds one q/a pair, assigned to `topicId`, with a distinct, increasing timestamp each call (most-recently-seeded sorts first). */
async function seedPair(storePath: string, topicId: string, questionText: string, answerText: string): Promise<string> {
  const question = record({ kind: "question_to_me", author: "other", text: questionText, threadId: `thread-${counter}` });
  const answer = record({ text: answerText, threadId: question.threadId });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  const embeddingProvider = createFakeEmbeddingProvider();
  await embedRecords(storePath, PASSPHRASE, embeddingProvider);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
  return pairs[0].id;
}

async function seedApprovedRule(storePath: string, topicId: string, ruleText: string): Promise<void> {
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: topicId,
        topicId,
        text: ruleText,
        status: "confirmed",
        supportCount: 3,
        consistency: 0.95,
        createdAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
        reviewStatus: "approved",
        origin: "derived",
        supersededByRuleId: null,
        correctionDraftId: null,
        correctionQuestion: null,
      },
      [],
    );
  });
}

async function setUpReadyCorpus(storePath: string, count = 3): Promise<void> {
  await seedApprovedRule(storePath, "topic-leave", "Standard leave is five days per quarter.");
  for (let i = 0; i < count; i++) {
    await seedPair(storePath, "topic-leave", `question ${i} about leave`, "five days per quarter, per the vacation policy");
  }
}

describe("startOrResumeCalibration — the onboarding gate (#30 AC2, #29's requireRefusalsDecision)", () => {
  it("refuses to start before the owner has made any refusals decision", async () => {
    const storePath = initStore();
    await setUpReadyCorpus(storePath);
    await expect(
      startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG),
    ).rejects.toThrow(RefusalsNotDecidedError);
  });

  it("proceeds once the owner has confirmed there are none", async () => {
    const storePath = initStore();
    await setUpReadyCorpus(storePath);
    confirmNoRefusals(duoDir());
    const result = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG);
    expect(result.status).toBe("started");
  });
});

describe("startOrResumeCalibration — too little history to calibrate", () => {
  it("reports insufficient_history on an empty store", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    const result = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG);
    expect(result).toEqual({ status: "insufficient_history", available: 0, wanted: 12 });
  });
});

describe("startOrResumeCalibration — generates a real proposed answer via #32's own draft pipeline", () => {
  it("produces items with the duo's real draft text, question, and real answer, each backed by a real draft-log row", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 2);

    const result = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 5);
    expect(result.status).toBe("started");
    if (result.status !== "started") return;

    expect(result.session.items).toHaveLength(2);
    for (const item of result.session.items) {
      expect(item.questionText).toMatch(/question \d about leave/);
      expect(item.realAnswerText).toBe("five days per quarter, per the vacation policy");
      expect(item.escalated).toBe(false);
      expect(item.proposedText).toBe("Standard leave is five days per quarter.");
      const draftRow = getDraft(storePath, PASSPHRASE, item.draftId);
      expect(draftRow).toBeDefined();
      expect(draftRow!.outcome).toBeNull(); // not judged yet
    }
  });

  it("takes at most `count` items, most-recent qa_pairs first", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 5);

    const result = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 3);
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.session.items).toHaveLength(3);
    // Seeded in order 0..4 with increasing timestamps; most recent first means "question 4", "question 3", "question 2".
    expect(result.session.items.map((item) => item.questionText)).toEqual([
      "question 4 about leave",
      "question 3 about leave",
      "question 2 about leave",
    ]);
  });
});

describe("startOrResumeCalibration — AC3: resuming preserves progress, never re-selects", () => {
  it("hands back the exact same session and items on a second call while one is incomplete", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 3);

    const first = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 2);
    expect(first.status).toBe("started");
    if (first.status !== "started") return;

    const second = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 2);
    expect(second.status).toBe("resumed");
    if (second.status !== "resumed") return;
    expect(second.session).toEqual(first.session);
  });

  it("a brand-new session after the first completes never repeats an already-used qa_pair", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 4);

    const first = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 2);
    if (first.status !== "started") throw new Error("expected started");
    for (const item of first.session.items) {
      recordCalibrationJudgement(storePath, PASSPHRASE, first.session.id, item.qaPairId, "approved");
    }
    expect(findIncompleteCalibrationSession(storePath, PASSPHRASE)).toBeUndefined();

    const second = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 2);
    if (second.status !== "started") throw new Error("expected started");
    const firstIds = new Set(first.session.items.map((item) => item.qaPairId));
    for (const item of second.session.items) {
      expect(firstIds.has(item.qaPairId)).toBe(false);
    }
  });
});

describe("recordCalibrationJudgement — AC1: judgements are stored, and feed the same pipeline as a corrected draft", () => {
  it("approving records the judgement and marks the underlying draft 'sent'", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];

    const result = recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "approved");
    expect(result.judgedCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.session.completedAt).not.toBeNull();

    expect(getDraft(storePath, PASSPHRASE, item.draftId)!.outcome).toBe("sent");
    const [judgement] = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    expect(judgement).toMatchObject({ qaPairId: item.qaPairId, judgement: "approved", editedText: null });
  });

  it("editing records the corrected text and marks the underlying draft 'edited'", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];

    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "edited", "Actually it's five days, use them within the quarter.");

    expect(getDraft(storePath, PASSPHRASE, item.draftId)!.outcome).toBe("edited");
    const [judgement] = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    expect(judgement.editedText).toBe("Actually it's five days, use them within the quarter.");
  });

  it("rejecting marks the underlying draft 'discarded'", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];

    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "rejected");
    expect(getDraft(storePath, PASSPHRASE, item.draftId)!.outcome).toBe("discarded");
  });

  it("re-judging the same item overwrites the previous judgement and draft outcome", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];

    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "rejected");
    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "approved");

    expect(getDraft(storePath, PASSPHRASE, item.draftId)!.outcome).toBe("sent");
    const judgements = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    expect(judgements).toHaveLength(1);
    expect(judgements[0].judgement).toBe("approved");
  });

  it("rejects editing when no edited text is given, and rejects edited text on a non-edited judgement", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];

    expect(() => recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "edited")).toThrow(
      InvalidCalibrationJudgementError,
    );
    expect(() =>
      recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "approved", "unexpected text"),
    ).toThrow(InvalidCalibrationJudgementError);
  });

  it("throws for an unknown session or an item not in the session", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");

    expect(() => recordCalibrationJudgement(storePath, PASSPHRASE, "no-such-session", "no-such-pair", "approved")).toThrow(
      CalibrationSessionNotFoundError,
    );
    expect(() => recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, "no-such-pair", "approved")).toThrow(
      CalibrationItemNotFoundError,
    );
  });
});

describe("recordCalibrationJudgement — an escalated item (no rule hit, no evidence)", () => {
  /** Question/answer text sharing no words at all, and touching none of the fake embedding provider's synonym groups — hybridSearch's FTS half finds no overlap and its embedding half scores 0 similarity (filtered out), so gatherDraftContext returns zero evidence and no rule hit, which is exactly what makes draftReply escalate instead of drafting. */
  async function seedUnretrievablePair(storePath: string): Promise<void> {
    await seedPair(storePath, "topic-orphan", "zzqx nonsense query terms only", "wibble wobble unrelated content phrase");
  }

  it("allows approving or rejecting an escalation, without touching the (nonexistent) draft outcome", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await seedUnretrievablePair(storePath);

    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];
    expect(item.escalated).toBe(true);
    expect(item.proposedText).toBeNull();

    const result = recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "rejected");
    expect(result.session.completedAt).not.toBeNull();
    // No draft text ever existed for this item, so there is nothing for recordDraftOutcome to describe — the outcome stays unset.
    expect(getDraft(storePath, PASSPHRASE, item.draftId)!.outcome).toBeNull();
  });

  it("refuses to edit an escalation — there is no draft text to edit", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await seedUnretrievablePair(storePath);

    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const item = started.session.items[0];
    expect(item.escalated).toBe(true);

    expect(() =>
      recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "edited", "some corrected text"),
    ).toThrow(InvalidCalibrationJudgementError);
  });
});

describe("nextUnjudgedItem — pure resumability primitive", () => {
  it("returns the first item without a judgement, in session order", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 2);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 2);
    if (started.status !== "started") throw new Error("expected started");

    expect(nextUnjudgedItem(started.session, [])).toEqual(started.session.items[0]);
    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, started.session.items[0].qaPairId, "approved");
    const judgements = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    expect(nextUnjudgedItem(started.session, judgements)).toEqual(started.session.items[1]);
  });

  it("returns undefined once every item has a judgement", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, started.session.items[0].qaPairId, "approved");
    const judgements = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    expect(nextUnjudgedItem(started.session, judgements)).toBeUndefined();
  });
});

describe("buildCalibrationSummary — AC2: a bad run is reported honestly, not smoothed over", () => {
  it("computes 0 agreement, never NaN, before anything is judged", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 1);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 1);
    if (started.status !== "started") throw new Error("expected started");
    const summary = buildCalibrationSummary(started.session, []);
    expect(summary.agreementRate).toBe(0);
    expect(summary.lowAgreement).toBe(false); // nothing judged yet — not yet a "bad run"
    expect(summary.mismatches).toEqual([]);
  });

  it("reports low agreement plainly and lists every rejected/edited item in full, never suppressing a bad result", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 3);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 3);
    if (started.status !== "started") throw new Error("expected started");

    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, started.session.items[0].qaPairId, "approved");
    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, started.session.items[1].qaPairId, "rejected");
    recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, started.session.items[2].qaPairId, "edited", "corrected text");

    const judgements = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    const summary = buildCalibrationSummary(started.session, judgements);

    expect(summary.approvedCount).toBe(1);
    expect(summary.rejectedCount).toBe(1);
    expect(summary.editedCount).toBe(1);
    expect(summary.agreementRate).toBeCloseTo(1 / 3, 5);
    expect(summary.lowAgreement).toBe(true);
    expect(summary.mismatches).toHaveLength(2);
    const edited = summary.mismatches.find((m) => m.judgement === "edited");
    expect(edited?.editedText).toBe("corrected text");
    const rejected = summary.mismatches.find((m) => m.judgement === "rejected");
    expect(rejected?.editedText).toBeNull();
  });

  it("does not flag lowAgreement when agreement is high", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    await setUpReadyCorpus(storePath, 2);
    const started = await startOrResumeCalibration(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 2);
    if (started.status !== "started") throw new Error("expected started");
    for (const item of started.session.items) {
      recordCalibrationJudgement(storePath, PASSPHRASE, started.session.id, item.qaPairId, "approved");
    }
    const judgements = listCalibrationJudgements(storePath, PASSPHRASE, started.session.id);
    const summary = buildCalibrationSummary(started.session, judgements);
    expect(summary.agreementRate).toBe(1);
    expect(summary.lowAgreement).toBe(false);
  });
});

describe("findLatestCalibrationSession", () => {
  it("returns undefined when no session has ever been created", () => {
    const storePath = initStore();
    expect(findLatestCalibrationSession(storePath, PASSPHRASE)).toBeUndefined();
  });
});

describe("HELD_OUT_CAVEAT — honest about the calibration set's real limitation", () => {
  it("is a non-empty, informative string", () => {
    expect(HELD_OUT_CAVEAT.length).toBeGreaterThan(20);
    expect(HELD_OUT_CAVEAT.toLowerCase()).toMatch(/held-out|train/);
  });
});
