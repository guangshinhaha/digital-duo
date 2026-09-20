import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { appendDraft, recordDraftOutcome } from "../src/drafting/draft-log.js";
import type { ChannelAdapter, ChannelDeliveryRequest } from "../src/drafting/delivery.js";
import { writeRuleByHand } from "../src/derivation/rule-review.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import { queueCorrectionCandidate } from "../src/corrections/queue.js";
import { queueStandingOrderCandidate } from "../src/drafting/standing-order-candidates.js";
import { applyCorrection } from "../src/trust/demotion.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { writeRefusalsFile } from "../src/trust/refusals.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createAskToken, createDeviceToken, revokeAskToken } from "../src/serve/tokens.js";
import { loadUsageLog } from "../src/shared-duo/usage-log.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function deps(storePath: string, overrides: Partial<ServeDeps> = {}): ServeDeps {
  const config = loadConfig();
  return {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    ownerName: config.ownerName,
    // Isolated from the real environment: this repo's own checked-in
    // shared-duo/persona.json is a real file at the default relative
    // path, and `env: process.env` here would otherwise leak it into
    // these tests via listAvailableDuos's default path resolution. The
    // usage log is isolated for the same reason — a stray default-path
    // entry would make the /ask usage-log assertions read real files.
    env: {
      DUO_SHARED_PERSONA_PATH: join(tempDir(), "shared-duo", "persona.json"),
      DUO_SHARED_USAGE_LOG_PATH: join(tempDir(), "shared-duo-runtime", "usage.json"),
    },
    ...overrides,
  };
}

/** An inference provider whose every completion returns the same fixed text — public-answer.test.ts's agreeingProvider, for the answered-outcome fixture chain. */
function agreeingProvider(response: string): InferenceProvider {
  return { name: "fake", async complete() { return response; } };
}

/** The slice of an inject() response the /ask assertions read — written once for every ask-shaped helper below. */
type AskResponse = { statusCode: number; body: string; json(): any };

/**
 * shared-cli.test.ts's persona fixture, written to the exact path deps()
 * points DUO_SHARED_PERSONA_PATH at. Malformed variants (a 404 test) are
 * written by the tests themselves, on top of this helper's directory.
 */
function writeSharedPersona(overrides: Record<string, unknown> = {}): string {
  const dir = join(tempDir(), "shared-duo");
  const path = join(dir, "persona.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      id: "shared-duo",
      owner: { kind: "person", id: "dana-cole", name: "Dana Cole" },
      persona: { voice: "plain, procedural" },
      standingOrders: ["answer only from the configured documents"],
      refusals: ["does not decide anything on the team's behalf"],
      knowledge: {
        kind: "authored",
        documents: ["Leave requests (updated 2026-06-01): submit through the HR portal at least 5 working days in advance."],
      },
      ...overrides,
    }),
  );
  return path;
}

let recordCounter = 0;
function record(overrides: Partial<RecordInput> & { text: string }) {
  recordCounter += 1;
  return createRecord({
    source: "test",
    sourceRef: null,
    kind: "my_answer",
    author: "me",
    timestamp: `2026-01-01T00:00:${String(recordCounter).padStart(2, "0")}.000Z`,
    threadId: `t${recordCounter}`,
    audience: "channel",
    ...overrides,
  });
}

/**
 * The full fixture chain answerPublicly's answered outcome needs
 * (public-answer.test.ts:47-107's seedLeaveTopic, kept in one place so
 * several /ask tests can share it): a publicly-markable Q/A pair, embedded
 * retrieval, a confirmed approved rule, the topics file, and — unless
 * `demote` — a T0 autonomy grant.
 */
async function seedAnsweredTopic(storePath: string, options: { demote?: boolean } = {}): Promise<void> {
  const dir = join(tempDir(), "duo");
  const question = record({ kind: "question_to_me", author: "other", text: "how much vacation leave do I get", threadId: "shared" });
  const answer = record({ text: `OFFICIAL (OPEN)\nfive days per quarter, per the vacation policy`, threadId: "shared" });
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
  writeTopicsFile(dir, [{ id: "topic-leave", label: "Vacation leave", createdAt: new Date().toISOString() }]);
  grantAutonomy(storePath, PASSPHRASE, dir, { scopeText: "vacation leave", tier: "T0", topicId: "topic-leave" });
  if (options.demote) {
    // One correction drops the T0 cell to "approve" with a one-time
    // demotion notice pending — the only fixture shape answerPublicly's
    // ownerNotice field can ever come from (#55 AC2).
    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-leave", tier: "T0", correctionRef: "test-correction" });
  }
}

