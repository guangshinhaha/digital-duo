import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { appendDraft, getDraft, recordDraftOutcome, type DraftRecipient } from "../src/drafting/draft-log.js";
import { draftReply } from "../src/drafting/pipeline.js";
import {
  RECIPIENT_ADAPTATION_MIN_SENDS,
  computeRecipientVoiceFeatures,
  describeRecipientVoice,
  deriveRecipientVoice,
  resetRecipientVoice,
} from "../src/drafting/recipient-voice.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const CONFIDENCE_CONFIG = loadConfig({}).confidence;
const QUESTION = "how much vacation leave do I get";

const WEI: DraftRecipient = { id: "@wei:example.org", name: "Wei Tan" };
const DIRECTOR: DraftRecipient = { id: "@director:example.org", name: "Margaret Lim" };

const CASUAL_SENDS = [
  "hey Wei, yep that's fine 👍",
  "hey Wei! gonna check and get back to you",
  "lol no worries, it's sorted",
  "hey Wei, can't make it today, tmr?",
  "haha yep, I'll ping you btw",
  "hey Wei!! thx, that's great",
];
const FORMAL_SENDS = [
  "Dear Ms. Lim,\nPlease find the revised figures attached.\nKind regards",
  "Dear Ms. Lim,\nI would appreciate your approval on the attached proposal.\nKind regards",
  "Dear Ms. Lim,\nThank you for your guidance on this matter.\nKind regards",
  "Dear Ms. Lim,\nI would like to confirm the meeting at your convenience.\nKind regards",
  "Dear Ms. Lim,\nPlease find the minutes of the session below.\nKind regards",
];

function initStore(name = "duo"): string {
  const storePath = join(tempDir(), name, "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function duoDir(name = "duo"): string {
  return join(tempDir(), name, "duo");
}

let counter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  counter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    threadId: `t${counter}`,
    audience: "channel",
    ...overrides,
  });
}

