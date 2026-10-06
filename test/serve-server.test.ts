import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createFakeEmbeddingProvider, createFailingEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import { registerAction } from "../src/actions/registry.js";
import { confirmAndExecuteT4Request, createT4Request, NotAT4ActionError } from "../src/actions/t4-guard.js";
import { loadLifecycleLog } from "../src/continuity/lifecycle-log.js";
import { confirmTransfer, initiateTransfer } from "../src/continuity/transfer.js";
import { loadConfig } from "../src/config.js";
import { runImportPaste } from "../src/commands/import.js";
import { appendDraft, recordDraftOutcome } from "../src/drafting/draft-log.js";
import { draftReply } from "../src/drafting/pipeline.js";
import { escalationUrgencyRate, listEscalationDigests } from "../src/escalation/digest.js";
import { muteChannel, muteThread, readMutedChannels } from "../src/drafting/channel-mutes.js";
import type { ChannelAdapter, ChannelDeliveryRequest } from "../src/drafting/delivery.js";
import { writeRuleByHand } from "../src/derivation/rule-review.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { listRules, putRule, runRuleInduction } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { embedRecords, hybridSearch } from "../src/ingest/embeddings.js";
import { ingestRecords } from "../src/ingest/two-phase.js";
import { createRecord, type RecordInput } from "../src/ingest/record.js";
import { ensureRecordsSchema, writeRecords } from "../src/ingest/record-store.js";
import { listPublicAnswerLogEntries } from "../src/permissions/public-answer-log.js";
import { queueCorrectionCandidate } from "../src/corrections/queue.js";
import { listStandingOrderCandidates, queueStandingOrderCandidate } from "../src/drafting/standing-order-candidates.js";
import { applyCorrection } from "../src/trust/demotion.js";
import { grantAutonomy } from "../src/trust/grants.js";
import { confirmNoRefusals, upsertRefusal, writeRefusalsFile } from "../src/trust/refusals.js";
import type { EmbeddingProvider, InferenceProvider } from "../src/provider/types.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createAskToken, createDeviceToken, listDeviceTokens, revokeAskToken } from "../src/serve/tokens.js";
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
    lifecycleLogPath: join(tempDir(), "lifecycle-runtime", "events.json"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
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

/** Writes duo/directory.json for the asker-identity tests (#159/#160) — every entry defaults to open clearance. */
function writeDirectory(entries: ReadonlyArray<{ id: string; name: string; clearance?: string }>): void {
  const dir = join(tempDir(), "duo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "directory.json"),
    JSON.stringify(entries.map((entry) => ({ groups: [], clearance: "official_open", ...entry }))),
  );
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
  // the GETs: the twelve POSTs are owner-only surfaces too, and a seam bug
  // that only leaked on POSTs would otherwise pass unnoticed. #177's two
  // device routes, #172's three channel-policy routes, #178's three
  // escalation routes, #182's refusals route, #180's three actions
  // routes, #181's two lifecycle routes, and #176's three corpus routes
  // extend the inventory the same way.
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
    { method: "GET", url: "/mirror/refusals" },
    { method: "GET", url: "/trust/grid" },
    { method: "GET", url: "/audit" },
    { method: "GET", url: "/devices" },
    { method: "GET", url: "/channels" },
    { method: "GET", url: "/channels/policy" },
    { method: "GET", url: "/escalations/history" },
    { method: "GET", url: "/escalations/rate" },
    { method: "GET", url: "/actions/t4/pending" },
    { method: "GET", url: "/actions/attempts" },
    { method: "GET", url: "/lifecycle" },
    { method: "GET", url: "/corpus/embed" },
    { method: "POST", url: "/drafts", payload: { question: "q" } },
    { method: "POST", url: "/compose/rewrite", payload: { text: "hi", instruction: "shorter" } },
    { method: "POST", url: "/compose/fact-check", payload: { text: "hi" } },
    { method: "POST", url: "/drafts/some-draft-id/outcome", payload: { outcome: "sent" } },
    { method: "POST", url: "/drafts/some-draft-id/answer", payload: { answer: "a" } },
    { method: "POST", url: "/drafts/some-draft-id/shape", payload: { instruction: "shorter" } },
    { method: "POST", url: "/drafts/some-draft-id/shape/undo" },
    { method: "POST", url: "/mirror/rules/some-rule-id/approve" },
    { method: "POST", url: "/devices/some-device-id/revoke" },
    { method: "POST", url: "/channels/policy/mute", payload: { channel: "c" } },
    { method: "POST", url: "/channels/policy/unmute", payload: { channel: "c" } },
    { method: "POST", url: "/escalations/digest" },
    { method: "POST", url: "/actions/t4/some-request-id/confirm" },
    { method: "POST", url: "/lifecycle/end", payload: { decidedBy: "owner", confirmed: true } },
    { method: "POST", url: "/corpus/import-paste", payload: { transcript: "Human: hi" } },
    { method: "POST", url: "/corpus/embed" },
  ];

  async function expectRefusedOnAllOwnerRoutes(token: string): Promise<void> {
    // Each request comes from its own IP: 31 refused requests from one IP
    // would cross the per-IP 10-failure rate-limit cap mid-loop and turn
    // the tail of the inventory into 429s — a different (also correct)
    // behavior than the byte-identical 401 this helper exists to pin.
    const invalid = await app.inject({ method: "GET", url: "/duos", headers: { authorization: "Bearer not-a-real-token" }, remoteAddress: "10.0.0.250" });
    // Concurrent injects are safe here: every store call the hook makes is
    // fully synchronous (KTD6), so no two requests can interleave
    // mid-verification — and 31 sequential cache-miss verifies would each
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

  // guangshinhaha/duo#29: paging must reach the newest window. The route
  // passes limit/before through to listDrafts unchanged — so the fix in the
  // module must be visible here as *which* ids come back, not just how many.
  it("GET /drafts?limit returns the newest drafts, and a backward walk via before continues from there", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        appendDraft(storePath, PASSPHRASE, {
          question: `q${i}`,
          threadContext: null,
          draftText: "a",
          escalated: false,
          escalationReason: null,
          confidenceScore: 0.7,
          sources: [],
        }),
      );
      // Distinct createdAt per draft: appendDraft stamps "now", and a tight
      // loop can land two drafts on the same millisecond, which would make
      // the newest-first ordering and the exclusive cursor ambiguous.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const pageOne = await app.inject({ method: "GET", url: "/drafts?limit=2", headers: authHeader });
    expect(pageOne.statusCode).toBe(200);
    const pageOneBody = pageOne.json();
    expect(pageOneBody.map((draft: { id: string }) => draft.id)).toEqual([ids[2], ids[1]]);

    const before = encodeURIComponent(pageOneBody[pageOneBody.length - 1].createdAt);
    const pageTwo = await app.inject({ method: "GET", url: `/drafts?limit=2&before=${before}`, headers: authHeader });
    expect(pageTwo.statusCode).toBe(200);
    expect(pageTwo.json().map((draft: { id: string }) => draft.id)).toEqual([ids[0]]);
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

  it("POST /compose/rewrite 503s with no inference provider configured, rather than echoing the input back unrewritten", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/compose/rewrite",
      headers: authHeader,
      payload: { text: "hey can u send me the doc", instruction: "proofread" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "rewrite_unavailable" } });
  });

  it("POST /compose/rewrite requires non-empty text and a known instruction", async () => {
    const noText = await app.inject({ method: "POST", url: "/compose/rewrite", headers: authHeader, payload: { instruction: "shorter" } });
    expect(noText.statusCode).toBe(400);
    const blankText = await app.inject({ method: "POST", url: "/compose/rewrite", headers: authHeader, payload: { text: "   ", instruction: "shorter" } });
    expect(blankText.statusCode).toBe(400);
    const badInstruction = await app.inject({ method: "POST", url: "/compose/rewrite", headers: authHeader, payload: { text: "hi", instruction: "yell" } });
    expect(badInstruction.statusCode).toBe(400);
  });

  it("POST /compose/rewrite returns the provider's rewritten text, trimmed, when a provider is configured", async () => {
    app = createServer(deps(storePath, { inferenceProvider: agreeingProvider("  Could you send the document over?  ") }));
    const response = await app.inject({
      method: "POST",
      url: "/compose/rewrite",
      headers: authHeader,
      payload: { text: "hey can u send me the doc", instruction: "proofread" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "Could you send the document over?" });
  });

  it("POST /compose/fact-check never flags with no inference provider configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/compose/fact-check",
      headers: authHeader,
      payload: { text: "let's meet Friday" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ flag: null });
  });

  it("POST /compose/fact-check requires text", async () => {
    const response = await app.inject({ method: "POST", url: "/compose/fact-check", headers: authHeader, payload: {} });
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

  it("POST /drafts/:id/outcome stores an optional dismissReason alongside \"discarded\" (guangshinhaha/duo#259)", async () => {
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
      payload: { outcome: "discarded", dismissReason: "wrong_tone" },
    });
    expect(response.statusCode).toBe(200);

    const stored = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(stored.json().outcome).toBe("discarded");
    expect(stored.json().dismissReason).toBe("wrong_tone");
  });

  it("POST /drafts/:id/outcome dismissing without a reason still works, leaving dismissReason null (guangshinhaha/duo#259)", async () => {
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
    expect(stored.json().dismissReason).toBeNull();
  });

  it("POST /drafts/:id/outcome rejects an unrecognized dismissReason value with 400 (guangshinhaha/duo#259)", async () => {
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
      payload: { outcome: "discarded", dismissReason: "not_a_real_reason" },
    });
    expect(response.statusCode).toBe(400);

    const stored = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(stored.json().outcome).toBeNull();
  });

  it("POST /drafts/:id/outcome rejects a dismissReason attached to a \"sent\" outcome with 400 (guangshinhaha/duo#259)", async () => {
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
      payload: { outcome: "sent", dismissReason: "wrong_facts" },
    });
    expect(response.statusCode).toBe(400);
  });

  describe("alternatives and shaping (guangshinhaha/duo#257, #258)", () => {
    function appendWithAlternatives(): string {
      return appendDraft(storePath, PASSPHRASE, {
        question: "q",
        threadContext: null,
        draftText: "default",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.6,
        sources: [],
        provenance: { origin: "owner" },
        alternatives: [
          { text: "default", instruction: null, confidenceScore: 0.6, sources: [] },
          { text: "short", instruction: "shorter", confidenceScore: 0.58, sources: [] },
          { text: "careful", instruction: "cautious", confidenceScore: 0.57, sources: [] },
        ],
      });
    }

    it("GET /drafts/:id carries the alternatives, chosen index and shapes", async () => {
      const draftId = appendWithAlternatives();
      const response = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
      expect(response.json()).toMatchObject({
        alternatives: [
          { text: "default", instruction: null, outcome: null },
          { text: "short", instruction: "shorter", outcome: null },
          { text: "careful", instruction: "cautious", outcome: null },
        ],
        chosenAlternative: null,
        shapes: [],
      });
    });

    it("POST /drafts/:id/outcome records which alternative was sent", async () => {
      const draftId = appendWithAlternatives();
      const response = await app.inject({ method: "POST", url: `/drafts/${draftId}/outcome`, headers: authHeader, payload: { outcome: "sent", alternative: 1 } });
      expect(response.statusCode).toBe(200);
      const stored = (await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader })).json();
      expect(stored.chosenAlternative).toBe(1);
      expect(stored.draftText).toBe("short");
      expect(stored.alternatives.map((a: { outcome: string }) => a.outcome)).toEqual(["not_chosen", "chosen", "not_chosen"]);
    });

    it("POST /drafts/:id/outcome 400s on a malformed or missing alternative", async () => {
      const draftId = appendWithAlternatives();
      const malformed = await app.inject({ method: "POST", url: `/drafts/${draftId}/outcome`, headers: authHeader, payload: { outcome: "sent", alternative: "1" } });
      expect(malformed.statusCode).toBe(400);
      const missing = await app.inject({ method: "POST", url: `/drafts/${draftId}/outcome`, headers: authHeader, payload: { outcome: "sent", alternative: 7 } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.code).toBe("UnknownAlternativeError");
    });

    it("POST /drafts/:id/shape regenerates with the instruction and returns the draft; undo puts it back", async () => {
      const prompts: string[] = [];
      const shaping: InferenceProvider = { name: "fake", async complete(prompt) { prompts.push(prompt); return "short, warmly"; } };
      const shapeApp = createServer(deps(storePath, { inferenceProvider: shaping }));
      const draftId = appendWithAlternatives();

      const shaped = await shapeApp.inject({ method: "POST", url: `/drafts/${draftId}/shape`, headers: authHeader, payload: { instruction: "warmer", alternative: 1 } });
      expect(shaped.statusCode).toBe(200);
      expect(shaped.json().alternatives[1].text).toBe("short, warmly");
      expect(shaped.json().shapes).toEqual([expect.objectContaining({ alternative: 1, instruction: "warmer", undoneAt: null })]);
      expect(prompts[0]).toContain("The current draft:\nshort");

      const undone = await shapeApp.inject({ method: "POST", url: `/drafts/${draftId}/shape/undo`, headers: authHeader, payload: { alternative: 1 } });
      expect(undone.statusCode).toBe(200);
      expect(undone.json().alternatives[1].text).toBe("short");

      const nothingLeft = await shapeApp.inject({ method: "POST", url: `/drafts/${draftId}/shape/undo`, headers: authHeader, payload: { alternative: 1 } });
      expect(nothingLeft.statusCode).toBe(409);
    });

    it("POST /drafts/:id/shape 400s on an instruction outside the closed set, 404s an unknown draft, 409s with no model", async () => {
      const draftId = appendWithAlternatives();
      const bad = await app.inject({ method: "POST", url: `/drafts/${draftId}/shape`, headers: authHeader, payload: { instruction: "ruder" } });
      expect(bad.statusCode).toBe(400);
      const unknown = await app.inject({ method: "POST", url: "/drafts/not-a-real-id/shape", headers: authHeader, payload: { instruction: "shorter" } });
      expect(unknown.statusCode).toBe(404);
      // `app` has no inference provider.
      const noModel = await app.inject({ method: "POST", url: `/drafts/${draftId}/shape`, headers: authHeader, payload: { instruction: "shorter" } });
      expect(noModel.statusCode).toBe(409);
      expect(noModel.json().error.code).toBe("ShapingUnavailableError");
    });
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

describe("createServer — POST /ask audit-trail asker context (#160)", () => {
  let storePath: string;
  let app: FastifyInstance;

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
  });

  function mint(name: string) {
    return createAskToken(storePath, PASSPHRASE, name, new Date(Date.now() + 60 * 60 * 1000).toISOString());
  }

  /** AC1: a personal answer through an ask link names the link by id, the resolution outcome, and the ceiling — never the raw secret. */
  it("logs an in-directory ask link's id, resolved true, and the official_open ceiling on a passed_on answer", async () => {
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const link = mint("Sam-Carter");
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "q" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().kind).toBe("passed_on");

    const logged = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      askerRef: "sam-carter",
      askLinkId: link.id,
      askerResolved: true,
      clearanceApplied: "official_open",
    });
    // The raw secret never lands in the trail — the id alone names the link.
    expect(JSON.stringify(logged)).not.toContain(link.token);
  });

  it("logs an off-directory ask link as resolved false under the raw name, with the link id still recorded", async () => {
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const link = mint("someone-else");
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "q" },
    });
    expect(response.statusCode).toBe(200);
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE)[0]).toMatchObject({
      askerRef: "someone-else",
      askLinkId: link.id,
      askerResolved: false,
      clearanceApplied: "official_open",
    });
  });

  it("treats a malformed directory as an attempted-and-failed lookup (resolved false), never a 500", async () => {
    const dir = join(tempDir(), "duo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "directory.json"), "{ not json");
    const link = mint("Sam");
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "q" },
    });
    expect(response.statusCode).toBe(200);
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE)[0]).toMatchObject({
      askerRef: "Sam",
      askLinkId: link.id,
      askerResolved: false,
    });
  });

  it("logs a device principal with no link and no lookup — owner / null / null / official_open", async () => {
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${paired.token}` },
      payload: { question: "q" },
    });
    expect(response.statusCode).toBe(200);
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE)[0]).toMatchObject({
      askerRef: "owner",
      askLinkId: null,
      askerResolved: null,
      clearanceApplied: "official_open",
    });
  });

  it("carries the link id and resolution into the shared usage log too — content parity across both branches", async () => {
    writeSharedPersona();
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const link = mint("sam-carter");
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "leave requests", duo: "shared" },
    });
    expect(response.statusCode).toBe(200);
    const entries = loadUsageLog(join(tempDir(), "shared-duo-runtime", "usage.json"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ askerId: "sam-carter", askLinkId: link.id, askerResolved: true });
    expect(JSON.stringify(entries)).not.toContain(link.token);
  });

  /** AC2: revoking a link changes who may ask next; it never rewrites what was already answered. */
  it("leaves a revoked link's past answers unchanged, and refuses its next ask", async () => {
    writeSharedPersona();
    writeDirectory([{ id: "sam-carter", name: "Sam Carter" }]);
    const link = mint("sam-carter");
    const first = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "q" },
    });
    expect(first.statusCode).toBe(200);
    const sharedFirst = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "leave requests", duo: "shared" },
    });
    expect(sharedFirst.statusCode).toBe(200);
    const usagePath = join(tempDir(), "shared-duo-runtime", "usage.json");
    const before = listPublicAnswerLogEntries(storePath, PASSPHRASE);
    // Both snapshots must be non-empty for the equality pins below to mean
    // anything — each names its newest entry, so an empty snapshot fails here.
    expect(before.at(-1)).toMatchObject({ askLinkId: link.id });
    const usageBefore = loadUsageLog(usagePath);

    revokeAskToken(storePath, PASSPHRASE, link.id);

    const second = await app.inject({
      method: "POST",
      url: "/ask",
      headers: { authorization: `Bearer ${link.token}` },
      payload: { question: "q" },
    });
    expect(second.statusCode).toBe(401);
    // The revoked link's earlier answers stand exactly as written — same
    // rows, same context, append-only, on both the personal and shared logs.
    expect(listPublicAnswerLogEntries(storePath, PASSPHRASE)).toEqual(before);
    const usageAfter = loadUsageLog(usagePath);
    expect(usageAfter).toEqual(usageBefore);
    expect(usageAfter.at(-1)).toMatchObject({ askLinkId: link.id });
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
        label: "a channel",
        async status() {
          return { state: "connected", lastActivityAt: null };
        },
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
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
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

  it("refuses a second outcome on an already-settled draft with 409, naming the existing outcome, and delivers nothing a second time (#262)", async () => {
    const draftId = appendChannelDraft();
    const first = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "sent" },
    });
    expect(first.statusCode).toBe(200);
    expect(requests).toHaveLength(1);

    const second = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "edited", sentText: "a different answer entirely" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/already recorded as "sent"/);

    // Nothing changed and nothing was delivered a second time.
    expect(requests).toHaveLength(1);
    const fetched = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    const body = fetched.json();
    expect(body.outcome).toBe("sent");
    expect(body.sentText).toBeNull();
  });

  it("a retry after a FAILED delivery is not blocked by the settled-draft guard, and can still deliver (#262)", async () => {
    const draftId = appendChannelDraft();
    adapters[0] = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {
        throw new Error("Slack API returned 500");
      },
    };

    const first = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "sent" },
    });
    expect(first.statusCode).toBe(200);
    const afterFirst = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(afterFirst.json().delivery).toEqual({ state: "failed", reason: "Slack API returned 500" });

    // The adapter is fixed and the same outcome is recorded again — a retry,
    // not a second disposition — and it is not refused as already settled.
    adapters[0] = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver(request) {
        requests.push(request);
      },
    };
    const retry = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/outcome`,
      headers: authHeader,
      payload: { outcome: "sent" },
    });
    expect(retry.statusCode).toBe(200);
    expect(requests).toHaveLength(1);
    const afterRetry = await app.inject({ method: "GET", url: `/drafts/${draftId}`, headers: authHeader });
    expect(afterRetry.json().delivery).toEqual({ state: "delivered" });
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

