import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { getDraft, listDrafts } from "../src/drafting/draft-log.js";
import { draftReply } from "../src/drafting/pipeline.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { createPinnedAnswer } from "../src/trust/pinned-answers.js";
import type { WorkspaceGroundedAttachment } from "../src/workspace/transport.js";

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

/** Always returns the same completion — a deterministic stand-in for a well-agreeing model, so self-consistency scores 1. */
function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

async function seedConfirmedRule(storePath: string, options: { answerText?: string; ruleText?: string } = {}): Promise<void> {
  const answerText = options.answerText ?? "five days per quarter, per the vacation policy";
  const ruleText = options.ruleText ?? "Standard leave is five days per quarter.";
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: answerText, threadId: "shared" });
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
      pairs.map((pair) => pair.id),
    );
  });
}

describe("draftReply — a question produces a draft with sources (#32 AC1)", () => {
  it("returns a draft with the standing order and past exchange listed as sources, and confidence high enough to pass", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();
    const inferenceProvider = agreeingProvider("Five days per quarter, per policy.");

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toBe("Five days per quarter, per policy.");
    expect(result.sources.some((source) => source.kind === "rule")).toBe(true);
    expect(result.sources.some((source) => source.kind === "evidence")).toBe(true);
    expect(result.confidence.passesThreshold).toBe(true);

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.draftText).toBe(result.text);
    expect(stored?.escalated).toBe(false);
  });

  it("works with no provider configured, using the extractive fallback", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toBe("Standard leave is five days per quarter.");
  });
});

describe("draftReply — the no-provider extractive fallback never echoes a raw classification marking (#155)", () => {
  // Same convention answer.test.ts's own no-provider fallback test uses: a
  // marked record whose marking is a bare first line, so stripMarkingLine's
  // unambiguous case is the one under test.
  const MARKED_ANSWER_TEXT = "OFFICIAL (OPEN)\nfive days per quarter, per the vacation policy";

  it("echoes a marked evidence record's text without its raw marking line — the same strip answerForAsker's fallback already did (#50)", async () => {
    const storePath = initStore();
    // Three marked answers and no rule: enough retrieval strength (3 = the
    // strong-evidence bar) to clear the escalation threshold with no rule
    // hit, so the draft that comes back is extractiveDraft(evidence[0]).
    writeRecords(
      storePath,
      PASSPHRASE,
      [record({ text: MARKED_ANSWER_TEXT }), record({ text: MARKED_ANSWER_TEXT }), record({ text: MARKED_ANSWER_TEXT })],
    );
    const embeddingProvider = createFakeEmbeddingProvider();
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toContain("five days per quarter, per the vacation policy");
    expect(result.text).not.toContain("OFFICIAL (OPEN)");
    // The whole result object, not just its body: source labels quote the same
    // record text, and public answering posts them (renderSourceAttribution).
    expect(result.sources.some((source) => source.label.includes("five days per quarter"))).toBe(true);
    expect(result.sources.some((source) => source.label.includes("OFFICIAL (OPEN)"))).toBe(false);
  });

  it("echoes a rule hit's text without its raw marking line — the no-provider default rule text is a marked answer copied verbatim", async () => {
    const storePath = initStore();
    // ruleText === answerText is exactly what runRuleInduction +
    // defaultRuleText store when no inference provider is configured: the
    // most central answer's text, verbatim — marking line included.
    await seedConfirmedRule(storePath, { answerText: MARKED_ANSWER_TEXT, ruleText: MARKED_ANSWER_TEXT });

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toContain("five days per quarter, per the vacation policy");
    expect(result.text).not.toContain("OFFICIAL (OPEN)");
    // The rule's own source label quotes the same marked rule text.
    expect(result.sources.some((source) => source.label.includes("five days per quarter"))).toBe(true);
    expect(result.sources.some((source) => source.label.includes("OFFICIAL (OPEN)"))).toBe(false);
  });
});