describe("createServer — auth (client-tech-design.md Part 2)", () => {
  let app: FastifyInstance;
  let storePath: string;

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
  });

  it("rejects a request with no bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/duos" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("rejects an unknown token", async () => {
    const response = await app.inject({ method: "GET", url: "/duos", headers: { authorization: "Bearer not-a-real-token" } });
    expect(response.statusCode).toBe(401);
  });

  it("accepts a request bearing a token minted by duo pair", async () => {
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const response = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${paired.token}` } });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a token after it has been revoked", async () => {
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const { revokeDeviceToken } = await import("../src/serve/tokens.js");
    revokeDeviceToken(storePath, PASSPHRASE, paired.id);

    const response = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${paired.token}` } });
    expect(response.statusCode).toBe(401);
  });

  it("/health needs no token", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("a token verified once is briefly trusted without re-checking the store, even after revocation — the documented, bounded staleness window that avoids a full store decrypt on every request", async () => {
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const first = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${paired.token}` } });
    expect(first.statusCode).toBe(200);

    const { revokeDeviceToken } = await import("../src/serve/tokens.js");
    revokeDeviceToken(storePath, PASSPHRASE, paired.id);

    const second = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${paired.token}` } });
    expect(second.statusCode).toBe(200);
  });

  it("rate-limits auth failures after exactly RATE_LIMIT_MAX_FAILURES (10), not one more", async () => {
    const responses = [];
    for (let i = 0; i < 12; i += 1) {
      responses.push(await app.inject({ method: "GET", url: "/duos", headers: { authorization: "Bearer not-a-real-token" } }));
    }
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("a rate-limited response uses the rate_limited error code, not unauthorized", async () => {
    for (let i = 0; i < 10; i += 1) {
      await app.inject({ method: "GET", url: "/duos", headers: { authorization: "Bearer not-a-real-token" } });
    }
    const response = await app.inject({ method: "GET", url: "/duos", headers: { authorization: "Bearer not-a-real-token" } });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  // Issue #158: ask tokens are refused by table separation — the hook only
  // looks in device_tokens, so an ask token is refused byte-identically to an
  // unknown device token on every owner route, whatever its own state.
  // Issue #159 pins the FULL owner-route inventory (every method), not just
  // the GETs: the four POSTs are owner-only surfaces too, and a seam bug
  // that only leaked on POSTs would otherwise pass unnoticed.
  interface OwnerRoute {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly payload?: unknown;
  }
  const ownerRoutes: readonly OwnerRoute[] = [
    { method: "GET", url: "/duos" },
    { method: "GET", url: "/drafts" },
    { method: "GET", url: "/drafts/some-draft-id" },
    { method: "GET", url: "/review" },
    { method: "GET", url: "/mirror/portrait" },
    { method: "GET", url: "/mirror/rules" },
    { method: "GET", url: "/mirror/rules/some-rule-id" },
    { method: "GET", url: "/trust/grid" },
    { method: "GET", url: "/audit" },
    { method: "POST", url: "/drafts", payload: { question: "q" } },
    { method: "POST", url: "/drafts/some-draft-id/outcome", payload: { outcome: "sent" } },
    { method: "POST", url: "/drafts/some-draft-id/answer", payload: { answer: "a" } },
    { method: "POST", url: "/mirror/rules/some-rule-id/approve" },
  ];

  async function expectRefusedOnAllOwnerRoutes(token: string): Promise<void> {
    // Each request comes from its own IP: 13 refused requests from one IP
    // would cross the per-IP 10-failure rate-limit cap mid-loop and turn
    // the tail of the inventory into 429s — a different (also correct)
    // behavior than the byte-identical 401 this helper exists to pin.
    const invalid = await app.inject({ method: "GET", url: "/duos", headers: { authorization: "Bearer not-a-real-token" }, remoteAddress: "10.0.0.250" });
    // Concurrent injects are safe here: every store call the hook makes is
    // fully synchronous (KTD6), so no two requests can interleave
    // mid-verification — and 13 sequential cache-miss verifies would each
    // pay a full store decrypt for no behavioral reason.
    await Promise.all(
      ownerRoutes.map(async (route, i) => {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: `Bearer ${token}` },
          ...(route.method === "POST" ? { payload: route.payload ?? {} } : {}),
          remoteAddress: `10.0.0.${i + 1}`,
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
        // The hook rejects before routing, so the refusal body is
        // route-independent and identical to an invalid device token's.
        expect(response.body, `${route.method} ${route.url}`).toBe(invalid.body);
      }),
    );
  }

  it("refuses a fresh, valid ask token on every owner route exactly as it refuses an invalid device token", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    await expectRefusedOnAllOwnerRoutes(minted.token);
  });

  it("refuses an expired ask token the same way — nothing renews it", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    await expectRefusedOnAllOwnerRoutes(minted.token);
  });

  it("refuses a revoked ask token the same way", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    revokeAskToken(storePath, PASSPHRASE, minted.id);
    await expectRefusedOnAllOwnerRoutes(minted.token);
  });
});

