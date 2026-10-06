import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { HEDGE_MARGIN } from "../src/drafting/confidence.js";
import { recordOutcomeAndDeliver } from "../src/drafting/delivery.js";
import {
  appendDraft,
  DraftNotShapeableError,
  getDraft,
  listDrafts,
  readShapePreferences,
  SHAPE_PREFERENCE_MIN_COUNT,
  UnknownAlternativeError,
  undoLatestShape,
} from "../src/drafting/draft-log.js";
import { ALTERNATIVE_INSTRUCTIONS, SHAPE_INSTRUCTION_TEXT } from "../src/drafting/generate.js";
import { draftReply, type DraftAnswer } from "../src/drafting/pipeline.js";
import { shapeDraft, ShapingUnavailableError } from "../src/drafting/shape.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { EmbeddingProvider, InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { upsertRefusal } from "../src/trust/refusals.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const BASE_CONFIDENCE = loadConfig({}).confidence;

const DEFAULT_TEXT = "Five days per quarter, per policy.";
const SHORT_TEXT = "Five days a quarter.";
const CAUTIOUS_TEXT = "I believe it is five days a quarter, but check the policy page to be sure.";
const ANSWER_RECORD_TEXT = "five days per quarter, per the vacation policy";
const RULE_TEXT = "Standard leave is five days per quarter.";

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