describe("GET /review — the whole review queue, escalation answers included (#166)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  function queueDraftEditCandidate(question: string, draftText: string, sentText: string): string {
    return queueCorrectionCandidate(storePath, PASSPHRASE, {
      kind: "substance",
      draftId: "draft-1",
      question,
      draftText,
      sentText,
    }).id;
  }

  // The live smoke test from the issue, end to end over HTTP: a question
  // with nothing behind it escalates, the owner answers it, and the
  // candidate the answer queues is what GET /review lists — the drawer
  // this route is the only surface that opens.
  it("the smoke-test sequence: answer an escalation over HTTP and the candidate IS listed", async () => {
    const drafted = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: authHeader,
      payload: { question: "What is the meaning of life?" },
    });
    expect(drafted.statusCode).toBe(201);
    expect(drafted.json().kind).toBe("escalation");
    expect(drafted.json().refused).toBe(false);
    const draftId: string = drafted.json().draftId;

    const answered = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/answer`,
      headers: authHeader,
      payload: { answer: "20 days paid leave, carried over at the owner's discretion" },
    });
    expect(answered.statusCode).toBe(200);
    const candidateId: string = answered.json().candidateId;

    const review = await app.inject({ method: "GET", url: "/review", headers: authHeader });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toHaveLength(1);
    expect(review.json()[0]).toMatchObject({
      id: candidateId,
      kind: "substance",
      source: "escalation",
      draftId,
      question: "What is the meaning of life?",
      // An escalation had no confident draft to edit — empty string on
      // the wire (never null: the client diffs draftText against
      // sentText with non-null string types), and the owner's answer is
      // the proposed text under this route's own historical name for it.
      draftText: "",
      sentText: "20 days paid leave, carried over at the owner's discretion",
      status: "pending",
      reviewedAt: null,
    });

    // A retried answer (client remounting before the outcome lands) is
    // idempotent at the queue — the listing must not double either.
    const retried = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/answer`,
      headers: authHeader,
      payload: { answer: "20 days paid leave, carried over at the owner's discretion" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().candidateId).toBe(candidateId);

    const stillOne = await app.inject({ method: "GET", url: "/review", headers: authHeader });
    expect(stillOne.json()).toHaveLength(1);
  });

  it("?status=pending lists the escalation candidate, and after an approve it moves to ?status=approved", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "how do I expense conference travel?",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no evidence",
      confidenceScore: 0,
      sources: [],
    });
    const candidateId = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "submit the pre-approval form two weeks ahead");

    const pending = await app.inject({ method: "GET", url: "/review?status=pending", headers: authHeader });
    expect(pending.json().map((candidate: { id: string }) => candidate.id)).toEqual([candidateId]);

    const approved = await app.inject({ method: "POST", url: `/review/${candidateId}/approve`, headers: authHeader });
    expect(approved.statusCode).toBe(200);

    const stillPending = await app.inject({ method: "GET", url: "/review?status=pending", headers: authHeader });
    expect(stillPending.json()).toEqual([]);

    const nowApproved = await app.inject({ method: "GET", url: "/review?status=approved", headers: authHeader });
    expect(nowApproved.json().map((candidate: { id: string }) => candidate.id)).toEqual([candidateId]);

    // The bare route is history, not a queue (#44): every status, both sources.
    const bare = await app.inject({ method: "GET", url: "/review", headers: authHeader });
    expect(bare.json().map((candidate: { id: string }) => candidate.id)).toEqual([candidateId]);
  });

  it("a draft-edit candidate keeps its exact wire shape, plus the additive source", async () => {
    const candidateId = queueDraftEditCandidate("what are the office hours?", "office hours are flexible", "office hours are nine to five");

    const review = await app.inject({ method: "GET", url: "/review?status=pending", headers: authHeader });
    expect(review.json()).toHaveLength(1);
    expect(review.json()[0]).toEqual({
      id: candidateId,
      kind: "substance",
      source: "draft_edit",
      draftId: "draft-1",
      question: "what are the office hours?",
      draftText: "office hours are flexible",
      sentText: "office hours are nine to five",
      status: "pending",
      createdAt: expect.any(String),
      reviewedAt: null,
    });
  });

  it("lists both sources in one queue, oldest first", async () => {
    queueDraftEditCandidate("q1", "draft one", "sent one");

    const escalatedDraft = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no evidence",
      confidenceScore: 0,
      sources: [],
    });
    queueStandingOrderCandidate(storePath, PASSPHRASE, escalatedDraft, "the answer");

    const review = await app.inject({ method: "GET", url: "/review?status=pending", headers: authHeader });
    expect(review.json().map((candidate: { question: string }) => candidate.question)).toEqual(["q1", "q2"]);
    expect(review.json().map((candidate: { source: string }) => candidate.source)).toEqual(["draft_edit", "escalation"]);
  });

  // The route's old status semantics, pinned across BOTH halves of the
  // merge: an unknown value filters to an empty list, an empty value is no
  // filter at all (the reading the corrections-only route always gave it —
  // the two halves must not disagree), and a candidate rejected through
  // the route's own action stays listed under ?status=rejected.
  it("keeps the old ?status semantics across both halves, and lists a route-rejected candidate under ?status=rejected", async () => {
    const draftEditId = queueDraftEditCandidate("q1", "draft one", "sent one");
    const escalatedDraft = appendDraft(storePath, PASSPHRASE, {
      question: "q2",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "no evidence",
      confidenceScore: 0,
      sources: [],
    });
    queueStandingOrderCandidate(storePath, PASSPHRASE, escalatedDraft, "the answer");

    const bogus = await app.inject({ method: "GET", url: "/review?status=bogus", headers: authHeader });
    expect(bogus.statusCode).toBe(200);
    expect(bogus.json()).toEqual([]);

    const empty = await app.inject({ method: "GET", url: "/review?status=", headers: authHeader });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toHaveLength(2);

    const rejected = await app.inject({ method: "POST", url: `/review/${draftEditId}/reject`, headers: authHeader });
    expect(rejected.statusCode).toBe(200);

    const rejectedList = await app.inject({ method: "GET", url: "/review?status=rejected", headers: authHeader });
    expect(rejectedList.json().map((candidate: { id: string }) => candidate.id)).toEqual([draftEditId]);

    const pending = await app.inject({ method: "GET", url: "/review?status=pending", headers: authHeader });
    expect(pending.json().map((candidate: { id: string }) => candidate.id)).not.toContain(draftEditId);
  });
});