/** Grounds QUESTION in a confirmed, approved rule so the pipeline drafts rather than escalates. */
async function seedConfirmedRule(storePath: string): Promise<void> {
  const question = record({ kind: "question_to_me", author: "other", text: QUESTION, threadId: "shared" });
  const answer = record({ text: "five days per quarter, per the vacation policy", threadId: "shared" });
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

/** Records `texts` as the owner's approved sends to `recipient` — alternating plain sends and edits, both of which count. */
function seedSends(storePath: string, recipient: DraftRecipient, texts: readonly string[]): void {
  texts.forEach((text, index) => {
    const id = appendDraft(storePath, PASSPHRASE, {
      question: `message ${index}`,
      threadContext: null,
      draftText: index % 2 === 0 ? text : "a draft the owner rewrote",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
      recipient,
    });
    if (index % 2 === 0) {
      recordDraftOutcome(storePath, PASSPHRASE, id, "sent");
    } else {
      recordDraftOutcome(storePath, PASSPHRASE, id, "edited", text);
    }
  });
}

/** Agrees with itself (so confidence passes) and keeps every drafting prompt it was given. */
function recordingProvider(): { provider: InferenceProvider; draftPrompts: string[] } {
  const draftPrompts: string[] = [];
  return {
    draftPrompts,
    provider: {
      name: "fake",
      async complete(prompt: string) {
        if (prompt.startsWith("You are drafting")) {
          draftPrompts.push(prompt);
          return "Five days per quarter.";
        }
        return "90";
      },
    },
  };
}

async function draftTo(storePath: string, recipient: DraftRecipient | undefined, dir = duoDir()) {
  const { provider, draftPrompts } = recordingProvider();
  const result = await draftReply(
    storePath,
    PASSPHRASE,
    dir,
    QUESTION,
    null,
    createFakeEmbeddingProvider(),
    provider,
    CONFIDENCE_CONFIG,
    undefined,
    undefined,
    recipient,
  );
  return { result, prompt: draftPrompts[0] ?? "" };
}

/**
 * Seeding a relationship means a dozen real draft-log writes, each a full
 * decrypt/re-encrypt of the store, before a draft is even asked for —
 * comfortably inside vitest's 5s default on an idle machine, not on a busy
 * one. The behaviour under test is unchanged; only the budget is.
 */
const STORE_HEAVY_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("computeRecipientVoiceFeatures — per-relationship style from the owner's own sends", () => {
  it("reads a casual history as casual and a formal one as formal, with the habits each shows", () => {
    const casual = computeRecipientVoiceFeatures(CASUAL_SENDS, WEI.name);
    const formal = computeRecipientVoiceFeatures(FORMAL_SENDS, DIRECTOR.name);

    expect(casual.register).toBe("casual");
    expect(formal.register).toBe("formal");
    expect(formal.formalityScore).toBeGreaterThan(casual.formalityScore);

    expect(casual.habitualGreeting).toBe("hey");
    expect(formal.habitualGreeting).toBe("dear");
    expect(formal.habitualSignOff).toBe("kind regards");
    expect(casual.firstNameRate).toBeGreaterThan(0.5);
    expect(formal.titleRate).toBe(1);
    expect(casual.titleRate).toBe(0);
    expect(casual.emojiRate).toBeGreaterThan(0);
    expect(formal.emojiRate).toBe(0);
    expect(casual.sampleSize).toBe(CASUAL_SENDS.length);
  });
});

describe("draftReply — conditioned on how the owner writes to the recipient (duo#262)", { timeout: STORE_HEAVY_TIMEOUT_MS }, () => {
  it("drafts to two people with different past tone from measurably different prompts, and says it adapted", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    seedSends(storePath, WEI, CASUAL_SENDS);
    seedSends(storePath, DIRECTOR, FORMAL_SENDS);

    const toWei = await draftTo(storePath, WEI);
    const toDirector = await draftTo(storePath, DIRECTOR);

    expect(toWei.prompt).toContain("How the owner writes to Wei Tan specifically");
    expect(toWei.prompt).toContain("Register: casual");
    expect(toWei.prompt).toContain('Usually opens with "hey"');
    expect(toDirector.prompt).toContain("How the owner writes to Margaret Lim specifically");
    expect(toDirector.prompt).toContain("Register: formal");
    expect(toDirector.prompt).toContain('Usually signs off with "kind regards"');
    expect(toWei.prompt).not.toBe(toDirector.prompt);
    // Refines the general voice, never replaces it.
    expect(toWei.prompt).toContain("Voice profile:");

    for (const [{ result }, recipient, register, count] of [
      [toWei, WEI, "casual", CASUAL_SENDS.length],
      [toDirector, DIRECTOR, "formal", FORMAL_SENDS.length],
    ] as const) {
      expect(result.kind).toBe("draft");
      if (result.kind !== "draft") throw new Error("expected a draft");
      expect(result.adaptedForRecipient).toBe(true);
      expect(result.recipientAdaptation).toEqual({ recipientId: recipient.id, recipientName: recipient.name, sampleSize: count, register });
      const stored = getDraft(storePath, PASSPHRASE, result.draftId);
      expect(stored?.adaptedForRecipient).toBe(true);
      expect(stored?.recipient).toEqual(recipient);
    }
  });

  it("below the minimum, drafts in the general voice unchanged and does not claim adaptation", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    seedSends(storePath, WEI, CASUAL_SENDS.slice(0, RECIPIENT_ADAPTATION_MIN_SENDS - 1));

    const toWei = await draftTo(storePath, WEI);
    const toNobody = await draftTo(storePath, undefined);

    expect(toWei.prompt).toBe(toNobody.prompt);
    expect(toWei.prompt).not.toContain("How the owner writes to");
    if (toWei.result.kind !== "draft") throw new Error("expected a draft");
    expect(toWei.result.adaptedForRecipient).toBe(false);
    expect(toWei.result.recipientAdaptation).toBeNull();
    // Still recorded against Wei, so this send can count toward the next draft.
    expect(getDraft(storePath, PASSPHRASE, toWei.result.draftId)?.recipient).toEqual(WEI);
    expect(deriveRecipientVoice(storePath, PASSPHRASE, WEI)).toBeUndefined();
  });

  it("only counts sent and edited drafts — a discarded or never-settled draft teaches nothing", async () => {
    const storePath = initStore();
    seedSends(storePath, WEI, CASUAL_SENDS.slice(0, RECIPIENT_ADAPTATION_MIN_SENDS - 1));
    const discarded = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "hey Wei",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.9,
      sources: [],
      recipient: WEI,
    });
    recordDraftOutcome(storePath, PASSPHRASE, discarded, "discarded");
    appendDraft(storePath, PASSPHRASE, { question: "q", threadContext: null, draftText: "hey Wei", escalated: false, escalationReason: null, confidenceScore: 0.9, sources: [], recipient: WEI });

    expect(describeRecipientVoice(storePath, PASSPHRASE, WEI.id).sampleSize).toBe(RECIPIENT_ADAPTATION_MIN_SENDS - 1);
  });

  it("never claims adaptation for the extractive fallback, which ignores the prompt", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    seedSends(storePath, WEI, CASUAL_SENDS);

    const result = await draftReply(storePath, PASSPHRASE, duoDir(), QUESTION, null, createFakeEmbeddingProvider(), undefined, CONFIDENCE_CONFIG, undefined, undefined, WEI);

    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.adaptedForRecipient).toBe(false);
    expect(result.recipientAdaptation).toBeNull();
  });

  it("reset clears the learned tone: the general voice applies again until enough new sends accumulate", async () => {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    seedSends(storePath, WEI, CASUAL_SENDS);
    const general = (await draftTo(storePath, undefined)).prompt;

    await sleep(5);
    const status = resetRecipientVoice(storePath, PASSPHRASE, WEI.id);
    expect(status.active).toBe(false);
    expect(status.sampleSize).toBe(0);
    expect(status.features).toBeNull();
    expect(status.resetAt).not.toBeNull();

    const afterReset = await draftTo(storePath, WEI);
    expect(afterReset.prompt).toBe(general);
    if (afterReset.result.kind !== "draft") throw new Error("expected a draft");
    expect(afterReset.result.adaptedForRecipient).toBe(false);

    // The draft history itself survives the reset — it is the correction loop's and the eval's too.
    expect(getDraft(storePath, PASSPHRASE, afterReset.result.draftId)).toBeDefined();

    await sleep(5);
    seedSends(storePath, WEI, FORMAL_SENDS);
    const relearned = await draftTo(storePath, WEI);
    expect(relearned.prompt).toContain("Register: formal");
    expect(relearned.prompt).not.toContain("Register: casual");
  });

  it("keeps each duo's relationships in its own store — one duo's sends never tune another's drafts", async () => {
    const storeA = initStore("a");
    const storeB = initStore("b");
    await seedConfirmedRule(storeA);
    await seedConfirmedRule(storeB);
    seedSends(storeA, WEI, CASUAL_SENDS);

    const fromB = await draftTo(storeB, WEI, duoDir("b"));
    if (fromB.result.kind !== "draft") throw new Error("expected a draft");
    expect(fromB.result.adaptedForRecipient).toBe(false);
    expect(fromB.prompt).not.toContain("How the owner writes to");

    resetRecipientVoice(storeB, PASSPHRASE, WEI.id);
    expect(describeRecipientVoice(storeA, PASSPHRASE, WEI.id).active).toBe(true);
  });
});

