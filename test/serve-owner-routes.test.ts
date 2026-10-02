import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { listActionAttempts } from "../src/actions/attempt-log.js";
import type { ChannelAdapter } from "../src/drafting/delivery.js";
import { listSubscriptions } from "../src/push/subscriptions.js";
import { applyCorrection } from "../src/trust/demotion.js";
import { recordCleanInstance, acceptPromotionOffer, PROMOTION_THRESHOLD } from "../src/trust/promotion.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { loadConfig } from "../src/config.js";
import { DeriveJob } from "../src/serve/derive-job.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { CLAUDE_EXPORT_ZIP_BODY_LIMIT } from "../src/serve/owner-routes.js";
import { createAskToken, createDeviceToken, listDeviceTokens } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function setup(overrides: Partial<ServeDeps> = {}) {
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
    ...overrides,
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

  describe("POST /corpus/import-claude-zip (#239)", () => {
    function zipOf(entries: Record<string, string>): Buffer {
      const files: Record<string, Uint8Array> = {};
      for (const [name, contents] of Object.entries(entries)) {
        files[name] = strToU8(contents);
      }
      return Buffer.from(zipSync(files, { level: 0 }));
    }

    function conversationsExportJson(): string {
      return readFileSync(join(__dirname, "fixtures", "claude-export-mixed.json"), "utf8");
    }

    it("imports the zip's conversations.json and reports the same summary shape `/corpus/import-claude` gives for the identical text", async () => {
      const { app, auth } = setup();
      const raw = conversationsExportJson();
      const zip = zipOf({ "conversations.json": raw, "users.json": "{}" });

      const zipResponse = await app.inject({
        method: "POST",
        url: "/corpus/import-claude-zip",
        headers: { ...auth, "content-type": "application/zip" },
        payload: zip,
      });

      expect(zipResponse.statusCode).toBe(200);
      const zipBody = zipResponse.json();

      // Cross-checked against the paste/JSON-body route's own parse of the
      // identical conversations.json text, on the same fresh store: the zip
      // route is only supposed to add unzipping in front of the same
      // parse-and-ingest tail, so the two must land on the same numbers.
      const pasteResponse = await app.inject({
        method: "POST",
        url: "/corpus/import-claude",
        headers: auth,
        payload: { export: raw },
      });
      const pasteBody = pasteResponse.json();

      expect(zipBody.conversationCount).toBe(pasteBody.conversationCount);
      expect(zipBody.workRelevantConversationCount).toBe(pasteBody.workRelevantConversationCount);
      expect(zipBody.written).toBeGreaterThan(0);
      // The zip import ran first, so the paste import of the same text sees
      // every record already present.
      expect(pasteBody.written).toBe(0);
      expect(pasteBody.skipped).toBe(zipBody.written);
    });

    it("refuses a file that isn't a zip at all", async () => {
      const { app, auth } = setup();
      const response = await app.inject({
        method: "POST",
        url: "/corpus/import-claude-zip",
        headers: { ...auth, "content-type": "application/zip" },
        payload: Buffer.from("not a zip file, just plain bytes"),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("malformed_export");
    });

    it("refuses a zip with no conversations.json inside", async () => {
      const { app, auth } = setup();
      const zip = zipOf({ "users.json": "{}", "projects.json": "[]" });
      const response = await app.inject({
        method: "POST",
        url: "/corpus/import-claude-zip",
        headers: { ...auth, "content-type": "application/zip" },
        payload: zip,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("malformed_export");
      expect(response.json().error.message).toMatch(/conversations\.json/);
    });

    it("uploading the same zip again adds nothing", async () => {
      const { app, auth } = setup();
      const zip = zipOf({ "conversations.json": conversationsExportJson() });

      const first = await app.inject({
        method: "POST",
        url: "/corpus/import-claude-zip",
        headers: { ...auth, "content-type": "application/zip" },
        payload: zip,
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      expect(firstBody.written).toBeGreaterThan(0);

      const second = await app.inject({
        method: "POST",
        url: "/corpus/import-claude-zip",
        headers: { ...auth, "content-type": "application/zip" },
        payload: zip,
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json();
      expect(secondBody.written).toBe(0);
      expect(secondBody.skipped).toBe(firstBody.written);
    });

    it("refuses a zip over the size limit before parsing it, stating the limit", async () => {
      const { app, auth } = setup();
      // No valid zip needs to be constructed — the limit is enforced by
      // Content-Length/streamed size before the body is ever parsed, so an
      // oversized body of any bytes is refused the same way.
      const oversized = Buffer.alloc(CLAUDE_EXPORT_ZIP_BODY_LIMIT + 1024);

      const response = await app.inject({
        method: "POST",
        url: "/corpus/import-claude-zip",
        headers: { ...auth, "content-type": "application/zip" },
        payload: oversized,
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe("zip_too_large");
      expect(response.json().error.message).toMatch(/100MB/);
    });
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

  it("reads a bridged thread's messages when a registered adapter can read its own history (digital-duo#248)", async () => {
    const slack: ChannelAdapter = {
      channelKind: "slack",
      label: "a channel",
      async status() {
        return { state: "connected", lastActivityAt: null };
      },
      async deliver() {},
      async history() {
        return [{ id: "m1", at: "2026-01-01T00:00:01.000Z", senderRef: "U_sam", text: "hi" }];
      },
    };
    const { app, auth } = setup({ channelAdapters: [slack] });
    const response = await app.inject({ method: "GET", url: "/threads/slack/t1/messages", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: "m1", at: "2026-01-01T00:00:01.000Z", senderRef: "U_sam", text: "hi", fromOwner: false }]);
  });

  it("answers a channel with no adapter registered with a clear empty result, not an error", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "GET", url: "/threads/slack/t1/messages", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("never lets an ask token read a bridged thread either", async () => {
    const { app, storePath } = setup();
    const ask = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 3_600_000).toISOString());
    const response = await app.inject({ method: "GET", url: "/threads/slack/t1/messages", headers: { authorization: `Bearer ${ask.token}` } });
    expect(response.statusCode).toBe(401);
  });
});

describe("push routes — registering, reading and removing this device's own subscription (digital-duo#251)", () => {
  const SUBSCRIBE_BODY = { endpoint: "https://push.example/a", keys: { p256dh: "p256dh-key", auth: "auth-key" } };

  it("hands out this duo's VAPID public key, the same one on every call", async () => {
    const { app, auth } = setup();
    const first = await app.inject({ method: "GET", url: "/push/vapid-public-key", headers: auth });
    const second = await app.inject({ method: "GET", url: "/push/vapid-public-key", headers: auth });
    expect(first.statusCode).toBe(200);
    expect(first.json().publicKey).toEqual(expect.any(String));
    expect(second.json().publicKey).toBe(first.json().publicKey);
  });

  it("registers this device's subscription, defaulting quiet hours to off", async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: SUBSCRIBE_BODY });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ endpoint: SUBSCRIBE_BODY.endpoint, quietHours: { manual: false, from: null, to: null, timezone: "UTC" } });
  });

  it("registers with quiet hours, and a malformed one is refused with a 400 naming the problem", async () => {
    const { app, auth } = setup();
    const good = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: auth,
      payload: { ...SUBSCRIBE_BODY, quietHours: { from: "22:00", to: "07:00", timezone: "Asia/Singapore" } },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().quietHours).toEqual({ manual: false, from: "22:00", to: "07:00", timezone: "Asia/Singapore" });

    const bad = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: auth,
      payload: { ...SUBSCRIBE_BODY, quietHours: { from: "22:00" } }, // half-set window
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("bad_request");
  });

  it("rejects a subscription missing endpoint or keys", async () => {
    const { app, auth } = setup();
    expect((await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: { keys: SUBSCRIBE_BODY.keys } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: { endpoint: SUBSCRIBE_BODY.endpoint } })).statusCode).toBe(400);
  });

  it("rejects a plain-http endpoint through the real route — refusing to be pointed at an internal address (digital-duo#268 review: SSRF)", async () => {
    const { app, auth, storePath } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: auth,
      payload: { ...SUBSCRIBE_BODY, endpoint: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
    expect(listSubscriptions(storePath, PASSPHRASE)).toEqual([]);
  });

  it("removes this device's own subscription, and a device with none is a no-op", async () => {
    const { app, auth } = setup();
    await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: SUBSCRIBE_BODY });
    const removed = await app.inject({ method: "DELETE", url: "/push/subscriptions", headers: auth });
    expect(removed.statusCode).toBe(204);
    const again = await app.inject({ method: "DELETE", url: "/push/subscriptions", headers: auth });
    expect(again.statusCode).toBe(204);
  });

  it("registering again from the same device replaces its subscription, never adds a second one", async () => {
    const { app, auth, storePath } = setup();
    await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: SUBSCRIBE_BODY });
    await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: { ...SUBSCRIBE_BODY, endpoint: "https://push.example/rotated" } });
    expect(listSubscriptions(storePath, PASSPHRASE)).toHaveLength(1);
    expect(listSubscriptions(storePath, PASSPHRASE)[0].endpoint).toBe("https://push.example/rotated");
  });

  it("revoking a device removes its push subscription — the acceptance criterion, exercised through the real route", async () => {
    const { app, auth, storePath } = setup();
    await app.inject({ method: "POST", url: "/push/subscriptions", headers: auth, payload: SUBSCRIBE_BODY });
    const device = listDeviceTokens(storePath, PASSPHRASE)[0];
    expect(listSubscriptions(storePath, PASSPHRASE)).toHaveLength(1);

    await app.inject({ method: "POST", url: `/devices/${device.id}/revoke`, headers: auth });
    expect(listSubscriptions(storePath, PASSPHRASE)).toEqual([]);
  });

  it("never lets an ask token reach any push route", async () => {
    const { app, storePath } = setup();
    const ask = { authorization: `Bearer ${createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 3_600_000).toISOString()).token}` };
    expect((await app.inject({ method: "GET", url: "/push/vapid-public-key", headers: ask })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/push/subscriptions", headers: ask, payload: SUBSCRIBE_BODY })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/push/subscriptions", headers: ask })).statusCode).toBe(401);
  });
});