async function seedConfirmedRule(storePath: string): Promise<void> {
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: ANSWER_RECORD_TEXT, threadId: "shared" });
  writeRecords(storePath, PASSPHRASE, [question, answer]);
  await embedRecords(storePath, PASSPHRASE, createFakeEmbeddingProvider());
  const { pairs } = await extractQaPairs([question, answer]);
  writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
  withDatabase(storePath, PASSPHRASE, true, (db) => {
    putRule(
      db,
      {
        id: "topic-leave",
        topicId: "topic-leave",
        text: RULE_TEXT,
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

/**
 * A model that answers each instruction differently — the default draft
 * prompt, each ALTERNATIVE_INSTRUCTIONS entry, each shape instruction, and
 * the self-report question — and records every prompt it was given.
 */
function scriptedProvider(overrides: { readonly cautious?: string; readonly shorter?: string; readonly shaped?: string } = {}) {
  const prompts: string[] = [];
  const provider: InferenceProvider = {
    name: "scripted",
    async complete(prompt: string) {
      prompts.push(prompt);
      if (prompt.includes("On a scale of 0 to 100")) {
        return "80";
      }
      if (prompt.includes(ALTERNATIVE_INSTRUCTIONS[0].text)) {
        return overrides.shorter ?? SHORT_TEXT;
      }
      if (prompt.includes(ALTERNATIVE_INSTRUCTIONS[1].text)) {
        return overrides.cautious ?? CAUTIOUS_TEXT;
      }
      if (prompt.includes("The current draft:")) {
        return overrides.shaped ?? "Five days.";
      }
      return DEFAULT_TEXT;
    },
  };
  return { provider, prompts };
}

/** Scores the seeded question once, then returns a config whose threshold sits just under that score — inside the hedged band, by construction rather than by a weight guess that drifts. */
async function hedgedConfig(storePath: string): Promise<typeof BASE_CONFIDENCE> {
  const probe = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), scriptedProvider().provider, BASE_CONFIDENCE);
  if (probe.kind !== "draft") throw new Error("expected the probe to draft");
  return { ...BASE_CONFIDENCE, escalationThreshold: probe.confidence.score - HEDGE_MARGIN / 3 };
}

async function hedgedDraft(storePath: string, provider: InferenceProvider, embeddingProvider: EmbeddingProvider = createFakeEmbeddingProvider()): Promise<DraftAnswer> {
  const config = await hedgedConfig(storePath);
  const result = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, embeddingProvider, provider, config, undefined, undefined, undefined, {
    offerAlternatives: true,
  });
  if (result.kind !== "draft") throw new Error("expected a draft");
  return result;
}

describe("draftReply — a hedged draft offers distinct alternatives (guangshinhaha/duo#257)", () => {
  it("returns three candidates, each from its own instruction, each with its own confidence and the one evidence pool", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const { provider, prompts } = scriptedProvider();

    const result = await hedgedDraft(storePath, provider);

    expect(result.alternatives.map((candidate) => candidate.text)).toEqual([DEFAULT_TEXT, SHORT_TEXT, CAUTIOUS_TEXT]);
    expect(result.alternatives.map((candidate) => candidate.instruction)).toEqual([null, "shorter", "cautious"]);
    expect(result.alternatives[0].confidence).toEqual(result.confidence);
    for (const candidate of result.alternatives) {
      expect(candidate.sources).toEqual(result.sources);
      expect(candidate.confidence.passesThreshold).toBe(true);
    }
    // Distinct instructions, not the same prompt re-run: each alternative
    // prompt carries its own instruction and only its own.
    const shorterPrompts = prompts.filter((p) => p.includes(ALTERNATIVE_INSTRUCTIONS[0].text));
    const cautiousPrompts = prompts.filter((p) => p.includes(ALTERNATIVE_INSTRUCTIONS[1].text));
    expect(shorterPrompts).toHaveLength(1);
    expect(cautiousPrompts).toHaveLength(1);
    expect(shorterPrompts[0]).not.toContain(ALTERNATIVE_INSTRUCTIONS[1].text);
    // Same grounding as the default draft — the standing order and the
    // evidence, never anything new.
    for (const prompt of [...shorterPrompts, ...cautiousPrompts]) {
      expect(prompt).toContain(RULE_TEXT);
      expect(prompt).toContain(ANSWER_RECORD_TEXT);
    }
  });

  it("stores every candidate on the draft row, pending until one is chosen", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await hedgedDraft(storePath, scriptedProvider().provider);

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.draftText).toBe(DEFAULT_TEXT);
    expect(stored?.alternatives.map((candidate) => [candidate.text, candidate.instruction, candidate.outcome])).toEqual([
      [DEFAULT_TEXT, null, null],
      [SHORT_TEXT, "shorter", null],
      [CAUTIOUS_TEXT, "cautious", null],
    ]);
    expect(stored?.chosenAlternative).toBeNull();
  });

  it("a confident draft still produces exactly one", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const { provider, prompts } = scriptedProvider();
    const confident = { ...BASE_CONFIDENCE, escalationThreshold: 0.05 };

    const result = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), provider, confident, undefined, undefined, undefined, {
      offerAlternatives: true,
    });

    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.alternatives).toEqual([]);
    expect(prompts.some((p) => p.includes(ALTERNATIVE_INSTRUCTIONS[0].text))).toBe(false);
    expect(getDraft(storePath, PASSPHRASE, result.draftId)?.alternatives).toEqual([]);
  });

  it("offers none unless the caller asks — every pre-#257 caller drafts exactly as before", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const config = await hedgedConfig(storePath);
    const { provider, prompts } = scriptedProvider();

    const result = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), provider, config);

    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.alternatives).toEqual([]);
    expect(prompts.some((p) => p.includes(ALTERNATIVE_INSTRUCTIONS[0].text))).toBe(false);
  });

  it("drops a candidate that came back the same as one already offered, rather than padding the choice", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await hedgedDraft(storePath, scriptedProvider({ cautious: `  ${DEFAULT_TEXT.toUpperCase()} ` }).provider);

    expect(result.alternatives.map((candidate) => candidate.instruction)).toEqual([null, "shorter"]);
  });

  it("drops a near-duplicate by embedding, and offers no alternatives at all when none is genuinely different", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    // Every candidate embeds to the same vector: reworded, not different.
    const sameEverywhere: EmbeddingProvider = { ...createFakeEmbeddingProvider(), async embed() { return [1, 0, 0]; } };
    const result = await hedgedDraft(storePath, scriptedProvider().provider, sameEverywhere);

    expect(result.alternatives).toEqual([]);
    expect(getDraft(storePath, PASSPHRASE, result.draftId)?.alternatives).toEqual([]);
  });

  it("offers nothing on the extractive fallback — with no model there is nothing to vary", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), undefined, { ...BASE_CONFIDENCE, escalationThreshold: 0.05 }, undefined, undefined, undefined, { offerAlternatives: true });
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.alternatives).toEqual([]);
  });
});

