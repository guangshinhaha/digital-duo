import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { CorpusTooShortError } from "../src/eval/time-split.js";
import { runOfflineEval, WOULD_HAVE_SENT_CAVEAT } from "../src/eval/offline-eval.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore } from "../src/store/store.js";
import { confirmNoRefusals, writeRefusalsFile } from "../src/trust/refusals.js";

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
function record(overrides: Partial<RecordInput> & { text: string; timestamp: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_thinking",
    author: "me",
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** Four q/a pairs about "leave", spread across January (train), and one held-out pair in mid-March asking the same thing again. */
function buildCorpus(): RecordInput[] {
  const records: RecordInput[] = [];
  for (let i = 0; i < 4; i++) {
    const day = String(i * 5 + 1).padStart(2, "0");
    const threadId = `leave-thread-${i}`;
    records.push(
      record({
        kind: "question_to_me",
        author: "other",
        text: "what's our leave policy this quarter?",
        timestamp: `2026-01-${day}T09:00:00.000Z`,
        threadId,
      }),
    );
    records.push(
      record({
        kind: "my_answer",
        author: "me",
        text: "five days of leave per quarter, per the vacation policy",
        timestamp: `2026-01-${day}T09:05:00.000Z`,
        threadId,
      }),
    );
  }
  // Held out: same subject, asked again after the holdout window opens.
  records.push(
    record({
      kind: "question_to_me",
      author: "other",
      text: "what's the leave policy again this time?",
      timestamp: "2026-03-15T09:00:00.000Z",
      threadId: "leave-thread-held-out",
    }),
  );
  records.push(
    record({
      kind: "my_answer",
      author: "me",
      text: "still five days of leave per quarter, same vacation policy",
      timestamp: "2026-03-15T09:05:00.000Z",
      threadId: "leave-thread-held-out",
    }),
  );
  return records;
}

describe("runOfflineEval — the real time-split harness (#35)", () => {
  it("refuses a corpus shorter than the configured holdout window (AC2)", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    writeRecords(storePath, PASSPHRASE, [
      record({ text: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ text: "b", timestamp: "2026-01-05T00:00:00.000Z" }),
    ]);

    await expect(
      runOfflineEval(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 42),
    ).rejects.toThrow(CorpusTooShortError);
  });

  it("splits before deriving, drafts against real held-out answers, and cleans up every scratch file it created", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    writeRecords(storePath, PASSPHRASE, buildCorpus());

    const dataDirBefore = readdirSync(join(tempDir(), "data"));

    const report = await runOfflineEval(
      storePath,
      PASSPHRASE,
      duoDir(),
      createFakeEmbeddingProvider(),
      undefined, // no inference provider — exercises the deterministic extractive fallback
      CONFIDENCE_CONFIG,
      30, // holdoutDays: corpus spans Jan 1 to Mar 15 (~73 days), comfortably more than 30
      { seed: 1 },
    );

    expect(report.holdoutDays).toBe(30);
    expect(report.trainRecordCount).toBe(8); // 4 train pairs, 2 records each
    expect(report.heldOutRecordCount).toBe(2);
    expect(report.heldOutPairCount).toBe(1);
    expect(report.evaluatedCount).toBe(1);
    expect(report.confirmedRuleCount).toBe(1); // 4 supporting pairs, identical answers → confirmed

    const [item] = report.items;
    expect(item.questionText).toBe("what's the leave policy again this time?");
    expect(item.realAnswerText).toBe("still five days of leave per quarter, same vacation policy");
    expect(item.escalated).toBe(false);
    expect(item.draftedText).not.toBeNull();
    // The fake embedding provider maps "leave"/"vacation" to the same
    // synonym-group dimension, so the drafted text (pulled from train
    // evidence) and the real answer should agree strongly.
    expect(item.similarity).not.toBeNull();
    expect(item.similarity as number).toBeGreaterThan(0.5);
    expect(item.wouldHaveSent).toBe("not_judged"); // no inference provider configured

    // Nothing scratch survives the run: no extra files in data/, and the
    // real duo/topics.json (or its absence) is untouched by the harness's
    // own, isolated derivation pass.
    expect(readdirSync(join(tempDir(), "data"))).toEqual(dataDirBefore);
    expect(existsSync(join(duoDir(), "topics.json"))).toBe(false);
  });

  it("is reproducible: two runs over the same corpus and seed report the same score (AC3)", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    writeRecords(storePath, PASSPHRASE, buildCorpus());

    const runOnce = () =>
      runOfflineEval(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 30, { seed: 7 });

    const first = await runOnce();
    const second = await runOnce();

    expect(second.meanSimilarity).toBe(first.meanSimilarity);
    expect(second.items.map((item) => item.qaPairId)).toEqual(first.items.map((item) => item.qaPairId));
    expect(second.items.map((item) => item.draftedText)).toEqual(first.items.map((item) => item.draftedText));
    expect(second.humanReviewSample).toEqual(first.humanReviewSample);
  });

  it("caps the evaluated set with --sample and still reports the full held-out count", async () => {
    const storePath = initStore();
    confirmNoRefusals(duoDir());
    writeRecords(storePath, PASSPHRASE, buildCorpus());

    const report = await runOfflineEval(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 30, {
      sampleSize: 0,
      seed: 1,
    });
    expect(report.heldOutPairCount).toBe(1);
    expect(report.evaluatedCount).toBe(0);
    expect(report.items).toEqual([]);
  });
});

describe("runOfflineEval — a real refusal is honored inside the scratch run, never bypassed", () => {
  it("escalates a held-out question that matches a refusal heading, instead of drafting from train evidence", async () => {
    const storePath = initStore();
    // A real refusal, recorded before the harness ever runs — copyRefusalsFile
    // must carry it into the isolated scratch duoDir the harness derives in.
    writeRefusalsFile(duoDir(), [{ heading: "leave", reason: "HR owns leave policy communications, not the duo." }]);
    writeRecords(storePath, PASSPHRASE, buildCorpus());

    const report = await runOfflineEval(storePath, PASSPHRASE, duoDir(), createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, 30, {
      seed: 1,
    });

    expect(report.evaluatedCount).toBe(1);
    const [item] = report.items;
    expect(item.escalated).toBe(true);
    expect(item.draftedText).toBeNull();
    expect(item.similarity).toBeNull();
  });
});

describe("WOULD_HAVE_SENT_CAVEAT", () => {
  it("is a real, non-empty caveat, not silently omitted", () => {
    expect(WOULD_HAVE_SENT_CAVEAT.length).toBeGreaterThan(0);
    expect(WOULD_HAVE_SENT_CAVEAT).toMatch(/not ground truth/);
  });
});
