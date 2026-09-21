import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { getDraft } from "../src/drafting/draft-log.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { writeRefusalsFile } from "../src/trust/refusals.js";
import { listGrid } from "../src/trust/grid.js";
import { answerPublicly, PUBLIC_ANSWER_CLEARANCE_CEILING, PUBLIC_PASSED_ON_MESSAGE, PUBLIC_REFUSAL_MESSAGE, type AskerContext } from "../src/permissions/public-answer.js";
import { appendPublicAnswerLogEntry, ensurePublicAnswerLogSchema, getPublicAnswerLogEntry, listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;
const OWNER_NAME = "Dana Cole";

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

function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

/** The CLI-shaped asker context every non-route writer supplies (#160): no link, no lookup. */
function cliAsker(ref: string): AskerContext {
  return { ref, resolved: null, askLinkId: null };
}

/** A confirmed, approved rule on "topic-leave", the corpus's answer publicly markable (or not) via `markPublic`. */
async function seedLeaveTopic(storePath: string, markPublic: boolean): Promise<void> {
  const answerText = "five days per quarter, per the vacation policy";
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: markPublic ? `OFFICIAL (OPEN)\n${answerText}` : answerText, threadId: "shared" });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  const embeddingProvider = createFakeEmbeddingProvider();
  await embedRecords(storePath, PASSPHRASE, embeddingProvider);
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-leave",
        topicId: "topic-leave",
        text: "Standard leave is five days per quarter.",
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
      pairs.map((pair) => pair.id),
    );
  });
}

function writeLeaveTopicFile(dir: string): void {
  writeTopicsFile(dir, [{ id: "topic-leave", label: "Vacation leave", createdAt: new Date().toISOString() }]);
}

describe("answerPublicly — a granted topic is answered directly (#43 AC1)", () => {
  it("answers in thread with its sources, and logs the exchange against the owner", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-1"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");
    expect(outcome.text).toContain("Five days per quarter, per policy.");
    expect(outcome.topicId).toBe("topic-leave");
    expect(outcome.sources.length).toBeGreaterThan(0);

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    // #160: the CLI path records no link and no lookup, and the personal
    // branch's one uniform ceiling.
    expect(logged[0]).toMatchObject({
      outcome: "answered",
      askerRef: "colleague-1",
      topicId: "topic-leave",
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });
  });
});

describe("answerPublicly — an ungranted topic is not answered (#43 AC2)", () => {
  it("keeps the answer private and tells the asker it was passed on, without ever granting T0 first", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    // No grantAutonomy call — "topic-leave" stays at the default "ask".

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-2"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("passed_on");
    if (outcome.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(outcome.message).toContain(PUBLIC_PASSED_ON_MESSAGE);
    expect(outcome.message).not.toMatch(/five days/i);
    expect(outcome.topicId).toBe("topic-leave");

    // The v1 private draft still ran underneath, exactly as it always does.
    const privateDraft = getDraft(storePath, PASSPHRASE, outcome.draftId);
    expect(privateDraft?.draftText).toBe("Five days per quarter, per policy.");
    expect(privateDraft?.escalated).toBe(false);

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0].outcome).toBe("passed_on");
    expect(logged[0].text).toBe(outcome.message);
  });
});

describe("answerPublicly — a refused subject is declined visibly (#43 AC3)", () => {
  it("says plainly it does not speak for the owner, without hinting at the answer, even though the topic is granted", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });
    writeRefusalsFile(dir, [{ heading: "vacation", reason: "Leave policy is under review; don't speak for me on it." }]);

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-3"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("declined_refused");
    if (outcome.kind !== "declined_refused") throw new Error("expected a declined_refused outcome");
    expect(outcome.message).toContain(PUBLIC_REFUSAL_MESSAGE);
    expect(outcome.message).not.toMatch(/five days/i);
    expect(outcome.message).not.toMatch(/under review/i);

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0].outcome).toBe("declined_refused");
  });
});