describe("recording which alternative was sent (guangshinhaha/duo#257)", () => {
  it("records the chosen one as the outcome and the others as not chosen — the chosen text becomes the draft's", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await hedgedDraft(storePath, scriptedProvider().provider);

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, result.draftId, "sent", undefined, { alternative: 2 });

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.outcome).toBe("sent");
    expect(stored?.chosenAlternative).toBe(2);
    expect(stored?.draftText).toBe(CAUTIOUS_TEXT);
    expect(stored?.confidenceScore).toBe(result.alternatives[2].confidence.score);
    expect(stored?.alternatives.map((candidate) => candidate.outcome)).toEqual(["not_chosen", "not_chosen", "chosen"]);
  });

  it("an edit of an alternative is diffed against that alternative, not the default", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await hedgedDraft(storePath, scriptedProvider().provider);

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, result.draftId, "edited", "Five days a quarter. Enjoy!", { alternative: 1 });

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.draftText).toBe(SHORT_TEXT);
    expect(stored?.sentText).toBe("Five days a quarter. Enjoy!");
    expect(stored?.alternatives[1].outcome).toBe("chosen");
  });

  it("defaults to the first candidate when none is named", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await hedgedDraft(storePath, scriptedProvider().provider);

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, result.draftId, "sent", undefined);

    expect(getDraft(storePath, PASSPHRASE, result.draftId)?.alternatives.map((candidate) => candidate.outcome)).toEqual(["chosen", "not_chosen", "not_chosen"]);
  });

  it("a dismissal chooses nothing: every candidate reads as not chosen", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const result = await hedgedDraft(storePath, scriptedProvider().provider);

    await recordOutcomeAndDeliver(storePath, PASSPHRASE, result.draftId, "discarded", undefined, { alternative: 1 });

    const stored = getDraft(storePath, PASSPHRASE, result.draftId);
    expect(stored?.chosenAlternative).toBeNull();
    expect(stored?.draftText).toBe(DEFAULT_TEXT);
    expect(stored?.alternatives.map((candidate) => candidate.outcome)).toEqual(["not_chosen", "not_chosen", "not_chosen"]);
  });

  it("refuses an alternative the draft doesn't have, recording nothing", async () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "only one", escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [] });

    await expect(recordOutcomeAndDeliver(storePath, PASSPHRASE, draftId, "sent", undefined, { alternative: 1 })).rejects.toBeInstanceOf(UnknownAlternativeError);
    expect(getDraft(storePath, PASSPHRASE, draftId)?.outcome).toBeNull();
  });

  it("reads a row recorded before alternatives existed as having none", async () => {
    const storePath = initStore();
    const draftId = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "t", escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [] });
    const stored = getDraft(storePath, PASSPHRASE, draftId);
    expect(stored?.alternatives).toEqual([]);
    expect(stored?.chosenAlternative).toBeNull();
    expect(stored?.shapes).toEqual([]);
  });
});

