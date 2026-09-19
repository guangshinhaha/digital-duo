import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { appendDraft, recordDraftOutcome } from "../src/drafting/draft-log.js";
import { writeRuleByHand } from "../src/derivation/rule-review.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function deps(storePath: string): ServeDeps {
  const config = loadConfig();
  return {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    // Isolated from the real environment: this repo's own checked-in
    // shared-duo/persona.json is a real file at the default relative
    // path, and `env: process.env` here would otherwise leak it into
    // these tests via listAvailableDuos's default path resolution.
    env: { DUO_SHARED_PERSONA_PATH: join(tempDir(), "shared-duo", "persona.json") },
  };
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
});