describe("answerPublicly — low confidence escalates instead of hedging (#43 AC4)", () => {
  it("passes the question on rather than posting a vague-but-defensible public answer", async () => {
    const storePath = initStore();
    const dir = duoDir();

    const question = record({ kind: "question_to_me", author: "other", text: "third floor printer broken, who do I call", threadId: "printer-thread" });
    const answer = record({ text: "OFFICIAL (OPEN)\nIT handles printer hardware issues on that floor", threadId: "printer-thread" });
    writeRecords(storePath, PASSPHRASE, [question, answer]);
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);
    const { pairs } = await extractQaPairs([question, answer]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-printer" })));
    // Deliberately no confirmed rule for this topic — only the weak evidence signal exists.
    writeTopicsFile(dir, [{ id: "topic-printer", label: "Printer support", createdAt: new Date().toISOString() }]);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "printer support", tier: "T0", topicId: "topic-printer" });
    expect(listGrid(storePath, PASSPHRASE, dir).find((row) => row.topicId === "topic-printer")?.level).toBe("auto");

    // Every sample disagrees with the last and embeds to an all-zero vector
    // (no synonym-group word in common) — self-consistency scores 0, and
    // the self-report ask is equally unparseable, defaulting to neutral.
    let calls = 0;
    const disagreeingProvider: InferenceProvider = {
      name: "fake",
      async complete() {
        calls += 1;
        return `alternative reply number ${calls}`;
      },
    };

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "third floor printer broken, who do I call",
      cliAsker("colleague-4"),
      embeddingProvider,
      disagreeingProvider,
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    expect(outcome.kind).toBe("passed_on");
    if (outcome.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(outcome.message).toContain(PUBLIC_PASSED_ON_MESSAGE);
  });
});

describe("answerPublicly — never exposes unmarked ('unknown') material, even to a granted, confident topic", () => {
  it("keeps an unmarked answer private, the same as an ungranted one, because it fails the uniform public clearance ceiling", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, false); // no "OFFICIAL (OPEN)" marking — classification defaults to "unknown"
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-5"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    // The owner's own private `duo draft` would answer this confidently
    // (same corpus as the AC1 test, minus the marking) — but public
    // answering must never expose unmarked material to a wide audience.
    expect(outcome.kind).toBe("passed_on");
    if (outcome.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(outcome.message).not.toMatch(/five days/i);
  });
});

describe("answerPublicly — every public answer is labelled, never as the owner (#44 AC1)", () => {
  it("attributes an actual answer to the owner's duo, states confidence and evidence age, and links each source to its origin", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-6"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );

    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");
    expect(outcome.text).toContain(OWNER_NAME);
    expect(outcome.text).toMatch(/duo/i);
    // Attributed to the duo speaking, not phrased as the owner speaking in the first person.
    expect(outcome.text).not.toMatch(new RegExp(`^I am ${OWNER_NAME}`, "i"));
    expect(outcome.text).toContain(`Confidence: ${outcome.confidence.score.toFixed(2)}`);
    // A rule (the owner's own standing order) and a retrieved past exchange are both named, and told apart.
    expect(outcome.text).toMatch(/owner's own standing order/);
    expect(outcome.text).toMatch(/retrieved past exchange/);

    // The exact same labelled text is what got logged — there is no
    // unlabelled version of this answer anywhere.
    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged[0].text).toBe(outcome.text);
  });

  it("labels a passed-on message and a refusal too, without stating confidence or evidence age for either", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    // Ungranted — passed_on path.
    const passedOn = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-7"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );
    if (passedOn.kind !== "passed_on") throw new Error("expected a passed_on outcome");
    expect(passedOn.message).toContain(OWNER_NAME);
    expect(passedOn.message).not.toMatch(/confidence/i);

    writeRefusalsFile(dir, [{ heading: "vacation", reason: "under review" }]);
    const refused = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-8"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );
    if (refused.kind !== "declined_refused") throw new Error("expected a declined_refused outcome");
    expect(refused.message).toContain(OWNER_NAME);
    expect(refused.message).not.toMatch(/confidence/i);
  });

  it("names a different owner when configured with a different one — attribution is data, not a fixed string", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      cliAsker("colleague-9"),
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      "Priya Nair",
    );
    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");
    expect(outcome.text).toContain("Priya Nair");
    expect(outcome.text).not.toContain(OWNER_NAME);
  });
});