describe("shapeDraft — regenerate with an instruction, keeping the sources (guangshinhaha/duo#258)", () => {
  async function confidentDraft(storePath: string): Promise<DraftAnswer> {
    const result = await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), scriptedProvider().provider, BASE_CONFIDENCE);
    if (result.kind !== "draft") throw new Error("expected a draft");
    return result;
  }

  it("rewrites over the original's own evidence — rebuilt from its sources, never re-retrieved — and leaves the sources untouched", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const draft = await confidentDraft(storePath);
    const { provider, prompts } = scriptedProvider({ shaped: "Five days a quarter." });

    const updated = await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "shorter", 0, provider);

    expect(updated.draftText).toBe("Five days a quarter.");
    expect(updated.sources).toEqual(draft.sources);
    expect(updated.confidenceScore).toBe(draft.confidence.score);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SHAPE_INSTRUCTION_TEXT.shorter);
    expect(prompts[0]).toContain(`The current draft:\n${DEFAULT_TEXT}`);
    expect(prompts[0]).toContain(RULE_TEXT);
    expect(prompts[0]).toContain(ANSWER_RECORD_TEXT);
    expect(prompts[0]).toContain("add none that isn't in it or in the material above");
    expect(updated.shapes).toEqual([expect.objectContaining({ alternative: 0, instruction: "shorter", undoneAt: null })]);
  });

  it("never draws on evidence the original didn't cite", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    // A draft citing only the standing order — the seeded past exchange
    // exists in the store, but this draft never cited it.
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "how much vacation leave do I get",
      threadContext: null,
      draftText: "Five days, per the standing order.",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [{ kind: "rule", id: "topic-leave", label: "standing order: …" }],
      provenance: { origin: "owner" },
    });
    const { provider, prompts } = scriptedProvider();

    await shapeDraft(storePath, PASSPHRASE, duoDir(), draftId, "warmer", 0, provider);

    expect(prompts[0]).toContain(RULE_TEXT);
    expect(prompts[0]).not.toContain(ANSWER_RECORD_TEXT);
    expect(prompts[0]).toContain(SHAPE_INSTRUCTION_TEXT.warmer);
  });

  it("a refusal written after the draft wins: the standing order it cited is no longer grounding for a shape", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const draft = await confidentDraft(storePath);
    upsertRefusal(duoDir(), "topic-leave", "Never speak for me on leave policy.");
    const { provider, prompts } = scriptedProvider();

    await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "shorter", 0, provider);

    expect(prompts[0]).not.toContain(RULE_TEXT);
    expect(prompts[0]).toContain(ANSWER_RECORD_TEXT);
  });

  it("shapes one alternative without touching the others, keeping draftText in step with the first", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const draft = await hedgedDraft(storePath, scriptedProvider().provider);

    const shaped = await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "more_formal", 2, scriptedProvider({ shaped: "Formal cautious." }).provider);
    expect(shaped.alternatives.map((candidate) => candidate.text)).toEqual([DEFAULT_TEXT, SHORT_TEXT, "Formal cautious."]);
    expect(shaped.draftText).toBe(DEFAULT_TEXT);

    const first = await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "more_direct", 0, scriptedProvider({ shaped: "Direct." }).provider);
    expect(first.alternatives[0].text).toBe("Direct.");
    expect(first.draftText).toBe("Direct.");
  });

  it("undo puts the previous version back — one step per tap — and keeps the shape on record as undone", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const draft = await confidentDraft(storePath);
    await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "shorter", 0, scriptedProvider({ shaped: "Short." }).provider);
    await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "warmer", 0, scriptedProvider({ shaped: "Short, warmly." }).provider);

    expect(undoLatestShape(storePath, PASSPHRASE, draft.draftId, 0).draftText).toBe("Short.");
    const back = undoLatestShape(storePath, PASSPHRASE, draft.draftId, 0);
    expect(back.draftText).toBe(DEFAULT_TEXT);
    expect(back.shapes.map((shape) => [shape.instruction, shape.undoneAt !== null])).toEqual([
      ["shorter", true],
      ["warmer", true],
    ]);
    expect(() => undoLatestShape(storePath, PASSPHRASE, draft.draftId, 0)).toThrow(DraftNotShapeableError);
  });

  it("refuses a settled draft, an escalation, and an unknown alternative — before the model is called", async () => {
    const storePath = initStore();
    const sent = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "t", escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [] });
    await recordOutcomeAndDeliver(storePath, PASSPHRASE, sent, "sent", undefined);
    const escalated = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: null, escalated: true, escalationReason: "r", confidenceScore: 0.1, sources: [] });
    const pending = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "t", escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [] });
    const { provider, prompts } = scriptedProvider();

    await expect(shapeDraft(storePath, PASSPHRASE, duoDir(), sent, "shorter", 0, provider)).rejects.toBeInstanceOf(DraftNotShapeableError);
    await expect(shapeDraft(storePath, PASSPHRASE, duoDir(), escalated, "shorter", 0, provider)).rejects.toBeInstanceOf(DraftNotShapeableError);
    await expect(shapeDraft(storePath, PASSPHRASE, duoDir(), pending, "shorter", 3, provider)).rejects.toBeInstanceOf(UnknownAlternativeError);
    expect(prompts).toEqual([]);
  });

  it("refuses a rewrite that came back unchanged, logging nothing — there is no new version to undo from", async () => {
    const storePath = initStore();
    const pending = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "Five days.", escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [] });
    await expect(shapeDraft(storePath, PASSPHRASE, duoDir(), pending, "shorter", 0, scriptedProvider({ shaped: " Five  days. " }).provider)).rejects.toThrow("couldn't make that shorter");
    expect(getDraft(storePath, PASSPHRASE, pending)?.shapes).toEqual([]);
  });

  it("says so plainly when there is no model to shape with", async () => {
    const storePath = initStore();
    const pending = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "t", escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [] });
    await expect(shapeDraft(storePath, PASSPHRASE, duoDir(), pending, "shorter", 0, undefined)).rejects.toBeInstanceOf(ShapingUnavailableError);
  });

  it("lists shapes alongside each draft", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const draft = await confidentDraft(storePath);
    await shapeDraft(storePath, PASSPHRASE, duoDir(), draft.draftId, "shorter", 0, scriptedProvider().provider);

    const listed = listDrafts(storePath, PASSPHRASE, { outcome: "pending" }).find((row) => row.id === draft.draftId);
    expect(listed?.shapes.map((shape) => shape.instruction)).toEqual(["shorter"]);
  });
});

