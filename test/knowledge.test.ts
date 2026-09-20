import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";
import { buildInterruptionPortrait } from "../src/derivation/portrait.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { writeRuleByHand } from "../src/derivation/rule-review.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { describeDuoKnowledge } from "../src/duo/knowledge-summary.js";
import { getLastImportRun, type ImportRun } from "../src/ingest/import-runs.js";
import { ingestRecords } from "../src/ingest/two-phase.js";
import { createRecord } from "../src/ingest/record.js";
import { loadSharedDuoConfig } from "../src/shared-duo/config.js";
import { appendUsageEntry } from "../src/shared-duo/usage-log.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(name = "duo.db"): string {
  const storePath = join(tempDir(), "data", name);
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(): string {
  return join(tempDir(), "duo");
}

function qaThread(n: number, question: string, answer: string) {
  const threadId = `t${n}`;
  return [
    createRecord({ source: "paste", sourceRef: null, kind: "question_to_me", author: "other", text: question, timestamp: `2026-01-0${n}T10:00:00.000Z`, threadId, audience: "channel" }),
    createRecord({ source: "paste", sourceRef: null, kind: "my_answer", author: "me", text: answer, timestamp: `2026-01-0${n}T10:01:00.000Z`, threadId, audience: "channel" }),
  ];
}

describe("import runs — the fact behind 'when the last import ran' (#175)", () => {
  it("is null on a store that has never seen an import, and the route must be able to say so honestly", () => {
    const storePath = initStore("runs-empty.db");
    expect(getLastImportRun(storePath, PASSPHRASE)).toBeNull();
  });

  it("records one run per completed ingest, with the outcome the import reported", () => {
    const storePath = initStore("runs.db");
    const records = qaThread(1, "what is the leave policy?", "five days per quarter");
    const outcome = ingestRecords(storePath, PASSPHRASE, records);

    const run = getLastImportRun(storePath, PASSPHRASE);
    expect(run).not.toBeNull();
    expect(run?.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.staged).toBe(outcome.staged);
    expect(run.written).toBe(outcome.written);

    // A second import updates to the latest run.
    const second = ingestRecords(storePath, PASSPHRASE, qaThread(2, "who owns on-call?", "the platform team rotates"));
    expect(getLastImportRun(storePath, PASSPHRASE)?.written).toBe(second.written);
    expect(getLastImportRun(storePath, PASSPHRASE)?.runAt).not.toBe(run?.runAt);
  });
});

describe("describeDuoKnowledge — composition only, nothing computed new (#175)", () => {
  it("returns record counts by source, the last import, the portrait's own corpus/thin verdict, rule counts by review status, providers, and the shared usage report", async () => {
    const storePath = initStore();
    const dir = duoDir();

    // Two sources, via the real ingest pipeline (which also records the import run).
    ingestRecords(storePath, PASSPHRASE, qaThread(1, "what is the leave policy?", "five days per quarter"));
    ingestRecords(
      storePath,
      PASSPHRASE,
      [
        createRecord({ source: "slack-export", sourceRef: null, kind: "question_to_me", author: "other", text: "when do deploys freeze?", timestamp: "2026-02-01T10:00:00.000Z", threadId: "s1", audience: "channel" }),
        createRecord({ source: "slack-export", sourceRef: null, kind: "my_answer", author: "me", text: "deploys freeze on fridays", timestamp: "2026-02-01T10:01:00.000Z", threadId: "s1", audience: "channel" }),
      ],
    );

    // Topic coverage via the portrait's own inputs: qa pairs + topics file.
    const { pairs } = await extractQaPairs([
      ...qaThread(1, "what is the leave policy?", "five days per quarter"),
      ...qaThread(3, "how do I book the meeting room?", "use the floor plan page"),
    ]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
    writeTopicsFile(dir, [{ id: "topic-leave", label: "Leave policy", createdAt: new Date().toISOString() }]);

    // Rules: two approved by hand.
    writeRuleByHand(storePath, PASSPHRASE, dir, "leave", "five days per quarter");
    writeRuleByHand(storePath, PASSPHRASE, dir, "deploys", "deploys freeze on fridays");

    // Shared usage with a repeated out-of-scope question.
    const usageLogPath = loadSharedDuoConfig({ DUO_SHARED_USAGE_LOG_PATH: join(tempDir(), "shared-duo-runtime", "usage.json") }).usageLogPath;
    for (let i = 0; i < 3; i += 1) {
      appendUsageEntry(usageLogPath, { question: "who wins the world cup?", askerId: "sam", declined: true, citedTitles: [], staleCitation: false });
    }

    const knowledge = describeDuoKnowledge(
      storePath,
      PASSPHRASE,
      dir,
      { inference: null, embedding: { name: "fake", model: "fake-embed" } },
      { DUO_SHARED_USAGE_LOG_PATH: usageLogPath },
    );

    // Records: counted by source, nothing derived.
    expect(knowledge.records.bySource).toEqual({ paste: 2, "slack-export": 2 });
    expect(knowledge.records.total).toBe(4);

    // Last import: the fact recorded by ingest, not a derived timestamp.
    expect(knowledge.lastImport).not.toBeNull();
    expect(knowledge.lastImport?.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Corpus: byte-for-byte the portrait's own verdict, thinness included.
    const portrait = buildInterruptionPortrait(storePath, PASSPHRASE, dir);
    expect(knowledge.corpus.tooThin).toBe(portrait.tooThin);
    expect(knowledge.corpus.minimumQuestionsToCharacterize).toBe(portrait.minimumQuestionsToCharacterize);
    expect(knowledge.corpus.totalQuestions).toBe(portrait.totalQuestions);
    expect(knowledge.corpus.periodStart).toBe(portrait.periodStart);
    expect(knowledge.corpus.periodEnd).toBe(portrait.periodEnd);
    expect(knowledge.corpus.topicBreakdown).toEqual(portrait.topicBreakdown);

    // Rules: counted by review status.
    expect(knowledge.rules.byReviewStatus).toEqual({ pending: 0, approved: 2, rejected: 0, superseded: 0 });

    // Providers: echoed, not resolved.
    expect(knowledge.providers).toEqual({ inference: null, embedding: { name: "fake", model: "fake-embed" } });

    // Usage: the shared report's own shape, gaps included.
    expect(knowledge.sharedUsage.totalQuestions).toBe(3);
    expect(knowledge.sharedUsage.gaps[0]).toMatchObject({ question: "who wins the world cup?", count: 3 });
  });

  it("a thin corpus says so explicitly, exactly like InterruptionPortrait.tooThin", () => {
    const storePath = initStore("thin.db");
    const knowledge = describeDuoKnowledge(storePath, PASSPHRASE, duoDir(), { inference: null, embedding: null }, {});

    expect(knowledge.records.total).toBe(0);
    expect(knowledge.records.bySource).toEqual({});
    expect(knowledge.lastImport).toBeNull();
    expect(knowledge.corpus.tooThin).toBe(true);
    expect(typeof knowledge.corpus.minimumQuestionsToCharacterize).toBe("number");
    expect(knowledge.corpus.topicBreakdown).toEqual([]);
    expect(knowledge.rules.byReviewStatus).toEqual({ pending: 0, approved: 0, rejected: 0, superseded: 0 });
    expect(knowledge.sharedUsage.totalQuestions).toBe(0);
  });
});
