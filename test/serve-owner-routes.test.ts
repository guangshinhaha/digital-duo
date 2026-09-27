import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import { applyCorrection } from "../src/trust/demotion.js";
import { recordCleanInstance, acceptPromotionOffer, PROMOTION_THRESHOLD } from "../src/trust/promotion.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { loadConfig } from "../src/config.js";
import { DeriveJob } from "../src/serve/derive-job.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createAskToken, createDeviceToken, listDeviceTokens } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function setup() {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  const config = loadConfig();
  const deps: ServeDeps = {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    lifecycleLogPath: join(tempDir(), "lifecycle-runtime", "events.json"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: "Owner",
    env: {},
  };
  const device = createDeviceToken(storePath, PASSPHRASE, "laptop");
  const app = createServer(deps);
  const auth = { authorization: `Bearer ${device.token}` };
  return { app, auth, storePath };
}

describe("owner routes — the terminal-only commands, from the app", () => {
  it("imports a Claude export body and reports the same summary as `duo import claude`", async () => {
    const { app, auth } = setup();
    const raw = readFileSync(join(__dirname, "fixtures", "claude-export-mixed.json"), "utf8");
    const response = await app.inject({ method: "POST", url: "/corpus/import-claude", headers: auth, payload: { export: raw } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.conversationCount).toBeGreaterThan(0);
    expect(typeof body.written).toBe("number");
  });

  it("refuses a malformed export with a 400 naming the problem", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "POST", url: "/corpus/import-claude", headers: auth, payload: { export: "not json" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("malformed_export");
  });

  it("refuses a second derive while one is running", () => {
    const { storePath } = setup();
    const job = new DeriveJob();
    const inputs = { storePath, passphrase: PASSPHRASE, duoDir: join(tempDir(), "duo"), embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined };
    expect(job.start(inputs)).toBe(true);
    expect(job.start(inputs)).toBe(false);
  });

  it("runs derive as a job: 202 to start, then done", async () => {
    const { app, auth } = setup();
    const started = await app.inject({ method: "POST", url: "/corpus/derive", headers: auth });
    expect(started.statusCode).toBe(202);
    let status = started.json();
    for (let i = 0; i < 100 && status.state === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await app.inject({ method: "GET", url: "/corpus/derive", headers: auth })).json();
    }
    expect(status.state).toBe("done");
  });

  it("mints, lists and revokes ask links; the token appears only at creation", async () => {
    const { app, auth } = setup();
    const created = await app.inject({ method: "POST", url: "/ask-links", headers: auth, payload: { name: "Sam", expiresInHours: 2 } });
    expect(created.statusCode).toBe(201);
    const { id, token } = created.json();
    expect(token).toEqual(expect.any(String));
    const listed = (await app.inject({ method: "GET", url: "/ask-links", headers: auth })).json();
    expect(listed).toEqual([expect.objectContaining({ id, name: "Sam", valid: true, revokedAt: null })]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect((await app.inject({ method: "POST", url: `/ask-links/${id}/revoke`, headers: auth })).statusCode).toBe(204);
    const after = (await app.inject({ method: "GET", url: "/ask-links", headers: auth })).json();
    expect(after[0].valid).toBe(false);
    expect((await app.inject({ method: "POST", url: "/ask-links/nope/revoke", headers: auth })).statusCode).toBe(404);
  });

  it("rejects a bad ask-link expiry", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "POST", url: "/ask-links", headers: auth, payload: { name: "Sam", expiresInHours: 0 } });
    expect(response.statusCode).toBe(400);
  });

  it("pairs another device from an already-paired one", async () => {
    const { app, auth, storePath } = setup();
    const response = await app.inject({ method: "POST", url: "/devices", headers: auth, payload: { name: "phone" } });
    expect(response.statusCode).toBe(201);
    expect(listDeviceTokens(storePath, PASSPHRASE).map((device) => device.name).sort()).toEqual(["laptop", "phone"]);
  });

  it("never lets an ask token reach an owner route", async () => {
    const { app, storePath } = setup();
    const ask = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 3_600_000).toISOString());
    for (const url of ["/ask-links", "/devices", "/corpus/derive", "/trust/grant"]) {
      const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${ask.token}` }, payload: {} });
      expect(response.statusCode).toBe(401);
    }
  });

  it("refuses a T4 grant and records the attempt, like `duo trust grant --tier T4`", async () => {
    const { app, auth, storePath } = setup();
    const response = await app.inject({ method: "POST", url: "/trust/grant", headers: auth, payload: { scopeText: "everything", tier: "T4" } });
    expect(response.statusCode).toBe(400);
    const attempts = listActionAttempts(storePath, PASSPHRASE);
    expect(attempts.some((attempt) => attempt.outcome === "refused_t4_bypass")).toBe(true);
  });

  it("reports a grant with no matching topic as no_match rather than failing", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "POST", url: "/trust/grant", headers: auth, payload: { scopeText: "deployments", tier: "T1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("no_match");
  });

  it("lists promotion offers (none on a fresh duo)", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "GET", url: "/trust/promotions", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("lists recent demotions for the client's notice card (digital-duo#246), none on a fresh duo", async () => {
    const { app, auth } = setup();
    const empty = await app.inject({ method: "GET", url: "/trust/notices", headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
  });

  it("reports a real demotion with the topic and both levels, but not an at-floor no-op", async () => {
    const { app, auth, storePath } = setup();
    writeTopicsFile(join(tempDir(), "duo"), [{ id: "topic-a", label: "Topic A", createdAt: "2026-01-01T00:00:00.000Z" }]);
    // Promote all the way to "auto" so there is somewhere for the correction to drop from.
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
        recordCleanInstance(storePath, PASSPHRASE, "topic-a", "T0");
      }
      acceptPromotionOffer(storePath, PASSPHRASE, "topic-a", "T0");
    }
    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-a", tier: "T0", correctionRef: "audit-42" });
    // A no-op correction on an untouched cell — excluded, nothing to announce.
    applyCorrection(storePath, PASSPHRASE, { topicId: "topic-b", tier: "T0", correctionRef: "audit-43" });

    const response = await app.inject({ method: "GET", url: "/trust/notices", headers: auth });
    expect(response.statusCode).toBe(200);
    const notices = response.json();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ topicId: "topic-a", topicLabel: "Topic A", tier: "T0", fromLevel: "auto", toLevel: "approve" });
  });

  it("never lets an ask token reach /trust/notices either", async () => {
    const { app, storePath } = setup();
    const ask = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 3_600_000).toISOString());
    const response = await app.inject({ method: "GET", url: "/trust/notices", headers: { authorization: `Bearer ${ask.token}` } });
    expect(response.statusCode).toBe(401);
  });
});