describe("draftReply — an unanswerable question escalates instead of guessing (#32 AC2)", () => {
  it("escalates, with an explanation, when there is no supporting evidence at all", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is the meaning of life",
      null,
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    if (result.kind !== "escalation") throw new Error("expected an escalation");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).not.toMatch(/five days/i);

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.draftText).toBeNull();
    expect(stored?.escalated).toBe(true);
  });

  it("escalates on thin evidence even when a provider is configured, rather than drafting a confident-sounding guess", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();
    // A weak, unrelated single match: writes one record whose embedding
    // shares no synonym group with the question, so retrieval strength
    // and self-consistency alone can't clear the escalation threshold.
    const unrelated = record({ text: "the printer on the third floor is broken, hardware issue" });
    writeRecords(storePath, PASSPHRASE, [unrelated]);
    await embedRecords(storePath, PASSPHRASE, embeddingProvider);

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is my end of year bonus",
      null,
      embeddingProvider,
      agreeingProvider("I don't know."),
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
  });

  it("never calls the inference provider at all when there is zero grounding, even with one configured", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();
    let calls = 0;
    const countingProvider = { name: "fake", async complete() { calls += 1; return "should never run"; } };

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is the meaning of life",
      null,
      embeddingProvider,
      countingProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    expect(calls).toBe(0);
  });
});

describe("draftReply — every call writes exactly one draft-log row", () => {
  it("logs both the draft and escalation cases", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();

    await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, embeddingProvider, undefined, CONFIDENCE_CONFIG);
    await draftReply(storePath, PASSPHRASE, duoDir(), "what is the meaning of life", null, embeddingProvider, undefined, CONFIDENCE_CONFIG);

    expect(listDrafts(storePath, PASSPHRASE)).toHaveLength(2);
  });

  it("persists refused: false and the configured threshold on a successful (non-escalated) draft", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, embeddingProvider, undefined, CONFIDENCE_CONFIG);
    expect(result.kind).toBe("draft");
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.refused).toBe(false);
    expect(stored?.escalationThreshold).toBe(CONFIDENCE_CONFIG.escalationThreshold);
  });

  it("persists refused: false and the configured threshold on a no-evidence escalation", async () => {
    const storePath = initStore();
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(storePath, PASSPHRASE, duoDir(), "what is the meaning of life", null, embeddingProvider, undefined, CONFIDENCE_CONFIG);
    expect(result.kind).toBe("escalation");
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.refused).toBe(false);
    expect(stored?.escalationThreshold).toBe(CONFIDENCE_CONFIG.escalationThreshold);
  });
});

describe("draftReply — a thread of context can be supplied (#32 AC4)", () => {
  it("accounts for piped-in thread context rather than answering the last line alone", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const embeddingProvider = createFakeEmbeddingProvider();
    const seenPrompts: string[] = [];
    const capturingProvider: InferenceProvider = {
      name: "fake",
      async complete(prompt: string) {
        seenPrompts.push(prompt);
        return "Five days.";
      },
    };

    await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "is the vacation policy the same for everyone?",
      "Alice: how much vacation leave do I get\nMe: it depends on tenure",
      embeddingProvider,
      capturingProvider,
      CONFIDENCE_CONFIG,
    );

    // The self-consistency samples are the draft prompt itself; a later
    // self-report call asks a different question and wouldn't carry the
    // thread context, so this checks every prompt the provider actually saw.
    expect(seenPrompts.some((prompt) => prompt.includes("it depends on tenure"))).toBe(true);
  });
});