describe("createServer — routes", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("GET /duos lists the personal duo when no shared duo is configured", async () => {
    const response = await app.inject({ method: "GET", url: "/duos", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ kind: "personal" }]);
  });

  it("GET /drafts is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/drafts", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("GET /drafts?outcome=pending filters out dispositioned drafts", async () => {
    const pending = appendDraft(storePath, PASSPHRASE, {
      question: "still pending",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    const dispositioned = appendDraft(storePath, PASSPHRASE, {
      question: "handled",
      threadContext: null,
      draftText: "b",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.7,
      sources: [],
    });
    recordDraftOutcome(storePath, PASSPHRASE, dispositioned, "sent", undefined);

    const response = await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((d: { id: string }) => d.id)).toEqual([pending]);
  });

  it("GET /drafts rejects an invalid outcome filter with 400", async () => {
    const response = await app.inject({ method: "GET", url: "/drafts?outcome=not-real", headers: authHeader });
    expect(response.statusCode).toBe(400);
  });

  it("GET /drafts rejects a non-numeric limit with 400 rather than crashing on a NaN SQL bind", async () => {
    const response = await app.inject({ method: "GET", url: "/drafts?limit=abc", headers: authHeader });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("limit");
  });

  it("GET /drafts rejects a limit with trailing garbage (parseInt would otherwise silently truncate it)", async () => {
    const response = await app.inject({ method: "GET", url: "/drafts?limit=5abc", headers: authHeader });
    expect(response.statusCode).toBe(400);
  });

  it("GET /drafts accepts a valid numeric limit", async () => {
    for (let i = 0; i < 3; i += 1) {
      appendDraft(storePath, PASSPHRASE, {
        question: `q${i}`,
        threadContext: null,
        draftText: "a",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.7,
        sources: [],
      });
    }
    const response = await app.inject({ method: "GET", url: "/drafts?limit=2", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
  });

  it("GET /drafts/:id 404s naming the id for an unknown draft", async () => {
    const response = await app.inject({ method: "GET", url: "/drafts/not-a-real-id", headers: authHeader });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("not-a-real-id");
  });

  it("POST /drafts escalates on an empty store and writes exactly one draft-log row", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: authHeader,
      payload: { question: "what is the meaning of life" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.kind).toBe("escalation");

    const listed = await app.inject({ method: "GET", url: "/drafts", headers: authHeader });
    expect(listed.json()).toHaveLength(1);
  });

  it("POST /drafts requires a question", async () => {
    const response = await app.inject({ method: "POST", url: "/drafts", headers: authHeader, payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("POST /drafts/:id/outcome records the outcome and echoes classification", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "original draft text",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "discarded" },
    });
    expect(response.statusCode).toBe(200);

    const stored = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(stored.json().outcome).toBe("discarded");
  });

  it("POST /drafts/:id/outcome 404s for an unknown draft", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/drafts/not-a-real-id/outcome",
      headers: authHeader,
      payload: { outcome: "discarded" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("POST /drafts/:id/outcome rejects a whitespace-only sentText for \"edited\" with 400, rather than classifying an emptied draft as a trivial style tweak", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: "original draft text",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "edited", sentText: "   " },
    });
    expect(response.statusCode).toBe(400);

    const stored = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(stored.json().outcome).toBeNull();
  });

  it("POST /drafts/:id/answer queues a standing-order candidate for an escalated draft", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no evidence",
      confidenceScore: 0,
      sources: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/answer`,
      headers: authHeader,
      payload: { answer: "the answer" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("candidateId");
  });

  it("an escalation leaves the pending queue once answered, instead of showing forever", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no evidence",
      confidenceScore: 0,
      sources: [],
    });

    const before = await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: authHeader });
    expect(before.json().map((d: { id: string }) => d.id)).toContain(draftId);

    await app.inject({ method: "POST", url: `/drafts/${draftId}/answer`, headers: authHeader, payload: { answer: "the answer" } });

    const after = await app.inject({ method: "GET", url: "/drafts?outcome=pending", headers: authHeader });
    expect(after.json().map((d: { id: string }) => d.id)).not.toContain(draftId);
  });

  it("POST /drafts/:id/answer refuses a refused escalation with 409, not a queued candidate", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "this subject is refused",
      confidenceScore: 0,
      sources: [],
      refused: true,
    });

    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/answer`,
      headers: authHeader,
      payload: { answer: "an override answer" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("POST /drafts/:id/answer rejects a whitespace-only answer with 400, not a junk queued candidate", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "q",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no evidence",
      confidenceScore: 0,
      sources: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/answer`,
      headers: authHeader,
      payload: { answer: "   " },
    });
    expect(response.statusCode).toBe(400);
  });

  it("GET /review is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/review", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("GET /mirror/portrait reports no history on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/mirror/portrait", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().totalQuestions).toBe(0);
  });

  it("GET /mirror/rules is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/mirror/rules", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ awaitingApproval: [], weakSignals: [] });
  });

  it("POST /mirror/rules/:id/approve approves a hand-written rule", async () => {
    const rule = writeRuleByHand(storePath, PASSPHRASE, join(tempDir(), "duo"), "topic-x", "always say yes");
    const response = await app.inject({ method: "POST", url: `/mirror/rules/${rule.id}/approve`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().reviewStatus).toBe("approved");
  });

  it("POST /mirror/rules/:id/:action rejects an unknown action with 400", async () => {
    const rule = writeRuleByHand(storePath, PASSPHRASE, join(tempDir(), "duo"), "topic-x", "always say yes");
    const response = await app.inject({ method: "POST", url: `/mirror/rules/${rule.id}/not-a-real-action`, headers: authHeader });
    expect(response.statusCode).toBe(400);
  });

  it("GET /trust/grid is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/trust/grid", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("GET /audit is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/audit", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  // Issue #169: provenance is on the wire as stored, so no client has to
  // infer where a draft came from — the client cannot infer any of it
  // without inventing behaviour a surface is forbidden from inventing.
  it("GET /drafts/:id returns a channel draft's provenance verbatim", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "how do I get deploy access?",
      threadContext: null,
      draftText: "point them at the runbook",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: {
        origin: "channel",
        channelKind: "slack",
        askerRef: "directory.json#sam",
        threadId: "C0123456789.1660000000",
        permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
      },
    });
    const response = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().provenance).toEqual({
      origin: "channel",
      channelKind: "slack",
      askerRef: "directory.json#sam",
      threadId: "C0123456789.1660000000",
      permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
    });
  });

  it("GET /drafts lists provenance on the wire, and a pre-provenance row reads as origin unknown", async () => {
    appendDraft(storePath, PASSPHRASE, {
      question: "legacy",
      threadContext: null,
      draftText: "a",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      // no provenance — reads as unknown, never throws
    });
    const response = await app.inject({ method: "GET", url: "/drafts", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0].provenance).toEqual({ origin: "unknown" });
  });

  it("POST /drafts — the owner asking their own duo — writes owner origin, no asker, no permalink", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: authHeader,
      payload: { question: "what is the meaning of life" },
    });
    expect(created.statusCode).toBe(201);
    const fetched = await app.inject({ method: "GET", url: `/drafts/${created.json().draftId}`, headers: authHeader });
    expect(fetched.json().provenance).toEqual({ origin: "owner" });
  });
});

describe("createServer — POST /ask auth seam (#159)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let askToken: { id: string; name: string; token: string };
  let askHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    askToken = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    askHeader = { authorization: `Bearer ${askToken.token}` };
  });

  it("accepts a valid ask token on /ask and reaches the route handler", async () => {
    const response = await app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "what is the leave policy" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ duo: "personal", kind: "passed_on" });
  });

  it("refuses a revoked ask token on its very next /ask — no success cache serves it (R3)", async () => {
    const first = await app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "q" } });
    expect(first.statusCode).toBe(200);

    revokeAskToken(storePath, PASSPHRASE, askToken.id);
    const second = await app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "q" } });
    expect(second.statusCode).toBe(401);
  });

  it("refuses an ask token the moment it expires, inside any would-be cache window (R3)", async () => {
    // One second, not a few tens of ms: the first ask itself pays a full
    // store decrypt (scrypt + AES-GCM), so a tighter expiry would sometimes
    // already be past when verification runs. Still far inside the 5-second
    // device cache window this test exists to prove does not apply.
    const shortLived = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 1_000).toISOString());
    const header = { authorization: `Bearer ${shortLived.token}` };
    const first = await app.inject({ method: "POST", url: "/ask", headers: header, payload: { question: "q" } });
    expect(first.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await app.inject({ method: "POST", url: "/ask", headers: header, payload: { question: "q" } });
    expect(second.statusCode).toBe(401);
  });

  it("accepts a device token on /ask — the owner is a superset of an asker (R1)", async () => {
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const header = { authorization: `Bearer ${paired.token}` };
    // First request exercises the cache-miss (two-decrypt) path; the
    // second rides the 5-second device cache — both must pass.
    const first = await app.inject({ method: "POST", url: "/ask", headers: header, payload: { question: "q" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/ask", headers: header, payload: { question: "q" } });
    expect(second.statusCode).toBe(200);
  });

  it("refuses /ask with one uniform, kind-blind body — no oracle separates unknown from revoked (R1)", async () => {
    const unknown = await app.inject({ method: "POST", url: "/ask", headers: { authorization: "Bearer not-a-real-token" }, payload: { question: "q" } });
    expect(unknown.statusCode).toBe(401);

    const revokedLink = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    revokeAskToken(storePath, PASSPHRASE, revokedLink.id);
    const revoked = await app.inject({ method: "POST", url: "/ask", headers: { authorization: `Bearer ${revokedLink.token}` }, payload: { question: "q" } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).toBe(unknown.body);
  });

  it("matches /ask with a query string as /ask — routing resolves before the hook, so no raw url exact-compare", async () => {
    const response = await app.inject({ method: "POST", url: "/ask?x=1", headers: askHeader, payload: { question: "q" } });
    expect(response.statusCode).toBe(200);
  });

  it("counts one failure per failed /ask authentication and blocks at exactly 10, not 5 (R4)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await app.inject({ method: "POST", url: "/ask", headers: { authorization: "Bearer not-a-real-token" }, payload: { question: "q" } });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("createServer — POST /ask personal branch (#159)", () => {
  let storePath: string;
  let app: FastifyInstance;
  let askToken: { id: string; name: string; token: string };
  let askHeader: { authorization: string };
  let deviceHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    askToken = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    askHeader = { authorization: `Bearer ${askToken.token}` };
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    deviceHeader = { authorization: `Bearer ${paired.token}` };
  });

  /** Injects a POST /ask against this describe's app (or an override app for provider-substitution tests). */
  function ask(payload: unknown, headers: { authorization: string } = askHeader, appOverride?: FastifyInstance): Promise<AskResponse> {
    return (appOverride ?? app).inject({ method: "POST", url: "/ask", headers, payload });
  }

  it("answers passed_on on an empty store, asker-visible fields only (R7/R8)", async () => {
    const response = await ask({ question: "what is the leave policy" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ duo: "personal", kind: "passed_on" });
    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("draftId");
    expect(body).not.toHaveProperty("logEntryId");
    expect(body).not.toHaveProperty("topicId");
    expect(body).not.toHaveProperty("confidence");
    expect(body).not.toHaveProperty("evidenceAgeDays");
    expect(body).not.toHaveProperty("ownerNotice");
    expect(body).not.toHaveProperty("sources");
  });

  it("declines a refused subject (R7)", async () => {
    writeRefusalsFile(join(tempDir(), "duo"), [{ heading: "vacation", reason: "Leave policy is under review; don't speak for me on it." }]);
    const response = await ask({ question: "how much vacation leave do I get" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ duo: "personal", kind: "declined_refused" });
  });

  it("answers a granted, publicly-markable topic with sources (R7)", async () => {
    await seedAnsweredTopic(storePath);
    const app = createServer(deps(storePath, { inferenceProvider: agreeingProvider("Five days per quarter, per policy.") }));
    const response = await ask({ question: "how much vacation leave do I get" }, askHeader, app);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ duo: "personal", kind: "answered" });
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.text).toContain("Five days per quarter");
  });

  it("gives a device principal the full outcome fields an asker never sees (R8)", async () => {
    const response = await ask({ question: "q" }, deviceHeader);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kind).toBe("passed_on");
    expect(typeof body.draftId).toBe("string");
    expect(typeof body.logEntryId).toBe("string");
  });

  it("carries a one-time ownerNotice to the device principal — owner-facing, not asker-facing (R8)", async () => {
    await seedAnsweredTopic(storePath, { demote: true });
    const app = createServer(deps(storePath, { inferenceProvider: agreeingProvider("Five days per quarter, per policy.") }));
    const response = await ask({ question: "how much vacation leave do I get" }, deviceHeader, app);
    expect(response.statusCode).toBe(200);
    expect(response.json().kind).toBe("passed_on");
    expect(response.json().ownerNotice).toMatch(/got that wrong/i);
  });

  it("never carries that ownerNotice to an ask principal (R8)", async () => {
    await seedAnsweredTopic(storePath, { demote: true });
    const app = createServer(deps(storePath, { inferenceProvider: agreeingProvider("Five days per quarter, per policy.") }));
    const response = await ask({ question: "how much vacation leave do I get" }, askHeader, app);
    expect(response.statusCode).toBe(200);
    expect(response.json().kind).toBe("passed_on");
    expect(response.json()).not.toHaveProperty("ownerNotice");
  });

  it("rejects a missing, empty, whitespace-only, or non-string question with 400 (R5)", async () => {
    for (const payload of [{}, { question: "" }, { question: "   " }, { question: 42 }]) {
      const response = await ask(payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.code).toBe("bad_request");
    }
  });

  it("rejects a bodyless POST with 400, not a 500 from destructuring a missing body (R5)", async () => {
    const response = await app.inject({ method: "POST", url: "/ask", headers: askHeader });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("rejects an unknown duo value by naming the accepted values — role duos are never askable (R5)", async () => {
    const response = await ask({ question: "q", duo: "role" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("personal, shared");
  });

  it("maps a delegation failure to a generic 500 that leaks neither the error nor any path (R6/KTD4)", async () => {
    await seedAnsweredTopic(storePath);
    const throwing: InferenceProvider = {
      name: "fake",
      async complete() {
        throw new Error(`provider exploded at ${join(tempDir(), "secret-path")}`);
      },
    };
    const app = createServer(deps(storePath, { inferenceProvider: throwing }));
    const response = await ask({ question: "how much vacation leave do I get" }, askHeader, app);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "internal_error", message: "Something went wrong answering that." } });
    expect(response.body).not.toContain(tempDir());
    expect(response.body).not.toContain("provider exploded");
  });
});

describe("createServer — POST /ask shared branch (#159, U3)", () => {
  let storePath: string;
  let askToken: { id: string; name: string; token: string };
  let askHeader: { authorization: string };
  let app: FastifyInstance;

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    askToken = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    askHeader = { authorization: `Bearer ${askToken.token}` };
  });

  /** Injects a POST /ask against this describe's app (or an override app for provider-substitution tests). */
  function ask(payload: unknown, headers: { authorization: string } = askHeader, appOverride?: FastifyInstance): Promise<AskResponse> {
    return (appOverride ?? app).inject({ method: "POST", url: "/ask", headers, payload });
  }

  it("answers a covered question with citations and the attribution intact (R7)", async () => {
    writeSharedPersona();
    // "leave requests" verbatim: AuthoredKnowledgeSource matches by
    // substring (the query must appear in the document), the exact shape
    // shared-cli.test.ts exercises.
    const response = await ask({ question: "leave requests", duo: "shared" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ duo: "shared", kind: "answered" });
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations[0].title).toBe("Leave requests");
    expect(body.text).toContain("submit through the HR portal");
    expect(body.text).toContain("source: Leave requests, updated 2026-06-01");
  });

  it("normalizes an out-of-scope decline to passed_on and keeps the declineReason (R7)", async () => {
    writeSharedPersona();
    const response = await ask({ question: "what is the parking policy", duo: "shared" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ duo: "shared", kind: "passed_on", declineReason: "out_of_scope" });
    expect(body.text).toContain("Dana Cole");
    expect(body).not.toHaveProperty("citations");
  });

  it("normalizes a decision request to declined_refused (R7)", async () => {
    writeSharedPersona();
    const response = await ask({ question: "can you approve my leave request", duo: "shared" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ duo: "shared", kind: "declined_refused", declineReason: "not_a_decision_maker" });
  });

  it("404s with shared_duo_unavailable when no persona is configured, naming the personal fallback (R10)", async () => {
    const response = await ask({ question: "q", duo: "shared" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("shared_duo_unavailable");
    expect(body.error.message).toContain("personal");
  });

  it("404s identically on a malformed persona file — never a 500 from a thrown load (R10)", async () => {
    const dir = join(tempDir(), "shared-duo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.json"), "{ not json");
    const response = await ask({ question: "q", duo: "shared" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("shared_duo_unavailable");
  });

  it("writes exactly one usage-log entry per shared ask, under the asker's id (R6 log fidelity)", async () => {
    writeSharedPersona();
    const response = await ask({ question: "leave requests", duo: "shared" });
    expect(response.statusCode).toBe(200);
    const entries = loadUsageLog(join(tempDir(), "shared-duo-runtime", "usage.json"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ question: "leave requests", askerId: "Sam", declined: false });
  });

  it("returns byte-identical shared bodies to ask and device principals — the shared outcome carries no owner-only fields (R8)", async () => {
    writeSharedPersona();
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const deviceHeader = { authorization: `Bearer ${paired.token}` };
    const asAsker = await ask({ question: "leave requests", duo: "shared" }, askHeader);
    const asOwner = await ask({ question: "leave requests", duo: "shared" }, deviceHeader);
    expect(asAsker.statusCode).toBe(200);
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.body).toBe(asAsker.body);
  });
});

describe("createServer — POST /ask asker identity (#159, U4)", () => {
  let storePath: string;
  let app: FastifyInstance;

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
  });

  function writeDirectory(entries: ReadonlyArray<{ id: string; name: string; clearance?: string }>): void {
    const dir = join(tempDir(), "duo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "directory.json"),
      JSON.stringify(entries.map((entry) => ({ groups: [], clearance: "official_open", ...entry }))),
    );
  }

  function mintAndAsk(name: string, payload: unknown = { question: "q" }): Promise<AskResponse> {
    const link = createAskToken(storePath, PASSPHRASE, name, new Date(Date.now() + 60 * 60 * 1000).toISOString());
    return app.inject({ method: "POST", url: "/ask", headers: { authorization: `Bearer ${link.token}` }, payload });
  }

  it("logs an in-directory asker under the directory's canonical id, matching case-insensitively (R6 log fidelity)", async () => {
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const response = await mintAndAsk("Sam-Carter");
    expect(response.statusCode).toBe(200);
    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0].askerRef).toBe("sam-carter");
  });

  it("logs an unresolvable asker under the raw link name, with no behavioral difference (R9)", async () => {
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const unresolved = await mintAndAsk("ZZZ-not-in-directory");
    const resolved = await mintAndAsk("Sam-Carter");
    expect(unresolved.statusCode).toBe(200);
    expect(resolved.statusCode).toBe(200);
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE).map((entry) => entry.askerRef)).toEqual(["ZZZ-not-in-directory", "sam-carter"]);
    // Same outcome shape and wording — resolution changes the log record,
    // never the answer (R9).
    expect(unresolved.json().kind).toBe(resolved.json().kind);
    expect(unresolved.json().text).toBe(resolved.json().text);
  });

  it("falls back to the raw name on a malformed directory.json — identity resolution never 500s an ask", async () => {
    const dir = join(tempDir(), "duo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "directory.json"), "{ not json");
    const response = await mintAndAsk("Sam");
    expect(response.statusCode).toBe(200);
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE)[0].askerRef).toBe("Sam");
  });

  it("logs a device principal as the owner", async () => {
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${paired.token}` },
      payload: { question: "q" },
    });
    expect(response.statusCode).toBe(200);
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE)[0].askerRef).toBe("owner");
  });

  it("carries the resolved id into the shared usage log too", async () => {
    writeSharedPersona();
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const response = await mintAndAsk("sam-carter", { question: "leave requests", duo: "shared" });
    expect(response.statusCode).toBe(200);
    const entries = loadUsageLog(join(tempDir(), "shared-duo-runtime", "usage.json"));
    expect(entries).toHaveLength(1);
    expect(entries[0].askerId).toBe("sam-carter");
  });
});