describe("HTTP — POST /drafts recipient, and /people/:id/voice-adaptation", { timeout: STORE_HEAVY_TIMEOUT_MS }, () => {
  async function setup() {
    const storePath = initStore();
    await seedConfirmedRule(storePath);
    const config = loadConfig();
    const { provider } = recordingProvider();
    const deps: ServeDeps = {
      storePath,
      passphrase: PASSPHRASE,
      duoDir: duoDir(),
      lifecycleLogPath: join(tempDir(), "lifecycle-runtime", "events.json"),
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: provider,
      confidenceConfig: config.confidence,
      classificationCeiling: config.classificationCeiling,
      ownerName: "Owner",
      env: {},
    };
    const device = createDeviceToken(storePath, PASSPHRASE, "laptop");
    return { app: createServer(deps), auth: { authorization: `Bearer ${device.token}` }, storePath };
  }

  it("carries the adaptation flag on the draft response and the stored draft once there is enough history", async () => {
    const { app, auth, storePath } = await setup();
    seedSends(storePath, WEI, CASUAL_SENDS);

    const response = await app.inject({ method: "POST", url: "/drafts", headers: auth, payload: { question: QUESTION, recipient: WEI } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.adaptedForRecipient).toBe(true);
    expect(body.recipientAdaptation).toMatchObject({ recipientId: WEI.id, recipientName: "Wei Tan", register: "casual" });

    const stored = await app.inject({ method: "GET", url: `/drafts/${body.draftId}`, headers: auth });
    expect(stored.json()).toMatchObject({ adaptedForRecipient: true, recipient: WEI });
  });

  it("answers adaptedForRecipient false for a draft with no recipient", async () => {
    const { app, auth } = await setup();
    const response = await app.inject({ method: "POST", url: "/drafts", headers: auth, payload: { question: QUESTION } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ adaptedForRecipient: false, recipientAdaptation: null });
  });

  it("refuses a malformed recipient with a 400", async () => {
    const { app, auth } = await setup();
    for (const recipient of ["wei", { name: "Wei" }, { id: "" }, { id: "x", name: 3 }]) {
      const response = await app.inject({ method: "POST", url: "/drafts", headers: auth, payload: { question: QUESTION, recipient } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("bad_request");
    }
  });

  it("reports and resets one person's learned tone", async () => {
    const { app, auth, storePath } = await setup();
    seedSends(storePath, WEI, CASUAL_SENDS);
    const url = `/people/${encodeURIComponent(WEI.id)}/voice-adaptation`;

    const before = await app.inject({ method: "GET", url, headers: auth });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ recipientId: WEI.id, recipientName: "Wei Tan", active: true, sampleSize: CASUAL_SENDS.length, threshold: RECIPIENT_ADAPTATION_MIN_SENDS, resetAt: null });
    expect(before.json().features.register).toBe("casual");

    await sleep(5);
    const reset = await app.inject({ method: "DELETE", url, headers: auth });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ active: false, sampleSize: 0, features: null });

    const draft = await app.inject({ method: "POST", url: "/drafts", headers: auth, payload: { question: QUESTION, recipient: WEI } });
    expect(draft.json().adaptedForRecipient).toBe(false);
  });

  it("requires the owner's device token", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "DELETE", url: `/people/${encodeURIComponent(WEI.id)}/voice-adaptation` });
    expect(response.statusCode).toBe(401);
  });
});