describe("repeated shapes toward one person lean later drafts to them (guangshinhaha/duo#258 AC3)", () => {
  it("a shape used often enough reaches the next draft's prompt; one taken back does not count", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);

    for (let i = 0; i < SHAPE_PREFERENCE_MIN_COUNT; i++) {
      const draftId = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: `t${i}`, escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [], provenance: { origin: "owner" } });
      await shapeDraft(storePath, PASSPHRASE, duoDir(), draftId, "shorter", 0, scriptedProvider({ shaped: `s${i}` }).provider);
      if (i === 0) {
        // One "warmer" that was taken back — never a preference.
        await shapeDraft(storePath, PASSPHRASE, duoDir(), draftId, "warmer", 0, scriptedProvider({ shaped: `w${i}` }).provider);
        undoLatestShape(storePath, PASSPHRASE, draftId, 0);
      }
    }
    expect(readShapePreferences(storePath, PASSPHRASE, "owner")).toEqual(["shorter"]);

    const { provider, prompts } = scriptedProvider();
    await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), provider, BASE_CONFIDENCE);
    const draftPrompt = prompts.find((p) => p.startsWith("You are drafting"));
    expect(draftPrompt).toContain("This person has repeatedly asked for replies like this to be shorter — lean that way.");
    expect(draftPrompt).not.toContain("warmer");
  });

  it("keys by the named recipient (duo#262): shapes on drafts to Wei lean later drafts to Wei, and no one else's", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const wei = { id: "@wei:example", name: "Wei" };
    for (let i = 0; i < SHAPE_PREFERENCE_MIN_COUNT; i++) {
      const draftId = appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: `t${i}`, escalated: false, escalationReason: null, confidenceScore: 0.8, sources: [], provenance: { origin: "owner" }, recipient: wei });
      await shapeDraft(storePath, PASSPHRASE, duoDir(), draftId, "warmer", 0, scriptedProvider({ shaped: `w${i}` }).provider);
    }
    expect(readShapePreferences(storePath, PASSPHRASE, "recipient:@wei:example")).toEqual(["warmer"]);
    expect(readShapePreferences(storePath, PASSPHRASE, "owner")).toEqual([]);

    const toWei = scriptedProvider();
    await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), toWei.provider, BASE_CONFIDENCE, undefined, undefined, wei);
    expect(toWei.prompts.find((p) => p.startsWith("You are drafting"))).toContain("repeatedly asked for replies like this to be warmer");

    const toNobody = scriptedProvider();
    await draftReply(storePath, PASSPHRASE, duoDir(), "how much vacation leave do I get", null, createFakeEmbeddingProvider(), toNobody.provider, BASE_CONFIDENCE);
    expect(toNobody.prompts.find((p) => p.startsWith("You are drafting"))).not.toContain("repeatedly asked");
  });

  it("keys by person: shapes on a channel asker's drafts never lean the owner's own", async () => {
    const storePath = initStore();
    for (let i = 0; i < SHAPE_PREFERENCE_MIN_COUNT; i++) {
      const draftId = appendDraft(storePath, PASSPHRASE, {
        question: "q",
        threadContext: null,
        draftText: `t${i}`,
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.8,
        sources: [],
        provenance: { origin: "channel", channelKind: "matrix", askerRef: "@sam:example", threadId: null, permalink: null },
      });
      await shapeDraft(storePath, PASSPHRASE, duoDir(), draftId, "more_formal", 0, scriptedProvider({ shaped: `f${i}` }).provider);
    }
    expect(readShapePreferences(storePath, PASSPHRASE, "channel:matrix:@sam:example")).toEqual(["more_formal"]);
    expect(readShapePreferences(storePath, PASSPHRASE, "owner")).toEqual([]);
  });
});