describe("GET /search — the corpus, from a client (#174)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  /** Seeds a small indexed corpus: three vacation-leave answers (differing relevance) and one unrelated record. */
  async function seedCorpus(): Promise<void> {
    const records = [
      record({ text: "five days of vacation leave per quarter", threadId: "a" }),
      record({ text: "vacation leave accrues from day one", threadId: "b" }),
      record({ text: "the vacation policy allows carry-over", threadId: "c" }),
      record({ text: "the printer on floor two is broken", threadId: "d" }),
    ];
    writeRecords(storePath, PASSPHRASE, records);
    await embedRecords(storePath, PASSPHRASE, createFakeEmbeddingProvider());
  }

  it("returns ranked results in the same shape and order runSearch produces, with each record's identity", async () => {
    await seedCorpus();
    const response = await app.inject({ method: "GET", url: "/search?q=vacation%20leave", headers: authHeader });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.usedEmbeddings).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(body.results.length).toBe(3);
    // Identity: every result carries the record's own id and text.
    for (const result of body.results) {
      expect(typeof result.record.id).toBe("string");
      expect(result.record.text).toContain("vacation");
    }
    // Order: fused ranks are ascending from zero, and match what the module
    // itself produces for the same query (the fake provider is deterministic).
    expect(body.results.map((result: { rank: number }) => result.rank)).toEqual([0, 1, 2]);
    const direct = await hybridSearch(storePath, PASSPHRASE, "vacation leave", createFakeEmbeddingProvider(), 10);
    expect(body.results.map((result: { record: { id: string } }) => result.record.id)).toEqual(
      direct.results.map((result) => result.record.id),
    );
  });

  it("pages with limit and cursor without shipping the whole corpus", async () => {
    await seedCorpus();
    const first = await app.inject({ method: "GET", url: "/search?q=vacation%20leave&limit=2", headers: authHeader });
    expect(first.statusCode).toBe(200);
    expect(first.json().results).toHaveLength(2);

    // Cursor = the fused rank after the last result seen (rank + 1).
    const second = await app.inject({
      method: "GET",
      url: `/search?q=vacation%20leave&limit=2&cursor=${first.json().results.length}`,
      headers: authHeader,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().results).toHaveLength(1);

    const firstIds = first.json().results.map((result: { record: { id: string } }) => result.record.id);
    const secondIds = second.json().results.map((result: { record: { id: string } }) => result.record.id);
    expect(firstIds).toHaveLength(2);
    expect(secondIds).not.toHaveLength(0);
    // Pages are disjoint and together cover exactly what an unpaged search returns.
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
    const direct = await hybridSearch(storePath, PASSPHRASE, "vacation leave", createFakeEmbeddingProvider(), 10);
    expect([...firstIds, ...secondIds]).toEqual(direct.results.map((result) => result.record.id));

    // A cursor past the end answers empty, not error.
    const past = await app.inject({ method: "GET", url: "/search?q=vacation%20leave&limit=2&cursor=50", headers: authHeader });
    expect(past.statusCode).toBe(200);
    expect(past.json().results).toEqual([]);
  });

  it("an empty corpus returns an empty result, not an error", async () => {
    const response = await app.inject({ method: "GET", url: "/search?q=anything%20at%20all", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ results: [], usedEmbeddings: true });
  });

  it("a query matching nothing indexed returns empty, not an error", async () => {
    await seedCorpus();
    const response = await app.inject({ method: "GET", url: "/search?q=quokka%20husbandry", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([]);
  });

  it("validates its inputs: q required, limit 1–100, cursor a non-negative integer", async () => {
    await seedCorpus();
    const missingQ = await app.inject({ method: "GET", url: "/search", headers: authHeader });
    expect(missingQ.statusCode).toBe(400);

    for (const bad of ["limit=0", "limit=101", "limit=abc", "cursor=-1", "cursor=abc"]) {
      const response = await app.inject({ method: "GET", url: `/search?q=vacation&${bad}`, headers: authHeader });
      expect(response.statusCode, bad).toBe(400);
      expect(response.json().error).toMatchObject({ code: "bad_request" });
    }

    const fine = await app.inject({ method: "GET", url: "/search?q=vacation&limit=100&cursor=0", headers: authHeader });
    expect(fine.statusCode).toBe(200);
  });

  it("degrades to full-text results with a warning when the embedding provider is down — the module's own behaviour, unchanged", async () => {
    await seedCorpus();
    const appWithFailingEmbeddings = createServer(deps(storePath, { embeddingProvider: createFailingEmbeddingProvider() }));

    const failing = await appWithFailingEmbeddings.inject({ method: "GET", url: "/search?q=vacation%20leave", headers: authHeader });
    expect(failing.statusCode).toBe(200);
    expect(failing.json().usedEmbeddings).toBe(false);
    expect(failing.json().warning).toContain("full-text");
    // Full-text still finds the vacation records.
    expect(failing.json().results.map((result: { record: { text: string } }) => result.record.text).every((text: string) => text.includes("vacation"))).toBe(true);
  });
});

describe("GET /knowledge — what this duo knows (#175)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  /** A surviving Q/A pair from `source`, ingested through the real two-phase pipeline so an import run is recorded alongside it. */
  function ingestQaThread(source: string, threadId: string, question: string, answer: string): void {
    ingestRecords(storePath, PASSPHRASE, [
      record({ source, kind: "question_to_me", author: "other", text: question, threadId }),
      record({ source, kind: "my_answer", author: "me", text: answer, threadId }),
    ]);
  }

  it("composes the stored facts on a populated store: counts by source, the recorded import, the portrait's corpus verdict, rules, providers, usage", async () => {
    ingestQaThread("paste", "t1", "what is the leave policy?", "five days per quarter");
    ingestQaThread("slack-export", "s1", "when do deploys freeze?", "deploys freeze on fridays");
    const dir = join(tempDir(), "duo");
    const { pairs } = await extractQaPairs([
      record({ source: "paste", kind: "question_to_me", author: "other", text: "what is the leave policy?", threadId: "t1" }),
      record({ source: "paste", kind: "my_answer", author: "me", text: "five days per quarter", threadId: "t1" }),
    ]);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId: "topic-leave" })));
    writeTopicsFile(dir, [{ id: "topic-leave", label: "Leave policy", createdAt: new Date().toISOString() }]);
    writeRuleByHand(storePath, PASSPHRASE, dir, "leave", "five days per quarter");

    const response = await app.inject({ method: "GET", url: "/knowledge", headers: authHeader });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.records).toEqual({ total: 4, bySource: { paste: 2, "slack-export": 2 } });
    // The last import is the second thread's run — the fact ingestRecords
    // recorded, not a derived timestamp.
    expect(body.lastImport).toMatchObject({ staged: 2, written: 2, alreadyPresent: 0 });
    // The portrait's own verdict, not a recomputation: the corpus slice is
    // byte-identical to GET /mirror/portrait's fields.
    expect(body.corpus.totalQuestions).toBe(1);
    expect(body.corpus.topicBreakdown).toEqual([{ topicId: "topic-leave", label: "Leave policy", count: 1, share: 1 }]);
    expect(body.rules.byReviewStatus).toEqual({ pending: 0, approved: 1, rejected: 0, superseded: 0 });
    // The daemon's configured providers, echoed — deps() wires the fake
    // embedding provider and no inference provider.
    expect(body.providers).toEqual({ inference: null, embedding: { name: "fake", model: "fake-embed" } });
    expect(body.sharedUsage.totalQuestions).toBe(0);
  });

  it("a fresh store still answers 200 — the honest empty picture, thin corpus verdict included", async () => {
    const response = await app.inject({ method: "GET", url: "/knowledge", headers: authHeader });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.records).toEqual({ total: 0, bySource: {} });
    expect(body.lastImport).toBeNull();
    expect(body.corpus.tooThin).toBe(true);
    expect(typeof body.corpus.minimumQuestionsToCharacterize).toBe("number");
    expect(body.corpus.topicBreakdown).toEqual([]);
    expect(body.rules.byReviewStatus).toEqual({ pending: 0, approved: 0, rejected: 0, superseded: 0 });
    expect(body.sharedUsage.summary).toBe("The shared duo is not being used.");
  });

  it("is an owner route: an ask token is refused like any other", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const response = await app.inject({ method: "GET", url: "/knowledge", headers: { authorization: `Bearer ${minted.token}` } });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /knowledge/evidence/:recordId/exclude and /restore, GET /knowledge/evidence/excluded (duo#272)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("GET /knowledge/evidence/excluded is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/knowledge/evidence/excluded", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ excluded: [] });
  });

  it("excludes a record from the Why panel's evidence, then lists and restores it", async () => {
    const answer = record({ text: "five days per quarter, per the vacation policy" });
    writeRecords(storePath, PASSPHRASE, [answer]);

    const exclude = await app.inject({ method: "POST", url: `/knowledge/evidence/${answer.id}/exclude`, headers: authHeader });
    expect(exclude.statusCode).toBe(200);
    expect(exclude.json()).toEqual({ excluded: true });

    const listed = await app.inject({ method: "GET", url: "/knowledge/evidence/excluded", headers: authHeader });
    expect(listed.json()).toEqual({ excluded: [{ recordId: answer.id, excludedAt: expect.any(String), label: answer.text }] });

    // the record itself is untouched — still readable from the corpus, exactly
    // as #272 intends: excluding stops future citation, it is not deletion.
    expect(withDatabase(storePath, PASSPHRASE, false, (db) => db.prepare("SELECT id FROM records WHERE id = ?").get(answer.id))).toBeTruthy();

    const restore = await app.inject({ method: "POST", url: `/knowledge/evidence/${answer.id}/restore`, headers: authHeader });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toEqual({ excluded: false });

    const listedAfterRestore = await app.inject({ method: "GET", url: "/knowledge/evidence/excluded", headers: authHeader });
    expect(listedAfterRestore.json()).toEqual({ excluded: [] });
  });

  it("excluding, and restoring, an unknown record id is a harmless no-op rather than a 404", async () => {
    const exclude = await app.inject({ method: "POST", url: "/knowledge/evidence/no-such-record/exclude", headers: authHeader });
    expect(exclude.statusCode).toBe(200);
    const restore = await app.inject({ method: "POST", url: "/knowledge/evidence/no-such-record/restore", headers: authHeader });
    expect(restore.statusCode).toBe(200);
  });

  it("is an owner surface: an ask token is refused on all three routes", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const askHeader = { authorization: `Bearer ${minted.token}` };
    const list = await app.inject({ method: "GET", url: "/knowledge/evidence/excluded", headers: askHeader });
    expect(list.statusCode).toBe(401);
    const exclude = await app.inject({ method: "POST", url: "/knowledge/evidence/some-id/exclude", headers: askHeader });
    expect(exclude.statusCode).toBe(401);
    const restore = await app.inject({ method: "POST", url: "/knowledge/evidence/some-id/restore", headers: askHeader });
    expect(restore.statusCode).toBe(401);
  });
});