describe("draftReply — a refused subject escalates without reasoning about it (#34 AC2)", () => {
  // duo/refusals.md's one real format (../src/trust/refusals.ts, #53/#29):
  // "## <subject>" headings with a reason body.
  function writeRefusalsFile(dir: string, subjects: string[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "refusals.md"), subjects.map((s) => `## ${s}\n\nreason\n`).join("\n"), "utf8");
  }

  it("escalates citing the refusal, even though a confirmed rule would otherwise answer it", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath); // topic "vacation leave" — squarely on-topic if this question weren't refused
    const dir = duoDir();
    writeRefusalsFile(dir, ["vacation"]);
    const embeddingProvider = createFakeEmbeddingProvider();

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    if (result.kind !== "escalation") throw new Error("expected an escalation");
    expect(result.refused).toBe(true);
    expect(result.reason).toContain("vacation");
    expect(result.reason).toContain("duo/refusals.md");

    // Persisted, not just returned — a client reading it back later (e.g.
    // duo serve's GET /drafts) must be able to tell "won't" from "can't"
    // without parsing escalationReason's text (client-tech-design.md's own
    // rationale for why this is a stored field, not a client-side guess).
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.refused).toBe(true);
    expect(stored?.escalationThreshold).toBe(CONFIDENCE_CONFIG.escalationThreshold);
  });

  it("never calls retrieval or the inference provider at all for a refused question", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const dir = duoDir();
    writeRefusalsFile(dir, ["vacation"]);
    let calls = 0;
    const countingProvider = { name: "fake", async complete() { calls += 1; return "should never run"; } };

    await draftReply(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      null,
      createFakeEmbeddingProvider(),
      countingProvider,
      CONFIDENCE_CONFIG,
    );

    expect(calls).toBe(0);
  });

  it("still writes exactly one (escalated) draft-log row for a refused question", async () => {
    const storePath = initStore();
    const dir = duoDir();
    writeRefusalsFile(dir, ["salary"]);

    const result = await draftReply(storePath, PASSPHRASE, dir, "what is my salary", null, createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG);
    if (result.kind !== "escalation") throw new Error("expected an escalation");
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.escalated).toBe(true);
    expect(stored?.draftText).toBeNull();
  });

  it("marks a non-refused escalation (thin evidence) as refused: false", async () => {
    const storePath = initStore();
    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is the meaning of life",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );
    if (result.kind !== "escalation") throw new Error("expected an escalation");
    expect(result.refused).toBe(false);
  });
});

describe("draftReply — a pinned answer wins outright, before any standing order or retrieval (duo#275)", () => {
  it("quotes the pinned wording verbatim even though a confirmed rule and strong evidence would otherwise answer differently", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath, { answerText: "five days per quarter, per the vacation policy" });
    createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Exactly ten days a year, no exceptions.");
    const embeddingProvider = createFakeEmbeddingProvider();
    const inferenceProvider = agreeingProvider("this should never be used");

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      embeddingProvider,
      inferenceProvider,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toBe("Exactly ten days a year, no exceptions.");
    expect(result.confidence.passesThreshold).toBe(true);
    expect(result.sources).toEqual([{ kind: "pinned", id: expect.any(String), label: expect.stringContaining("pinned answer") }]);
  });

  it("never calls the inference provider or retrieval for a pinned question", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Ten days a year.");
    let calls = 0;
    const countingProvider = { name: "fake", async complete() { calls += 1; return "should never run"; } };

    await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      createFakeEmbeddingProvider(),
      countingProvider,
      CONFIDENCE_CONFIG,
    );

    expect(calls).toBe(0);
  });

  it("persists the draft (not an escalation), citing the pinned answer as its one source", async () => {
    const storePath = initStore();
    const pinned = createPinnedAnswer(storePath, PASSPHRASE, "parking policy", "Visitor parking is on level 2.");

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what's the parking policy here",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.escalated).toBe(false);
    expect(stored?.draftText).toBe("Visitor parking is on level 2.");
    expect(stored?.sources).toEqual([{ kind: "pinned", id: pinned.id, label: expect.stringContaining("parking policy") }]);
  });

  it("leaves an unrelated question to fall through to the ordinary pipeline", async () => {
    const storePath = initStore();
    createPinnedAnswer(storePath, PASSPHRASE, "parking policy", "Visitor parking is on level 2.");

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "what is the meaning of life",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
  });

  it("a refusal still wins over a pinned answer — checked first, same as it already outranks a standing order", async () => {
    const storePath = initStore();
    const dir = duoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "refusals.md"), "## vacation\n\nreason\n", "utf8");
    createPinnedAnswer(storePath, PASSPHRASE, "vacation leave", "Ten days a year.");

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      dir,
      "how much vacation leave do I get",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
    );

    expect(result.kind).toBe("escalation");
    if (result.kind !== "escalation") throw new Error("expected an escalation");
    expect(result.refused).toBe(true);
  });
});