describe("createServer — POST /ask concurrency (#159, U5)", () => {
  // No mutex exists here by design (the plan's KTD6): `withDatabase` is
  // fully synchronous and every store mutation on the ask and hook paths
  // is one top-level, self-contained call, so interleaved request handlers
  // can only interleave at awaits — between whole store calls — and each
  // append reads the current store. These tests pin that invariant so an
  // async-store refactor cannot silently reintroduce a lost-write race
  // (R11's named proof).

  let storePath: string;
  let app: FastifyInstance;
  let askHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const link = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    askHeader = { authorization: `Bearer ${link.token}` };
  });

  it("two personal asks in flight concurrently both land their log rows — no lost write (R11)", async () => {
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "first question" } }),
      app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "second question" } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(2);
    expect(new Set(logged.map((entry) => entry.question))).toEqual(new Set(["first question", "second question"]));
  });

  it("two shared asks in flight concurrently both land their usage entries (R11)", async () => {
    writeSharedPersona();
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "leave requests", duo: "shared" } }),
      app.inject({ method: "POST", url: "/ask", headers: askHeader, payload: { question: "leave requests", duo: "shared" } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(loadUsageLog(join(tempDir(), "shared-duo-runtime", "usage.json"))).toHaveLength(2);
  });
});

describe("POST /drafts/:id/outcome — delivery through the origin channel (#170)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };
  let requests: ChannelDeliveryRequest[];
  let adapters: ChannelAdapter[];

  beforeEach(() => {
    storePath = initStore();
    requests = [];
    adapters = [
      {
        channelKind: "slack",
        async deliver(request) {
          requests.push(request);
        },
      },
    ];
    app = createServer({ ...deps(storePath), channelAdapters: adapters });
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  function appendChannelDraft(): string {
    return appendDraft(storePath, PASSPHRASE, {
      question: "how do I get deploy access?",
      threadContext: null,
      draftText: "point them at the runbook",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: {
        origin: "channel",
        channelKind: "slack",
        askerRef: "directory.json#sam",
        threadId: "C0123456789.1660000000",
        permalink: "https://example.slack.com/archives/C0123456789/p1660000000000000",
      },
    });
  }

  it("a sent channel draft is delivered through the daemon's adapter, and the state is on the wire", async () => {
    const draftId = appendChannelDraft();
    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "sent" },
    });
    expect(response.statusCode).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ askerRef: "directory.json#sam", text: "point them at the runbook" });

    const fetched = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(fetched.json().delivery).toEqual({ state: "delivered" });
  });

  it("a failed delivery does not fail the call: 200, outcome stands, failure recorded on the draft", async () => {
    const draftId = appendChannelDraft();
    adapters[0] = {
      channelKind: "slack",
      async deliver() {
        throw new Error("Slack API returned 500");
      },
    };

    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "sent" },
    });
    expect(response.statusCode).toBe(200);

    const fetched = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    const body = fetched.json();
    expect(body.outcome).toBe("sent");
    expect(body.delivery).toEqual({ state: "failed", reason: "Slack API returned 500" });
  });

  it("an owner-asked draft records no delivery — nothing was handed off, and the route says nothing about channels", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what do I think about X?",
      threadContext: null,
      draftText: "a draft",
      escalated: false,
      escalationReason: null,
      confidenceScore: 0.8,
      sources: [],
      provenance: { origin: "owner" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "sent" },
    });
    expect(response.statusCode).toBe(200);
    expect(requests).toHaveLength(0);

    const fetched = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(fetched.json().delivery).toBeNull();
  });
});