describe("GET/POST/DELETE /mirror/pinned-answers — pin exact wording over HTTP (duo#275)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("GET /mirror/pinned-answers is empty on a fresh store", async () => {
    const response = await app.inject({ method: "GET", url: "/mirror/pinned-answers", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pinnedAnswers: [] });
  });

  it("creates, lists, edits and deletes a pinned answer", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/mirror/pinned-answers",
      headers: authHeader,
      payload: { pattern: "vacation leave", answerText: "Ten days a year.", sourceLabel: "pinned from #general" },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json();
    expect(created).toMatchObject({ pattern: "vacation leave", answerText: "Ten days a year.", sourceLabel: "pinned from #general" });

    const listed = await app.inject({ method: "GET", url: "/mirror/pinned-answers", headers: authHeader });
    expect(listed.json()).toEqual({ pinnedAnswers: [created] });

    const edited = await app.inject({
      method: "POST",
      url: `/mirror/pinned-answers/${created.id}/edit`,
      headers: authHeader,
      payload: { answerText: "Twelve days a year." },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: created.id, pattern: "vacation leave", answerText: "Twelve days a year." });

    const deleted = await app.inject({ method: "DELETE", url: `/mirror/pinned-answers/${created.id}`, headers: authHeader });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const listedAfterDelete = await app.inject({ method: "GET", url: "/mirror/pinned-answers", headers: authHeader });
    expect(listedAfterDelete.json()).toEqual({ pinnedAnswers: [] });
  });

  it("400s creating with a missing or blank pattern/answerText", async () => {
    const missing = await app.inject({ method: "POST", url: "/mirror/pinned-answers", headers: authHeader, payload: { pattern: "a" } });
    expect(missing.statusCode).toBe(400);

    const blank = await app.inject({
      method: "POST",
      url: "/mirror/pinned-answers",
      headers: authHeader,
      payload: { pattern: "   ", answerText: "b" },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("404s editing an unknown pinned answer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mirror/pinned-answers/no-such-id/edit",
      headers: authHeader,
      payload: { pattern: "x" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("DELETE on an unknown id is a harmless no-op, not a 404", async () => {
    const response = await app.inject({ method: "DELETE", url: "/mirror/pinned-answers/no-such-id", headers: authHeader });
    expect(response.statusCode).toBe(200);
  });

  it("is an owner surface: an ask token is refused on every route", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const askHeader = { authorization: `Bearer ${minted.token}` };
    const list = await app.inject({ method: "GET", url: "/mirror/pinned-answers", headers: askHeader });
    expect(list.statusCode).toBe(401);
    const create = await app.inject({
      method: "POST",
      url: "/mirror/pinned-answers",
      headers: askHeader,
      payload: { pattern: "a", answerText: "b" },
    });
    expect(create.statusCode).toBe(401);
    const edit = await app.inject({ method: "POST", url: "/mirror/pinned-answers/some-id/edit", headers: askHeader, payload: { pattern: "a" } });
    expect(edit.statusCode).toBe(401);
    const remove = await app.inject({ method: "DELETE", url: "/mirror/pinned-answers/some-id", headers: askHeader });
    expect(remove.statusCode).toBe(401);
  });

  it("a draft that quotes a pinned answer carries it in sources, so the client's Why panel can say so", async () => {
    await app.inject({
      method: "POST",
      url: "/mirror/pinned-answers",
      headers: authHeader,
      payload: { pattern: "parking policy", answerText: "Visitor parking is on level 2." },
    });

    const result = await draftReply(
      storePath,
      PASSPHRASE,
      join(tempDir(), "duo"),
      "what's the parking policy here",
      null,
      createFakeEmbeddingProvider(),
      undefined,
      loadConfig().confidence,
    );
    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("expected a draft");
    expect(result.text).toBe("Visitor parking is on level 2.");
    expect(result.sources).toEqual([{ kind: "pinned", id: expect.any(String), label: expect.stringContaining("parking policy") }]);
  });
});

describe("GET /devices and POST /devices/:id/revoke — paired devices over HTTP (#177)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let deviceId: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    deviceId = paired.id;
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("GET /devices answers 'which devices can read my corpus right now': id, name, createdAt, lastSeenAt — never the token or its hash", async () => {
    const phone = createDeviceToken(storePath, PASSPHRASE, "phone");
    // The phone has actually talked to the daemon, so its last_seen_at is
    // stamped through the real auth path (a device's first request always
    // touches; the 60s throttle only applies after).
    const seen = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${phone.token}` } });
    expect(seen.statusCode).toBe(200);

    const response = await app.inject({ method: "GET", url: "/devices", headers: authHeader });
    expect(response.statusCode).toBe(200);
    // The same read `duo pair list` makes, verbatim — the route adds nothing.
    expect(response.json()).toEqual(listDeviceTokens(storePath, PASSPHRASE));

    const byName = Object.fromEntries(response.json().map((device: { name: string }) => [device.name, device]));
    expect(byName.phone.lastSeenAt).not.toBeNull();
    expect(byName.phone.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Never the token or its hash: the DeviceToken shape has no field that
    // could carry either, and the raw tokens appear nowhere in the payload.
    expect(Object.keys(byName.phone).sort()).toEqual(["createdAt", "id", "lastSeenAt", "name", "revokedAt"]);
    expect(response.body).not.toContain(phone.token);
    expect(response.body).not.toContain(authHeader.authorization.slice("Bearer ".length));
  });

  it("is an owner route: an ask token is refused on both, like any other", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const askHeader = { authorization: `Bearer ${minted.token}` };
    const list = await app.inject({ method: "GET", url: "/devices", headers: askHeader });
    expect(list.statusCode).toBe(401);
    const revoke = await app.inject({ method: "POST", url: "/devices/some-device-id/revoke", headers: askHeader });
    expect(revoke.statusCode).toBe(401);
  });

  it("a device revoked over HTTP stops authenticating immediately — the route evicts the verification cache the same tick, the window an out-of-process CLI revoke can only wait out", async () => {
    const phone = createDeviceToken(storePath, PASSPHRASE, "phone");
    // Warm the 5-second verification cache exactly as a polling client
    // would — without same-tick eviction, the assertion after the revoke
    // would still be 200 (the documented staleness window).
    const before = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${phone.token}` } });
    expect(before.statusCode).toBe(200);

    const revoked = await app.inject({ method: "POST", url: `/devices/${phone.id}/revoke`, headers: authHeader });
    expect(revoked.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/duos", headers: { authorization: `Bearer ${phone.token}` } });
    expect(after.statusCode).toBe(401);
  });

  it("revoke returns the updated device with revokedAt set — the row stays listed, exactly what `duo pair list` shows", async () => {
    const phone = createDeviceToken(storePath, PASSPHRASE, "phone");
    const response = await app.inject({ method: "POST", url: `/devices/${phone.id}/revoke`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: phone.id, name: "phone", revokedAt: expect.any(String) });

    const listed = await app.inject({ method: "GET", url: "/devices", headers: authHeader });
    expect(listed.json().find((device: { id: string }) => device.id === phone.id).revokedAt).not.toBeNull();
  });

  it("revoking an unknown id 404s naming it; revoking twice is the same no-op `duo pair revoke` documents", async () => {
    const missing = await app.inject({ method: "POST", url: "/devices/not-a-real-id/revoke", headers: authHeader });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toContain("not-a-real-id");

    const phone = createDeviceToken(storePath, PASSPHRASE, "phone");
    expect((await app.inject({ method: "POST", url: `/devices/${phone.id}/revoke`, headers: authHeader })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/devices/${phone.id}/revoke`, headers: authHeader })).statusCode).toBe(200);
  });

  it("the last device revoking itself is allowed and cuts itself off — and the owner still re-pairs from the Mac with `duo pair`", async () => {
    // This describe's own device is the only one paired, and it revokes
    // itself with its own token — deliberately (see the route's doc
    // comment): pairing stays a physical act at the machine holding the
    // corpus, so there is no lockout to guard against.
    const selfRevoke = await app.inject({ method: "POST", url: `/devices/${deviceId}/revoke`, headers: authHeader });
    expect(selfRevoke.statusCode).toBe(200);

    // Self-revocation really cuts the caller off: its own cached
    // verification was evicted too, so the very next request is refused.
    const after = await app.inject({ method: "GET", url: "/devices", headers: authHeader });
    expect(after.statusCode).toBe(401);

    // `duo pair` at the Mac mints a working token on the spot.
    const rePaired = createDeviceToken(storePath, PASSPHRASE, "mac-again");
    const fresh = await app.inject({ method: "GET", url: "/devices", headers: { authorization: `Bearer ${rePaired.token}` } });
    expect(fresh.statusCode).toBe(200);
    // The revoked row stays — plus the re-pair.
    expect(fresh.json()).toHaveLength(2);
  });
});

describe("GET /channels — what this duo is reachable through (#171)", () => {
  function adapter(kind: string, label: string, status: () => Promise<{ state: "connected" | "failed"; reason?: string; lastActivityAt: string | null }>): ChannelAdapter {
    return { channelKind: kind, label, status, async deliver() {} };
  }

  it("returns one row per configured channel: kind, adapter-supplied label, state, last activity, mute state", async () => {
    const storePath = initStore();
    const app = createServer({
      ...deps(storePath),
      channelAdapters: [
        adapter("slack", "Acme Slack", async () => ({ state: "connected", lastActivityAt: "2026-09-20T10:00:00.000Z" })),
        adapter("email", "Work inbox", async () => ({ state: "failed", reason: "password rejected — re-authenticate where the credentials live", lastActivityAt: "2026-09-18T09:00:00.000Z" })),
      ],
    });
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const response = await app.inject({ method: "GET", url: "/channels", headers: { authorization: `Bearer ${paired.token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { kind: "slack", label: "Acme Slack", state: "connected", lastActivityAt: "2026-09-20T10:00:00.000Z", muted: false },
      {
        kind: "email",
        label: "Work inbox",
        state: "failed",
        reason: "password rejected — re-authenticate where the credentials live",
        lastActivityAt: "2026-09-18T09:00:00.000Z",
        muted: false,
      },
    ]);
  });

  it("no channel configured is a 200 with an empty list — a supported configuration, not an error", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const response = await app.inject({ method: "GET", url: "/channels", headers: { authorization: `Bearer ${paired.token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("a mute made with the CLI's own function shows here — one store, not two", async () => {
    const storePath = initStore();
    const app = createServer({ ...deps(storePath), channelAdapters: [adapter("slack", "Acme Slack", async () => ({ state: "connected", lastActivityAt: null }))] });
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    const before = await app.inject({ method: "GET", url: "/channels", headers: authHeader });
    expect(before.json()[0].muted).toBe(false);

    // What `duo mentions mute slack` writes — same duoDir deps() hands the server.
    muteChannel(join(tempDir(), "duo"), "slack");

    const after = await app.inject({ method: "GET", url: "/channels", headers: authHeader });
    expect(after.json()[0].muted).toBe(true);
  });

  it("is an owner route: an ask token is refused like any other", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const response = await app.inject({ method: "GET", url: "/channels", headers: { authorization: `Bearer ${minted.token}` } });
    expect(response.statusCode).toBe(401);
  });
});

describe("channel policy over HTTP — per-channel, per-thread (#172)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("GET /channels/policy reads the one store — nothing muted is the honest empty policy", async () => {
    const response = await app.inject({ method: "GET", url: "/channels/policy", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ muted: [], mutedThreads: [] });
  });

  it("a channel mute set over HTTP is the same mute the CLI reads — one store, both directions", async () => {
    const muted = await app.inject({ method: "POST", url: "/channels/policy/mute", headers: authHeader, payload: { channel: "#eng-support" } });
    expect(muted.statusCode).toBe(200);
    expect(muted.json()).toEqual({ muted: ["#eng-support"], mutedThreads: [] });
    // The CLI's own read of the one store (what `duo mentions muted` prints).
    expect(readMutedChannels(join(tempDir(), "duo"))).toEqual(["#eng-support"]);

    const unmuted = await app.inject({ method: "POST", url: "/channels/policy/unmute", headers: authHeader, payload: { channel: "#eng-support" } });
    expect(unmuted.statusCode).toBe(200);
    expect(unmuted.json()).toEqual({ muted: [], mutedThreads: [] });
  });

  it("mutes a thread within a channel without muting the channel, and reverses exactly that", async () => {
    const muted = await app.inject({
      method: "POST",
      url: "/channels/policy/mute",
      headers: authHeader,
      payload: { channel: "#eng-support", threadId: "C0123456789.1660000000" },
    });
    expect(muted.statusCode).toBe(200);
    expect(muted.json()).toEqual({ muted: [], mutedThreads: [{ channel: "#eng-support", threadId: "C0123456789.1660000000" }] });

    // Unmuting the channel is an honest no-op — the thread mute is below it.
    const channelUnmute = await app.inject({ method: "POST", url: "/channels/policy/unmute", headers: authHeader, payload: { channel: "#eng-support" } });
    expect(channelUnmute.json()).toEqual({ muted: [], mutedThreads: [{ channel: "#eng-support", threadId: "C0123456789.1660000000" }] });

    const threadUnmute = await app.inject({
      method: "POST",
      url: "/channels/policy/unmute",
      headers: authHeader,
      payload: { channel: "#eng-support", threadId: "C0123456789.1660000000" },
    });
    expect(threadUnmute.json()).toEqual({ muted: [], mutedThreads: [] });
  });

  it("mutes made by the CLI's own functions read back identically over HTTP", async () => {
    const duoDir = join(tempDir(), "duo");
    muteChannel(duoDir, "#general");
    muteThread(duoDir, "#eng-support", "C0123456789.1660000000");

    const response = await app.inject({ method: "GET", url: "/channels/policy", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      muted: ["#general"],
      mutedThreads: [{ channel: "#eng-support", threadId: "C0123456789.1660000000" }],
    });
  });

  it("rejects a malformed target: missing or non-string channel, or a \"/\" — the separator scopes a thread, it cannot also be data", async () => {
    const missing = await app.inject({ method: "POST", url: "/channels/policy/mute", headers: authHeader, payload: {} });
    expect(missing.statusCode).toBe(400);
    const nonString = await app.inject({ method: "POST", url: "/channels/policy/mute", headers: authHeader, payload: { channel: 42 } });
    expect(nonString.statusCode).toBe(400);
    const slash = await app.inject({ method: "POST", url: "/channels/policy/mute", headers: authHeader, payload: { channel: "#eng/support" } });
    expect(slash.statusCode).toBe(400);
    expect(slash.json().error.message).toContain("/");

    const threadSlash = await app.inject({
      method: "POST",
      url: "/channels/policy/mute",
      headers: authHeader,
      payload: { channel: "#eng-support", threadId: "C012/456789" },
    });
    expect(threadSlash.statusCode).toBe(400);
    expect(readMutedChannels(join(tempDir(), "duo"))).toEqual([]);
  });

  it("is an owner route: an ask token is refused on the read and both writes", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const askHeader = { authorization: `Bearer ${minted.token}` };
    const read = await app.inject({ method: "GET", url: "/channels/policy", headers: askHeader });
    expect(read.statusCode).toBe(401);
    const mute = await app.inject({ method: "POST", url: "/channels/policy/mute", headers: askHeader, payload: { channel: "c" } });
    expect(mute.statusCode).toBe(401);
    const unmute = await app.inject({ method: "POST", url: "/channels/policy/unmute", headers: askHeader, payload: { channel: "c" } });
    expect(unmute.statusCode).toBe(401);
  });
});

describe("off-the-record rooms over HTTP (guangshinhaha/duo#274)", () => {
  const ROOM = "!a:workspace";
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("GET reads false for a room never marked", async () => {
    const response = await app.inject({ method: "GET", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ roomId: ROOM, offTheRecord: false, decidedAt: null });
  });

  it("POST marks the room, GET then reads it back, and DELETE lifts the marker", async () => {
    const marked = await app.inject({ method: "POST", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ roomId: ROOM, offTheRecord: true });
    expect(typeof marked.json().decidedAt).toBe("string");

    const read = await app.inject({ method: "GET", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(read.json()).toMatchObject({ roomId: ROOM, offTheRecord: true });

    const cleared = await app.inject({ method: "DELETE", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ roomId: ROOM, offTheRecord: false, wasOn: true });

    const readAfter = await app.inject({ method: "GET", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(readAfter.json()).toMatchObject({ roomId: ROOM, offTheRecord: false });
  });

  it("DELETE on a room never marked reports wasOn: false, not an error", async () => {
    const cleared = await app.inject({ method: "DELETE", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ roomId: ROOM, offTheRecord: false, wasOn: false });
  });

  it("POST purges a pending standing-order candidate already queued from this room", async () => {
    const draftId = appendDraft(storePath, PASSPHRASE, {
      question: "what is the policy?",
      threadContext: null,
      draftText: null,
      escalated: true,
      escalationReason: "thin",
      confidenceScore: 0,
      sources: [],
      provenance: { origin: "channel", channelKind: "workspace", askerRef: "@bob:workspace", threadId: ROOM, permalink: null },
    });
    const candidateId = queueStandingOrderCandidate(storePath, PASSPHRASE, draftId, "the policy is X");

    const marked = await app.inject({ method: "POST", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(marked.json().purged).toMatchObject({ draftIds: [draftId], standingOrderCandidatesRejected: 1 });

    const candidate = listStandingOrderCandidates(storePath, PASSPHRASE).find((c) => c.id === candidateId);
    expect(candidate?.status).toBe("rejected");
  });

  it("is idempotent to mark twice — the second POST purges nothing new and keeps the original decidedAt", async () => {
    const first = await app.inject({ method: "POST", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    const second = await app.inject({ method: "POST", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: authHeader });
    expect(second.json().decidedAt).toBe(first.json().decidedAt);
  });

  it("is an owner route: an ask token is refused on the read, the mark, and the clear", async () => {
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const askHeader = { authorization: `Bearer ${minted.token}` };
    expect((await app.inject({ method: "GET", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: askHeader })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: askHeader })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/workspace/rooms/${ROOM}/off-the-record`, headers: askHeader })).statusCode).toBe(401);
  });
});