describe("draftReply — attachments ground the one draft without touching the corpus (#190, attachments.md §3)", () => {
  function attachment(text: string): WorkspaceGroundedAttachment {
    // What the door hands the pipeline: already decoded, already
    // marking-stripped at the boundary. The pipeline trusts both.
    return { reference: "mxc://workspace/f1", name: "notes.txt", mimeType: "text/plain", text };
  }

  it("counts for the no-evidence gate — a fresh store with an attachment is NOT the groundless escalation", async () => {
    const storePath = initStore(); // no records, no rules
    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "when do we launch?",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
      undefined,
      [attachment("the launch date is March 3rd")],
    );
    if (result.kind !== "escalation") throw new Error("expected a confidence escalation, not a draft");
    // The gate passed (the reason is a scored confidence escalation, not
    // noEvidenceEscalationReason's "no standing order or past exchange … at
    // all"), and the source row the escalation cites is the attachment.
    expect(result.reason).toContain("below the");
    expect(result.reason).not.toContain("at all. Answering it yourself");
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.sources).toEqual([
      { kind: "attachment", id: "mxc://workspace/f1", label: expect.stringContaining("notes.txt (text/plain)") },
    ]);
  });

  it("contributes nothing to confidence: the fresh-store attachment scores exactly the empty-corpus 0.425, under the 0.55 threshold", async () => {
    const storePath = initStore();
    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "when do we launch?",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
      undefined,
      [attachment("the launch date is March 3rd")],
    );
    if (result.kind !== "escalation" || result.confidence === undefined) throw new Error("expected a scored escalation");
    // 0.3 (selfConsistency, single deterministic sample) + 0.1 (recency,
    // neutral at no evidence) + 0.05×0.5 (selfReport, neutral at no
    // provider) — retrievalStrength and ruleHit stay corpus-honest at 0,
    // which is the whole test: provided material is kin to a rule hit for
    // the gate but contributes nothing to the signals.
    expect(result.confidence.score).toBeCloseTo(0.425, 10);
    expect(result.confidence.signals.retrievalStrength).toBe(0);
    expect(result.confidence.signals.ruleHit).toBe(0);
  });

  it("drafts when a rule also hit — and the source order is rule, attachment, evidence, with the label carrying name/type/preview only", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
      undefined,
      [attachment("also, the launch date is March 3rd")],
    );
    if (result.kind !== "draft") throw new Error(`expected a draft, got ${result.kind}`);
    // seedConfirmedRule's fixture retrieves two evidence records (the Q and
    // the A of the seeded pair) — the order under test is where the
    // attachment sits: after the rule, ahead of evidence.
    expect(result.sources.map((source) => source.kind)).toEqual(["rule", "attachment", "evidence", "evidence"]);
    const attachmentSource = result.sources.find((source) => source.kind === "attachment")!;
    expect(attachmentSource.id).toBe("mxc://workspace/f1");
    expect(attachmentSource.label).toContain("attachment notes.txt (text/plain)");
    // The label's preview is the door-stripped text and nothing more — no
    // second copy of the body rides the row.
    expect(attachmentSource.label).toBe(`attachment notes.txt (text/plain): also, the launch date is March 3rd`);
  });

  it("never persists the attachment on threadContext — the one draft-row field that IS retained stays null", async () => {
    const storePath = initStore();
    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "when do we launch?",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      CONFIDENCE_CONFIG,
      undefined,
      [attachment("the launch date is March 3rd")],
    );
    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.threadContext).toBeNull();
    // The extractive fallback's sanctioned verbatim quote is the draft text
    // (§3: "can quote an attachment verbatim"); the row's other fields carry
    // no copy of the body.
    expect(stored?.sources).toHaveLength(1);
    expect(Object.keys(stored?.sources[0] ?? {}).sort()).toEqual(["id", "kind", "label"]);
  });

  it("the provider path's prompt carries the attachment ahead of the question — and no other call does", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const seenPrompts: string[] = [];
    const capturingProvider: InferenceProvider = {
      name: "fake",
      async complete(prompt: string) {
        seenPrompts.push(prompt);
        return "Five days.";
      },
    };
    const result = await draftReply(
      storePath,
      PASSPHRASE,
      duoDir(),
      "how much vacation leave do I get",
      null,
      createFakeEmbeddingProvider(),
      capturingProvider,
      CONFIDENCE_CONFIG,
      undefined,
      [attachment("the launch date is March 3rd")],
    );
    if (result.kind !== "draft") throw new Error(`expected a draft, got ${result.kind}`);
    expect(
      seenPrompts.some(
        (prompt) =>
          prompt.includes("Material the asker attached to this question") &&
          prompt.includes("--- notes.txt (text/plain) ---") &&
          prompt.includes("the launch date is March 3rd") &&
          prompt.includes("Question: how much vacation leave do I get"),
      ),
    ).toBe(true);
  });
});