describe("POST /review/:id/approve and /review/:id/reject — acting on the correction queue (#173)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  function queueStyleCandidate(): string {
    return queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "style",
      draftId: "draft-1",
      question: "when is the meeting?",
      draftText: "the meeting is on tuesday",
      sentText: "the meeting is on tuesday at 3pm",
    }).id;
  }

  function queueEscalationCandidate(): string {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "how do I expense conference travel?",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no supporting evidence",
      confidenceScore: 0,
      sources: [],
    });
    return queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "submit the pre-approval form two weeks ahead");
  }

  it("approves a draft-edit candidate and returns the updated candidate", async () => {
    const candidateId = queueStyleCandidate();
    const response = await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.candidate).toMatchObject({ id: candidateId, source: "draft_edit", status: "approved" });
    expect(body.candidate.reviewedAt).not.toBeNull();
    // JSON drops `rule: undefined` — a style approval writes no rule.
    expect(body.result).toEqual({ kind: "style" });
  });

  it("approves an escalation candidate on the same path the CLI uses, writing its rule", async () => {
    const candidateId = queueEscalationCandidate();
    const response = await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.candidate).toMatchObject({ id: candidateId, source: "escalation", status: "approved" });
    expect(body.result).toMatchObject({ kind: "substance" });
    expect(body.result.rule).toMatchObject({ text: "submit the pre-approval form two weeks ahead" });
  });

  it("rejects a draft-edit candidate and returns the updated candidate", async () => {
    const candidateId = queueStyleCandidate();
    const response = await app.inject({ method: "POST", url: `/review/${candidateId}/reject`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidate).toMatchObject({ id: candidateId, status: "rejected" });
    expect(response.json().candidate.reviewedAt).not.toBeNull();
  });

  it("rejects an escalation candidate too", async () => {
    const candidateId = queueEscalationCandidate();
    const response = await app.inject({ method: "POST", url: `/review/${candidateId}/reject`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidate).toMatchObject({ id: candidateId, source: "escalation", status: "rejected" });
  });

  it("an already-reviewed candidate conflicts: 409, whichever action is retried", async () => {
    const candidateId = queueStyleCandidate();
    await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });

    const reApprove = await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });
    expect(reApprove.statusCode).toBe(409);
    expect(reApprove.json().error).toMatchObject({ code: "CandidateAlreadyReviewedError" });

    const rejectAfter = await app.inject({ method: "POST", url: `/review/${candidateId}/reject`, headers: authHeader });
    expect(rejectAfter.statusCode).toBe(409);
  });

  it("an already-reviewed escalation candidate conflicts with 409 as well, not a 500 from an anonymous error", async () => {
    const candidateId = queueEscalationCandidate();
    await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });

    const retry = await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.message).toContain("already reviewed");
  });

  it("an unknown id 404s on both routes, naming the id", async () => {
    const approve = await app.inject({ method: "POST", url: "/review/not-a-real-id/approve", headers: authHeader });
    expect(approve.statusCode).toBe(404);
    expect(approve.json().error.message).toContain("not-a-real-id");

    const reject = await app.inject({ method: "POST", url: "/review/not-a-real-id/reject", headers: authHeader });
    expect(reject.statusCode).toBe(404);
    expect(reject.json().error.message).toContain("not-a-real-id");
  });

  it("approving a substance candidate that conflicts with an active rule is refused with 409 until supersedesRuleId resolves it", async () => {
    const oldRule = writeRuleByHand(storePath, PASSPHRASE, join(tempDir(), "duo"), "office hours", "office hours are nine to five, monday to friday");
    const candidateId = queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId: "draft-2",
      question: "what are the office hours?",
      draftText: "office hours are flexible this month",
      sentText: "office hours are now ten to six every weekday",
    }).id;

    const refused = await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "CandidateConflictError" });

    // Refused, not partially applied: still pending.
    const listed = await app.inject({ method: "GET", url: "/review?status=pending", headers: authHeader });
    expect(listed.json().some((candidate: { id: string }) => candidate.id === candidateId)).toBe(true);

    const resolved = await app.inject({
      method: "POST",
      url: `/review/${candidateId}/approve`,
      headers: authHeader,
      payload: { supersedesRuleId: oldRule.id },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().result.rule).toMatchObject({ text: "office hours are now ten to six every weekday" });
  });
});