describe("escalations over HTTP — digest, history, rate (#178)", () => {
  const confidenceConfig = loadConfig().confidence;

  /** Escalates unconditionally: no evidence and no rule exist for these questions in a fresh store, so draftReply always returns kind "escalation" — escalation-digest.test.ts's own helper, over the same fake provider deps() uses. */
  async function escalate(storePath: string, question: string): Promise<string> {
    const result = await draftReply(storePath, PASSPHRASE, join(tempDir(), "duo"), question, null, createFakeEmbeddingProvider(), undefined, confidenceConfig);
    if (result.kind !== "escalation") {
      throw new Error(`expected an escalation, got ${result.kind}`);
    }
    return result.draftId;
  }

  it("POST /escalations/digest returns what runEscalationsDigest produces — items in place, nothing sent when nothing is new", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    const empty = await app.inject({ method: "POST", url: "/escalations/digest", headers: authHeader, payload: {} });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ sent: false, items: [] });

    await escalate(storePath, "how much vacation leave do I get");
    await escalate(storePath, "what is the printer's IP address");

    const sent = await app.inject({ method: "POST", url: "/escalations/digest", headers: authHeader, payload: {} });
    expect(sent.statusCode).toBe(200);
    const body = sent.json();
    expect(body.sent).toBe(true);
    expect(typeof body.digestId).toBe("string");
    expect(body.items.map((item: { question: string }) => item.question)).toEqual(
      expect.arrayContaining(["how much vacation leave do I get", "what is the printer's IP address"]),
    );
    for (const item of body.items) {
      expect(item.escalationReason).toEqual(expect.any(String));
      expect(item.escalationReason.length).toBeGreaterThan(0);
    }

    // The sent digest is a real row the CLI's own history reads — one
    // store, one code path, not a route-side copy.
    expect(listEscalationDigests(storePath, PASSPHRASE).map((digest) => digest.id)).toContain(body.digestId);

    // Nothing new since: the honest empty result, nothing re-sent.
    const again = await app.inject({ method: "POST", url: "/escalations/digest", headers: authHeader, payload: {} });
    expect(again.json()).toEqual({ sent: false, items: [] });
    expect(listEscalationDigests(storePath, PASSPHRASE)).toHaveLength(1);
  });

  it("GET /escalations/history pages with limit and cursor, oldest first", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    const sentIds: string[] = [];
    for (const question of ["how much vacation leave do I get", "what is the printer's IP address", "which printer does floor 3 use"]) {
      await escalate(storePath, question);
      const sent = await app.inject({ method: "POST", url: "/escalations/digest", headers: authHeader, payload: {} });
      sentIds.push(sent.json().digestId);
    }
    expect(sentIds).toHaveLength(3);

    // Default: everything, oldest first (createdAt non-decreasing — the
    // three digests share a table ordered by created_at, id).
    const all = await app.inject({ method: "GET", url: "/escalations/history", headers: authHeader });
    expect(all.statusCode).toBe(200);
    const allBody = all.json();
    expect(allBody.map((digest: { id: string }) => digest.id).sort()).toEqual([...sentIds].sort());
    for (let i = 1; i < allBody.length; i += 1) {
      expect(allBody[i].createdAt >= allBody[i - 1].createdAt).toBe(true);
    }
    expect(allBody.map((digest: { itemCount: number }) => digest.itemCount)).toEqual([1, 1, 1]);

    // A page: limit respected. The two pages are disjoint and together are
    // the whole set — cursor advances, no row repeats, none is lost.
    const pageOne = await app.inject({ method: "GET", url: "/escalations/history?limit=2", headers: authHeader });
    expect(pageOne.statusCode).toBe(200);
    expect(pageOne.json()).toHaveLength(2);

    const pageTwo = await app.inject({ method: "GET", url: "/escalations/history?limit=2&cursor=2", headers: authHeader });
    expect(pageTwo.statusCode).toBe(200);
    expect(pageTwo.json()).toHaveLength(1);

    const pageOneIds = pageOne.json().map((digest: { id: string }) => digest.id);
    const pageTwoIds = pageTwo.json().map((digest: { id: string }) => digest.id);
    expect(pageOneIds.some((id: string) => pageTwoIds.includes(id))).toBe(false);
    expect([...pageOneIds, ...pageTwoIds].sort()).toEqual([...sentIds].sort());

    // Cursor past the end is an honest empty page, not an error.
    const beyond = await app.inject({ method: "GET", url: "/escalations/history?limit=2&cursor=8", headers: authHeader });
    expect(beyond.statusCode).toBe(200);
    expect(beyond.json()).toEqual([]);
  });

  it("GET /escalations/history validates limit and cursor exactly like /search", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    for (const url of [
      "/escalations/history?limit=0",
      "/escalations/history?limit=101",
      "/escalations/history?limit=abc",
      "/escalations/history?cursor=-1",
      "/escalations/history?cursor=abc",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: authHeader });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.message, url).toMatch(/limit|cursor/);
    }
  });

  it("GET /escalations/rate returns the same figure the CLI reports", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    // Two ordinary escalations and one objectively-severe one ("production
    // is down" is one of urgency.ts's own signals) — 1/3 urgent.
    await escalate(storePath, "how much vacation leave do I get");
    await escalate(storePath, "what is the printer's IP address");
    await escalate(storePath, "what do I do — production is down");

    const response = await app.inject({ method: "GET", url: "/escalations/rate", headers: authHeader });
    expect(response.statusCode).toBe(200);
    // Byte-identical to what `duo escalations rate` prints from — the same
    // function, called now, over the same store.
    expect(response.json()).toEqual(escalationUrgencyRate(storePath, PASSPHRASE));
    expect(response.json()).toEqual({ total: 3, urgent: 1, rate: 1 / 3 });
  });

  it("all three routes are owner routes: an ask token is refused on each", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const authHeader = { authorization: `Bearer ${minted.token}` };
    const digest = await app.inject({ method: "POST", url: "/escalations/digest", headers: authHeader, payload: {} });
    const history = await app.inject({ method: "GET", url: "/escalations/history", headers: authHeader });
    const rate = await app.inject({ method: "GET", url: "/escalations/rate", headers: authHeader });
    expect(digest.statusCode).toBe(401);
    expect(history.statusCode).toBe(401);
    expect(rate.statusCode).toBe(401);
  });
});
describe("GET /mirror/refusals and GET /mirror/rules/:id — refusals and rule evidence over HTTP (#182)", () => {
  /** rule-review.test.ts's seedRule, over this file's own record() helper: three consistent exchanges under one topic, so induction derives a confirmed rule citing all three pairs. */
  async function seedConfirmedRule(storePath: string, topicId: string): Promise<void> {
    const answerText = "five days per quarter, vacation policy";
    const records = [0, 1, 2].flatMap((i) => {
      const question = record({ kind: "question_to_me", author: "other", text: "a question", threadId: `q-${topicId}-${i}` });
      const answer = record({ kind: "my_answer", author: "me", text: answerText, threadId: question.threadId });
      return [question, answer];
    });
    writeRecords(storePath, PASSPHRASE, records);
    const { pairs } = await extractQaPairs(records);
    writeQaPairs(storePath, PASSPHRASE, pairs.map((pair) => ({ ...pair, topicId })));
    await runRuleInduction(storePath, PASSPHRASE, createFakeEmbeddingProvider());
  }

  it("GET /mirror/refusals returns what `duo mirror refusals list` prints: the decided state plus every recorded refusal", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    // What `duo mirror refusals add` writes — the CLI's own function, over
    // the same duoDir deps() hands the server.
    upsertRefusal(join(tempDir(), "duo"), "Salary bands", "comp is between me and HR");
    upsertRefusal(join(tempDir(), "duo"), "Performance reviews", "those conversations stay verbal");

    const response = await app.inject({ method: "GET", url: "/mirror/refusals", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      decided: true,
      refusals: [
        { heading: "Salary bands", reason: "comp is between me and HR" },
        { heading: "Performance reviews", reason: "those conversations stay verbal" },
      ],
    });
  });

  it("no refusals file at all is the undecided state — a 200, not an error — and confirm-none records the decision with zero entries", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    const undecided = await app.inject({ method: "GET", url: "/mirror/refusals", headers: authHeader });
    expect(undecided.statusCode).toBe(200);
    expect(undecided.json()).toEqual({ decided: false, refusals: [] });

    // What `duo mirror refusals confirm-none` writes — the CLI's own function.
    confirmNoRefusals(join(tempDir(), "duo"));

    const decided = await app.inject({ method: "GET", url: "/mirror/refusals", headers: authHeader });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toEqual({ decided: true, refusals: [] });
  });

  it("GET /mirror/rules/:id returns the rule with the evidence exchanges behind it — enough to show the owner why it exists", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    await seedConfirmedRule(storePath, "topic-leave");
    const ruleId = listRules(storePath, PASSPHRASE)[0].id;

    const response = await app.inject({ method: "GET", url: `/mirror/rules/${ruleId}`, headers: authHeader });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rule).toMatchObject({ id: ruleId, origin: "derived" });
    // The exchanges its citations point to — the entire "why does my duo
    // believe this" answer, on the wire, not left for a client to fetch
    // record-by-record.
    expect(body.evidence).toHaveLength(3);
    for (const exchange of body.evidence) {
      expect(exchange.qaPairId).toEqual(expect.any(String));
      expect(exchange.questionText).toBe("a question");
      expect(exchange.answerText).toBe("five days per quarter, vacation policy");
    }
  });

  it("GET /mirror/rules/:id 404s naming the id for an unknown rule", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    const response = await app.inject({ method: "GET", url: "/mirror/rules/not-a-real-id", headers: authHeader });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("not-a-real-id");
  });

  it("GET /mirror/refusals is an owner route: an ask token is refused", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const response = await app.inject({ method: "GET", url: "/mirror/refusals", headers: { authorization: `Bearer ${minted.token}` } });
    expect(response.statusCode).toBe(401);
  });
});