describe("public_answer_log — ask-link asker context (#160)", () => {
  it("stores and reads back the link id, the tri-state resolution, and the ceiling — never a raw secret", () => {
    const storePath = initStore();
    const throughLink = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "how much vacation leave do I get",
      askerRef: "jdoe",
      topicId: "topic-leave",
      outcome: "passed_on",
      text: "passed on",
      draftId: "draft-1",
      askLinkId: "0193c0ff-1000-7000-8000-000000000001",
      askerResolved: true,
      clearanceApplied: "official_open",
    });
    const unresolvedLink = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "where is the offsite",
      askerRef: "unknown.person@example.com",
      topicId: null,
      outcome: "passed_on",
      text: "passed on",
      draftId: "draft-2",
      askLinkId: "0193c0ff-1000-7000-8000-000000000001",
      askerResolved: false,
      clearanceApplied: "official_open",
    });
    const noLink = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "who owns the release train",
      askerRef: "owner",
      topicId: null,
      outcome: "declined_refused",
      text: "refused",
      draftId: "draft-3",
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });

    const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(entries.map((entry) => entry.id)).toEqual([throughLink, unresolvedLink, noLink]);
    expect(entries[0]).toMatchObject({ askLinkId: "0193c0ff-1000-7000-8000-000000000001", askerResolved: true, clearanceApplied: "official_open" });
    expect(entries[1]).toMatchObject({ askLinkId: "0193c0ff-1000-7000-8000-000000000001", askerResolved: false, clearanceApplied: "official_open" });
    expect(entries[2]).toMatchObject({ askLinkId: null, askerResolved: null, clearanceApplied: "official_open" });

    // The full row round-trips by id too, naming only the link's id — the
    // no-raw-secret pin against a genuinely minted token lives at the serve level.
    const single = getPublicAnswerLogEntry(storePath, PASSPHRASE, throughLink);
    expect(single?.askLinkId).toBe("0193c0ff-1000-7000-8000-000000000001");
  });

  it("threads a link's AskerContext through answerPublicly into the logged entry", async () => {
    const storePath = initStore();
    const dir = duoDir();
    await seedLeaveTopic(storePath, true);
    writeLeaveTopicFile(dir);
    grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });

    const outcome = await answerPublicly(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      { ref: "jdoe", resolved: true, askLinkId: "0193c0ff-1000-7000-8000-000000000002" },
      createFakeEmbeddingProvider(),
      agreeingProvider("Five days per quarter, per policy."),
      CONFIDENCE_CONFIG,
      OWNER_NAME,
    );
    if (outcome.kind !== "answered") throw new Error("expected an answered outcome");

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      askerRef: "jdoe",
      askLinkId: "0193c0ff-1000-7000-8000-000000000002",
      askerResolved: true,
      clearanceApplied: "official_open",
    });
  });

  it("migrates a pre-#160 table in place: old rows read null/null/official_open and stay otherwise untouched", () => {
    const storePath = initStore();
    // A log exactly as #45 left it: no ask_link_id, no asker_resolved, no clearance_applied.
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      db.exec(`
        CREATE TABLE public_answer_log (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          question TEXT NOT NULL,
          asker_ref TEXT NOT NULL,
          topic_id TEXT,
          outcome TEXT NOT NULL,
          text TEXT NOT NULL,
          draft_id TEXT NOT NULL,
          corrects_entry_id TEXT
        ) STRICT
      `);
      db.exec(`
        INSERT INTO public_answer_log (id, created_at, question, asker_ref, topic_id, outcome, text, draft_id, corrects_entry_id)
        VALUES ('entry-pre-160', '2026-09-01T00:00:00.000Z', 'old question', 'colleague-0', NULL, 'passed_on', 'passed on', 'draft-pre', NULL)
      `);
    });

    // Any next write drives the additive migration, then succeeds with the new columns.
    const appended = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "new question",
      askerRef: "jdoe",
      topicId: null,
      outcome: "passed_on",
      text: "passed on",
      draftId: "draft-post",
      askLinkId: "0193c0ff-1000-7000-8000-000000000003",
      askerResolved: false,
      clearanceApplied: "official_open",
    });

    const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(entries.map((entry) => entry.id)).toEqual(["entry-pre-160", appended]);
    // The pre-#160 row: not recorded, not fabricated — null link, null lookup,
    // and the ceiling every public answer has always been filtered through.
    expect(entries[0]).toMatchObject({
      question: "old question",
      askerRef: "colleague-0",
      outcome: "passed_on",
      text: "passed on",
      draftId: "draft-pre",
      correctsEntryId: null,
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });
    expect(entries[1]).toMatchObject({ askLinkId: "0193c0ff-1000-7000-8000-000000000003", askerResolved: false, clearanceApplied: "official_open" });
    // The DDL's hardcoded 'official_open' backfill default must stay equal to the
    // TS constant the answer path filters through — this pin, not the comment in
    // public-answer-log.ts, is what fails when the two drift apart.
    expect(entries[0].clearanceApplied).toBe(PUBLIC_ANSWER_CLEARANCE_CEILING);

    // The append-only triggers must abort on a table that actually went through
    // the ALTER migration, not only on one created with the full schema (#160
    // stop condition — the fresh-store variant is covered in its own test below).
    expect(() => {
      withDatabase(storePath, PASSPHRASE, true, (db) => {
        db.exec("UPDATE public_answer_log SET text = 'rewritten' WHERE id = 'entry-pre-160'");
      });
    }).toThrow(/append-only/);
    expect(() => {
      withDatabase(storePath, PASSPHRASE, true, (db) => {
        db.exec("DELETE FROM public_answer_log WHERE id = 'entry-pre-160'");
      });
    }).toThrow(/append-only/);
  });

  it("still refuses UPDATE and DELETE — append-only semantics are unchanged (#160 stop condition)", () => {
    const storePath = initStore();
    const entryId = appendPublicAnswerLogEntry(storePath, PASSPHRASE, {
      question: "q",
      askerRef: "jdoe",
      topicId: null,
      outcome: "passed_on",
      text: "passed on",
      draftId: "draft-1",
      askLinkId: "0193c0ff-1000-7000-8000-000000000004",
      askerResolved: true,
      clearanceApplied: "official_open",
    });

    expect(() => {
      withDatabase(storePath, PASSPHRASE, true, (db) => {
        db.exec(`UPDATE public_answer_log SET text = 'rewritten' WHERE id = '${entryId}'`);
      });
    }).toThrow(/append-only/);
    expect(() => {
      withDatabase(storePath, PASSPHRASE, true, (db) => {
        db.exec(`DELETE FROM public_answer_log WHERE id = '${entryId}'`);
      });
    }).toThrow(/append-only/);

    const entries = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("passed on");
  });

  it("is idempotent: a second ensure pass adds no duplicate columns", () => {
    const storePath = initStore();
    withDatabase(storePath, PASSPHRASE, true, (db) => {
      ensurePublicAnswerLogSchema(db);
      ensurePublicAnswerLogSchema(db);
      const columns = (db.prepare(`PRAGMA table_info(public_answer_log)`).all() as unknown as { name: string }[]).map((row) => row.name);
      expect(columns.filter((name) => name === "ask_link_id")).toHaveLength(1);
      expect(columns.filter((name) => name === "asker_resolved")).toHaveLength(1);
      expect(columns.filter((name) => name === "clearance_applied")).toHaveLength(1);
    });
  });
});