describe("actions over HTTP — the T4 confirmation moment and the attempt log (#180)", () => {
  /** What `duo actions register` writes for the one tier that can never be autonomous: audience "external" classifies T4 whatever the other properties say (registry.ts's own decisive rule). */
  function registerT4Action(storePath: string): void {
    registerAction(storePath, PASSPHRASE, {
      id: "file-court-response",
      description: "File a response with the court on the owner's behalf",
      reversible: false,
      obligates: true,
      audience: "external",
      topicIds: ["evictions"],
    });
  }

  /** What `duo actions t4 request` writes — the CLI's own function, over the same store the server reads. */
  function stageT4Request(storePath: string, reasoning: string): string {
    return createT4Request(storePath, PASSPHRASE, { actionId: "file-court-response", topicId: "evictions", reasoning }).id;
  }

  it("GET /actions/t4/pending returns each awaiting request with everything the owner needs to judge it — what will happen, to what, irreversibly or not", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    // Nothing staged: the honest empty list, not an error.
    const empty = await app.inject({ method: "GET", url: "/actions/t4/pending", headers: authHeader });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    registerT4Action(storePath);
    const staged = stageT4Request(storePath, "the filing deadline is tomorrow and the owner said to handle it");

    const response = await app.inject({ method: "GET", url: "/actions/t4/pending", headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    const body = response.json()[0];
    expect(body).toMatchObject({
      id: staged,
      actionId: "file-court-response",
      topicId: "evictions",
      reasoning: "the filing deadline is tomorrow and the owner said to handle it",
      createdAt: expect.any(String),
      executedAt: null,
    });
    // The judgement facts, joined from the same registry row the guard
    // checked at staging: what will happen (description), to what
    // (topicId, above), and irreversibly or not (reversible).
    expect(body.action).toMatchObject({
      id: "file-court-response",
      description: "File a response with the court on the owner's behalf",
      reversible: false,
      obligates: true,
      audience: "external",
      tier: "T4",
    });
  });

  it("POST /actions/t4/:id/confirm proceeds exactly as the CLI confirmation does — and is recorded against the device that gave it", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "phone");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    registerT4Action(storePath);
    const httpRequestId = stageT4Request(storePath, "confirmed from the phone");
    const cliRequestId = stageT4Request(storePath, "confirmed at the Mac");

    const confirmed = await app.inject({ method: "POST", url: `/actions/t4/${httpRequestId}/confirm`, headers: authHeader });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ id: httpRequestId, executedAt: expect.any(String) });

    // Confirmed means no longer awaiting confirmation.
    const pending = await app.inject({ method: "GET", url: "/actions/t4/pending", headers: authHeader });
    expect(pending.json().map((request: { id: string }) => request.id)).toEqual([cliRequestId]);

    // The CLI's own confirmation — the exact call `duo actions t4 confirm`
    // makes — on the other request. Same mechanism, same exactly-once.
    const cliConfirmed = confirmAndExecuteT4Request(storePath, PASSPHRASE, cliRequestId, () => {});
    expect(cliConfirmed.executedAt).not.toBeNull();

    // Both executions logged one t4_executed attempt each; the only
    // difference between them is that the HTTP confirmation is recorded
    // against the device that gave it.
    const executions = listActionAttempts(storePath, PASSPHRASE).filter((attempt) => attempt.outcome === "t4_executed");
    expect(executions).toHaveLength(2);
    expect(executions.find((attempt) => attempt.detail.requestId === httpRequestId)?.detail).toEqual({ requestId: httpRequestId, confirmedBy: paired.id });
    expect(executions.find((attempt) => attempt.detail.requestId === cliRequestId)?.detail).toEqual({ requestId: cliRequestId });
  });

  it("confirming an unknown request 404s naming it; a second confirmation is refused, never a re-execution", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    registerT4Action(storePath);
    const requestId = stageT4Request(storePath, "once is all it takes");

    const missing = await app.inject({ method: "POST", url: "/actions/t4/not-a-real-id/confirm", headers: authHeader });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toContain("not-a-real-id");

    const first = await app.inject({ method: "POST", url: `/actions/t4/${requestId}/confirm`, headers: authHeader });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/actions/t4/${requestId}/confirm`, headers: authHeader });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toContain("already executed");

    // Exactly one execution was recorded — the guard's exactly-once holds
    // over HTTP exactly as it does at the terminal.
    const executions = listActionAttempts(storePath, PASSPHRASE).filter((attempt) => attempt.outcome === "t4_executed");
    expect(executions).toHaveLength(1);
  });

  it("no other route confirms a T4 request as a side effect — the guard's separateness survives the whole HTTP surface", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    registerT4Action(storePath);
    const requestId = stageT4Request(storePath, "untouched by every other route");

    // Every other owner POST that takes an id, fed the T4 request id: each
    // refuses for its own reason — a different table's not-found — and none
    // of them is a confirmation.
    const review = await app.inject({ method: "POST", url: `/review/${requestId}/approve`, headers: authHeader });
    expect(review.statusCode).toBe(404);
    const outcome = await app.inject({ method: "POST", url: `/drafts/${requestId}/outcome`, headers: authHeader, payload: { outcome: "sent" } });
    expect(outcome.statusCode).toBe(404);
    const ruleApprove = await app.inject({ method: "POST", url: `/mirror/rules/${requestId}/approve`, headers: authHeader });
    expect(ruleApprove.statusCode).toBe(404);
    const deviceRevoke = await app.inject({ method: "POST", url: `/devices/${requestId}/revoke`, headers: authHeader });
    expect(deviceRevoke.statusCode).toBe(404);

    // The id-less owner POSTs do their own work and touch nothing else.
    const digest = await app.inject({ method: "POST", url: "/escalations/digest", headers: authHeader, payload: {} });
    expect(digest.statusCode).toBe(200);

    // Still pending, still never executed.
    const pending = await app.inject({ method: "GET", url: "/actions/t4/pending", headers: authHeader });
    expect(pending.json().map((request: { id: string }) => request.id)).toEqual([requestId]);
    expect(listActionAttempts(storePath, PASSPHRASE).some((attempt) => attempt.outcome === "t4_executed")).toBe(false);
  });

  it("GET /actions/attempts returns exactly what `duo actions attempts` reports, device attribution included", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    registerT4Action(storePath);
    const requestId = stageT4Request(storePath, "an ordinary confirmed request");
    const confirmed = await app.inject({ method: "POST", url: `/actions/t4/${requestId}/confirm`, headers: authHeader });
    expect(confirmed.statusCode).toBe(200);
    // A bypass attempt, so the log spans the guard's outcomes: staging a
    // non-T4 action as T4 is refused and recorded (the module's own
    // refusal — what `duo actions t4 request` on a T2 action hits).
    registerAction(storePath, PASSPHRASE, {
      id: "announce-in-channel",
      description: "Post an announcement in the team channel",
      reversible: true,
      obligates: false,
      audience: "internal",
      topicIds: ["general"],
    });
    expect(() =>
      createT4Request(storePath, PASSPHRASE, { actionId: "announce-in-channel", topicId: "general", reasoning: "trying to jump the gate" }),
    ).toThrow(NotAT4ActionError);

    const response = await app.inject({ method: "GET", url: "/actions/attempts", headers: authHeader });
    expect(response.statusCode).toBe(200);
    // Byte-identical to what `duo actions attempts` prints from — the same
    // function, called now, over the same store.
    expect(response.json()).toEqual(listActionAttempts(storePath, PASSPHRASE));
    // And the log genuinely spans the guard's outcomes: the staged request,
    // its device-attributed execution, and the refused bypass.
    const outcomes = response.json().map((attempt: { outcome: string }) => attempt.outcome);
    expect(outcomes).toContain("requires_human_confirmation");
    expect(outcomes).toContain("t4_executed");
    expect(outcomes).toContain("refused_t4_bypass");
  });

  it("all three routes are owner routes: an ask token is refused on each", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const authHeader = { authorization: `Bearer ${minted.token}` };
    const pending = await app.inject({ method: "GET", url: "/actions/t4/pending", headers: authHeader });
    const attempts = await app.inject({ method: "GET", url: "/actions/attempts", headers: authHeader });
    const confirm = await app.inject({ method: "POST", url: "/actions/t4/some-request-id/confirm", headers: authHeader });
    expect(pending.statusCode).toBe(401);
    expect(attempts.statusCode).toBe(401);
    expect(confirm.statusCode).toBe(401);
  });
});

describe("lifecycle and handover over HTTP — the kill switch outside the terminal (#181)", () => {
  it("POST /lifecycle/end describes first, then ends the duo exactly as the CLI does — and the duo stops answering", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "phone");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    const lifecycleLogPath = join(tempDir(), "lifecycle-runtime", "events.json");

    // Without the confirmation flag the route only describes what would go
    // — `duo lifecycle end`'s own shape — and nothing is deleted.
    const dryRun = await app.inject({ method: "POST", url: "/lifecycle/end", headers: authHeader, payload: { decidedBy: "shin" } });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().confirmed).toBe(false);
    expect(dryRun.json().storePaths.length).toBeGreaterThan(0);
    expect(existsSync(storePath)).toBe(true);
    expect(loadLifecycleLog(lifecycleLogPath)).toEqual([]);

    // With it, the same lifecycle path the CLI runs: the store's whole data
    // directory and duoDir deleted, the end recorded in the lifecycle log
    // by name.
    const ended = await app.inject({ method: "POST", url: "/lifecycle/end", headers: authHeader, payload: { decidedBy: "shin", confirmed: true } });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().confirmed).toBe(true);
    expect(existsSync(storePath)).toBe(false);
    const events = loadLifecycleLog(lifecycleLogPath);
    expect(events.at(-1)).toMatchObject({ eventType: "ended", actor: "shin" });

    // And the duo stops answering: the same paired token that just ended it
    // is now refused on every route, because the store it lived in — tokens
    // and all — is gone. A clean refusal, not a 500.
    const stopped = await app.inject({ method: "GET", url: "/drafts", headers: authHeader });
    expect(stopped.statusCode).toBe(401);
    expect(stopped.json().error.message).toContain("ended or deleted");
  });

  it("a cached client replaying any mutation after an end is refused, never served from the cache", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "phone");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    // Warm the token cache with an ordinary read, then end the duo — the
    // deletion must drop the cached verification too, or the very next
    // request would sail through on it.
    const warm = await app.inject({ method: "GET", url: "/devices", headers: authHeader });
    expect(warm.statusCode).toBe(200);
    const ended = await app.inject({ method: "POST", url: "/lifecycle/end", headers: authHeader, payload: { decidedBy: "shin", confirmed: true } });
    expect(ended.statusCode).toBe(200);

    for (const [method, url, payload] of [
      ["POST", "/drafts", { question: "are you still there" }],
      ["POST", "/escalations/digest", {}],
      ["POST", "/channels/policy/mute", { channel: "email" }],
      ["GET", "/audit", undefined],
    ] as const) {
      const replayed = await app.inject({ method, url, headers: authHeader, ...(payload === undefined ? {} : { payload }) });
      expect(replayed.statusCode, `${method} ${url}`).toBe(401);
      expect(replayed.json().error.message, `${method} ${url}`).toContain("ended or deleted");
    }
  });

  it("GET /lifecycle returns the lifecycle record and every transfer's state as it moves", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };
    const duoDir = join(tempDir(), "duo");
    const lifecycleLogPath = join(tempDir(), "lifecycle-runtime", "events.json");

    // A fresh duo: active, no handover ever requested — the honest defaults.
    const fresh = await app.inject({ method: "GET", url: "/lifecycle", headers: authHeader });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({
      lifecycle: {
        status: "active",
        archivedBy: null,
        archivedAt: null,
        orphanedBy: null,
        orphanedAt: null,
        orphanReason: null,
        transferredFrom: null,
        transferredTo: null,
        transferredAt: null,
      },
      transfers: [],
    });

    // An in-flight handover, staged the way `duo continuity transfer initiate` does.
    const request = initiateTransfer(duoDir, lifecycleLogPath, "shin", "sam");
    const staged = await app.inject({ method: "GET", url: "/lifecycle", headers: authHeader });
    expect(staged.json().transfers).toHaveLength(1);
    expect(staged.json().transfers[0]).toMatchObject({
      id: request.id,
      outgoingOwner: "shin",
      receivingOwner: "sam",
      outgoingConfirmed: false,
      receivingConfirmed: false,
      status: "pending",
      completedAt: null,
    });

    // The outgoing owner confirms — half done, still pending.
    confirmTransfer(duoDir, lifecycleLogPath, request.id, "shin");
    const half = await app.inject({ method: "GET", url: "/lifecycle", headers: authHeader });
    expect(half.json().transfers[0]).toMatchObject({ outgoingConfirmed: true, receivingConfirmed: false, status: "pending" });

    // The receiving owner confirms — the handover completes, and the
    // lifecycle record itself carries the transfer history from then on.
    confirmTransfer(duoDir, lifecycleLogPath, request.id, "sam");
    const done = await app.inject({ method: "GET", url: "/lifecycle", headers: authHeader });
    expect(done.json().transfers[0]).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect(done.json().lifecycle).toMatchObject({ status: "active", transferredFrom: "shin", transferredTo: "sam", transferredAt: expect.any(String) });
  });

  it("ending requires naming who decided it — a blank decidedBy is a 400 that deletes nothing", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "mac");
    const authHeader = { authorization: `Bearer ${paired.token}` };

    const refused = await app.inject({ method: "POST", url: "/lifecycle/end", headers: authHeader, payload: { decidedBy: "   ", confirmed: true } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain("decidedBy");
    expect(existsSync(storePath)).toBe(true);
  });

  it("both routes are owner routes: an ask token is refused on each", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const authHeader = { authorization: `Bearer ${minted.token}` };
    const state = await app.inject({ method: "GET", url: "/lifecycle", headers: authHeader });
    const end = await app.inject({ method: "POST", url: "/lifecycle/end", headers: authHeader, payload: { decidedBy: "Sam", confirmed: true } });
    expect(state.statusCode).toBe(401);
    expect(end.statusCode).toBe(401);
    // And nothing was deleted by the refused end.
    expect(existsSync(storePath)).toBe(true);
  });
});

// #176: the first run, from a client — both steps that previously required
// a terminal (`duo import paste`, `duo embed`) become owner routes. The
// import takes the transcript TEXT (file upload is out of scope by the
// issue's own line) down the same parse → work-relevance gate → two-phase
// ingest path the CLI command runs — pinned here by importing the identical
// text through both surfaces and demanding equal summaries, twice, which is
// also AC3's "no new dedupe rule invented at the route". Embedding is not
// request-response-shaped, so POST starts a daemon-held job and GET reports
// its progress; the job drives the same embedRecords the CLI calls, in
// batches, so `embedded` climbs observably instead of jumping once at the
// end.
describe("corpus import and embed over HTTP — the first run without a terminal (#176)", () => {
  // transcript-work.txt's own text, inline: three turns (its continuation
  // line folds into the second turn), judged work-relevant by the same
  // keyword gate every import passes through.
  const WORK_TRANSCRIPT = [
    "Human: Can you help me write the on-call runbook update for the billing outage postmortem?",
    "Assistant: Sure — let's list the incident timeline first, then draft the remediation steps",
    "for the manager review before the deadline.",
    "Human: Good, add a section on the escalation policy too.",
  ].join("\n");

  // transcript-personal.txt's own text — no work signal anywhere.
  const PERSONAL_TRANSCRIPT = [
    "Human: What's a good recipe for a vegan lasagna for my birthday dinner this weekend?",
    "Assistant: Here's a great recipe for a birthday lasagna, plus a wedding cake idea for the honeymoon trip.",
  ].join("\n");

  /** 25 one-line turns → 25 records: the embed job works in batches of 10, so finishing means looping, not one call. */
  function longWorkTranscript(): string {
    const turns: string[] = [];
    for (let i = 0; i < 25; i++) {
      turns.push(`Human: Deadline question ${i} about the billing runbook and the incident escalation policy?`);
    }
    return turns.join("\n");
  }

  function ownerApp(storePath: string, overrides: Partial<ServeDeps> = {}) {
    const app = createServer(deps(storePath, overrides));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    return { app, auth: { authorization: `Bearer ${paired.token}` } };
  }

  /** Polls GET /corpus/embed until `state` appears (the deadline failing the test, not hanging it) — the job advances on its own schedule, never inline in the POST. */
  async function pollEmbedStatus(app: FastifyInstance, auth: { authorization: string }, state: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await app.inject({ method: "GET", url: "/corpus/embed", headers: auth });
      const status = response.json();
      if (status.state === state) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`embed job never reached state "${state}"`);
  }

  it("AC1: imports a pasted transcript over HTTP, returns the count summary, and the records are really in the corpus", async () => {
    const storePath = initStore();
    const { app, auth } = ownerApp(storePath);
    const response = await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: WORK_TRANSCRIPT } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workRelevant: true, written: 3, skipped: 0, discardedAboveCeiling: 0 });

    // "Imported" means searchable, not just counted — /search finds the runbook turn.
    const search = await app.inject({ method: "GET", url: "/search?q=runbook", headers: auth });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.length).toBeGreaterThan(0);
  });

  it("AC1/AC3: the route is the same import runImportPaste performs — identical text, identical summary, on the first import and the second", async () => {
    const storePath = initStore();
    const { app, auth } = ownerApp(storePath);

    // The CLI's own surface, on its own store, fed the identical text from a file.
    const parityDir = join(tempDir(), "parity");
    mkdirSync(parityDir, { recursive: true });
    const transcriptPath = join(parityDir, "transcript.txt");
    writeFileSync(transcriptPath, WORK_TRANSCRIPT, "utf8");
    const cliStorePath = join(parityDir, "duo.db");
    createEncryptedStore(cliStorePath, PASSPHRASE);
    const cliConfig = {
      ...loadConfig({ DUO_PASSPHRASE: PASSPHRASE }),
      storePath: cliStorePath,
      duoDir: join(parityDir, "duo"),
      lifecycleLogPath: join(parityDir, "lifecycle-runtime", "events.json"),
    };

    const firstViaRoute = (await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: WORK_TRANSCRIPT } })).json();
    const secondViaRoute = (await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: WORK_TRANSCRIPT } })).json();
    const firstViaCli = runImportPaste(transcriptPath, cliConfig, { DUO_PASSPHRASE: PASSPHRASE });
    const secondViaCli = runImportPaste(transcriptPath, cliConfig, { DUO_PASSPHRASE: PASSPHRASE });

    expect(firstViaRoute).toEqual(firstViaCli);
    expect(secondViaRoute).toEqual(secondViaCli);
    // AC3, made concrete — and pinned as equality, not as an invented rule:
    // a re-pasted transcript is re-parsed, and the paste adapter timestamps
    // turns at parse time, so each parse produces fresh content-hash ids and
    // ingestRecords' own alreadyPresent never fires — the CLI's second
    // import re-writes, and the route does exactly what the CLI does. The
    // day the adapter pins timestamps (making ids stable), both surfaces
    // start skipping together, because the dedupe lives in the module this
    // route and that command both feed, not at the route.
    expect(firstViaRoute).toEqual({ workRelevant: true, written: 3, skipped: 0, discardedAboveCeiling: 0 });
    expect(secondViaRoute).toEqual({ workRelevant: true, written: 3, skipped: 0, discardedAboveCeiling: 0 });
    expect(secondViaRoute).toEqual(secondViaCli);
  });

  it("AC1: a transcript with no recognisable turn is a 400 naming the expected format; a non-work transcript imports nothing and says so", async () => {
    const storePath = initStore();
    const { app, auth } = ownerApp(storePath);

    const malformed = await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: "just some prose\nwith no turn markers at all" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("MalformedTranscriptError");
    expect(malformed.json().error.message).toContain("Expected a pasted transcript");

    const personal = await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: PERSONAL_TRANSCRIPT } });
    expect(personal.statusCode).toBe(200);
    expect(personal.json()).toEqual({ workRelevant: false, written: 0, skipped: 0, discardedAboveCeiling: 0 });
  });

  it("AC1: a missing or blank transcript is a 400, importing nothing", async () => {
    const storePath = initStore();
    const { app, auth } = ownerApp(storePath);
    const missing = await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: {} });
    expect(missing.statusCode).toBe(400);
    const blank = await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: "   " } });
    expect(blank.statusCode).toBe(400);
  });

  it("AC2: an unstarted job reports idle; embedding an empty corpus starts and finishes at zero", async () => {
    const storePath = initStore();
    const { app, auth } = ownerApp(storePath);

    const idle = await app.inject({ method: "GET", url: "/corpus/embed", headers: auth });
    expect(idle.statusCode).toBe(200);
    expect(idle.json()).toEqual({ state: "idle", startedAt: null, finishedAt: null, embedded: 0, total: 0, error: null });

    const started = await app.inject({ method: "POST", url: "/corpus/embed", headers: auth });
    expect(started.statusCode).toBe(202);
    const done = await pollEmbedStatus(app, auth, "done");
    expect(done).toMatchObject({ state: "done", embedded: 0, total: 0, error: null });
  });

  it("AC2: embedding runs as a job whose progress is observable mid-run, one job at a time", async () => {
    const storePath = initStore();
    // A provider whose 11th call — the first call of the job's second
    // batch, batches being 10 — signals that it has started and then
    // blocks until the test releases it. The 11th call can only happen
    // after batch one fully computed AND persisted, so once the signal
    // fires, the mid-run status below is deterministic, not a race.
    let calls = 0;
    let signalBatch2!: () => void;
    const batch2Started = new Promise<void>((resolve) => {
      signalBatch2 = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: EmbeddingProvider = {
      name: "gated",
      model: "gated-embed",
      async embed(text: string) {
        calls += 1;
        if (calls === 11) {
          signalBatch2();
          await gate;
        }
        return [text.length % 5, 1, 0];
      },
    };
    const { app, auth } = ownerApp(storePath, { embeddingProvider: gated });
    await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: longWorkTranscript() } });

    const started = await app.inject({ method: "POST", url: "/corpus/embed", headers: auth });
    expect(started.statusCode).toBe(202);
    expect(started.json().state).toBe("running");

    await batch2Started;
    const midRun = await app.inject({ method: "GET", url: "/corpus/embed", headers: auth });
    expect(midRun.json()).toMatchObject({ state: "running", embedded: 10, total: 25 });

    // One embed at a time: a second trigger while one runs is a 409 naming
    // the running job — never a silent second job racing the store.
    const second = await app.inject({ method: "POST", url: "/corpus/embed", headers: auth });
    expect(second.statusCode).toBe(409);

    release();
    const done = await pollEmbedStatus(app, auth, "done");
    expect(done).toMatchObject({ state: "done", embedded: 25, total: 25, error: null });
    expect(done.finishedAt).toBeTruthy();

    // Once finished, a new job may start (and immediately finishes — every
    // record already has a vector under this model).
    const again = await app.inject({ method: "POST", url: "/corpus/embed", headers: auth });
    expect(again.statusCode).toBe(202);
    await pollEmbedStatus(app, auth, "done");
  });

  it("AC2: a failing embedding provider ends the job in an error state carrying the message — observable, not a hung 202", async () => {
    const storePath = initStore();
    const { app, auth } = ownerApp(storePath, { embeddingProvider: createFailingEmbeddingProvider() });
    await app.inject({ method: "POST", url: "/corpus/import-paste", headers: auth, payload: { transcript: WORK_TRANSCRIPT } });

    const started = await app.inject({ method: "POST", url: "/corpus/embed", headers: auth });
    expect(started.statusCode).toBe(202);
    const errored = await pollEmbedStatus(app, auth, "error");
    expect(errored.state).toBe("error");
    expect(errored.error).toContain("embedding service unreachable (fake)");
  });

  it("all three routes are owner routes: an ask token is refused on each, importing and embedding nothing", async () => {
    const storePath = initStore();
    const app = createServer(deps(storePath));
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const authHeader = { authorization: `Bearer ${minted.token}` };
    const importRefused = await app.inject({ method: "POST", url: "/corpus/import-paste", headers: authHeader, payload: { transcript: WORK_TRANSCRIPT } });
    const startRefused = await app.inject({ method: "POST", url: "/corpus/embed", headers: authHeader });
    const statusRefused = await app.inject({ method: "GET", url: "/corpus/embed", headers: authHeader });
    expect(importRefused.statusCode).toBe(401);
    expect(startRefused.statusCode).toBe(401);
    expect(statusRefused.statusCode).toBe(401);
    // And nothing happened: no records were imported and no job was started.
    // (ensureRecordsSchema first: a store nothing ever imported into has no
    // records table yet — its absence IS the zero being asserted.)
    const recordCount = withDatabase(storePath, PASSPHRASE, false, (db) => {
      ensureRecordsSchema(db);
      return (db.prepare("SELECT COUNT(*) AS count FROM records").get() as { count: number }).count;
    });
    expect(recordCount).toBe(0);
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    const status = await app.inject({ method: "GET", url: "/corpus/embed", headers: { authorization: `Bearer ${paired.token}` } });
    expect(status.json().state).toBe("idle");
  });
});
