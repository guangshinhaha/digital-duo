import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createDeviceToken, listDeviceTokens, revokeDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

// Issue #162: GET /ws — one channel, draft-ready. Auth is by first message,
// never a query param (the browser WebSocket API cannot set headers, and a
// ?token= would land the device token in access logs).

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const AUTH_CLOSE = 4001;

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function deps(storePath: string, extra: NodeJS.ProcessEnv = {}): ServeDeps {
  const config = loadConfig();
  return {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    env: { DUO_SHARED_PERSONA_PATH: join(tempDir(), "shared-duo", "persona.json"), ...extra },
  };
}

function connect(url: string): WebSocket {
  return new WebSocket(url);
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("close", (code) => reject(new Error(`closed (${code}) before any message`)));
    socket.once("error", reject);
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; messages: string[] }> {
  const messages: string[] = [];
  socket.on("message", (data) => messages.push(data.toString()));
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve({ code, messages }));
    socket.once("error", () => resolve({ code: -1, messages }));
  });
}

function send(socket: WebSocket, payload: unknown): void {
  socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
}

describe("GET /ws — the draft-ready channel (issue #162)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let baseUrl: string;
  let wsUrl: string;
  let token: string;
  let authHeader: { authorization: string };

  beforeEach(async () => {
    storePath = initStore();
    app = createServer(deps(storePath));
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    wsUrl = `${baseUrl.replace("http", "ws")}/ws`;
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    token = paired.token;
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  afterEach(async () => {
    await app.close();
  });

  it("answers a valid first-message auth with {type:ready}", async () => {
    const socket = connect(wsUrl);
    const first = nextMessage(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token });
    expect(JSON.parse(await first)).toEqual({ type: "ready" });
    socket.close();
  });

  it("closes with 4001 on an unknown token, having sent nothing", async () => {
    const socket = connect(wsUrl);
    const closed = nextClose(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token: "not-a-real-token" });
    const { code, messages } = await closed;
    expect(code).toBe(AUTH_CLOSE);
    expect(messages).toEqual([]);
  });

  it("closes with 4001 when the first message is not an auth — no pre-auth message gets any response", async () => {
    const socket = connect(wsUrl);
    const closed = nextClose(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "draft-ready", draftId: "spoofed" });
    const { code, messages } = await closed;
    expect(code).toBe(AUTH_CLOSE);
    expect(messages).toEqual([]);
  });

  it("closes with 4001 on a non-JSON first message", async () => {
    const socket = connect(wsUrl);
    const closed = nextClose(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, "this is not json");
    const { code, messages } = await closed;
    expect(code).toBe(AUTH_CLOSE);
    expect(messages).toEqual([]);
  });

  it("never authenticates from a query parameter — the token must arrive in the first message", async () => {
    const socket = connect(`${wsUrl}?token=${encodeURIComponent(token)}`);
    const closed = nextClose(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token: "not-a-real-token" });
    const { code } = await closed;
    expect(code).toBe(AUTH_CLOSE);
  });

  it("pushes {type:draft-ready} same-tick when POST /drafts completes a draft", async () => {
    const socket = connect(wsUrl);
    const first = nextMessage(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token });
    await first;

    const pushed = nextMessage(socket);
    const response = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...authHeader, "content-type": "application/json" },
      payload: { question: "what is the meaning of life" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    // An empty store escalates — still a draft row the owner can act on
    // (POST /drafts/:id/answer), so it still pushes.
    expect(body.kind).toBe("escalation");
    expect(JSON.parse(await pushed)).toEqual({ type: "draft-ready", draftId: body.draftId });
    socket.close();
  });

  it("a disconnected client is cleaned up: a later push reaches the remaining client and throws nothing", async () => {
    const gone = connect(wsUrl);
    const goneReady = nextMessage(gone);
    await new Promise((resolve) => gone.once("open", resolve));
    send(gone, { type: "auth", token });
    await goneReady;

    const staying = connect(wsUrl);
    const stayingReady = nextMessage(staying);
    await new Promise((resolve) => staying.once("open", resolve));
    send(staying, { type: "auth", token });
    await stayingReady;

    gone.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pushed = nextMessage(staying);
    await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...authHeader, "content-type": "application/json" },
      payload: { question: "another question" },
    });
    expect(JSON.parse(await pushed)).toHaveProperty("type", "draft-ready");
    staying.close();
  });

  it("updating last_seen_at on socket open — 'which devices can read my corpus right now'", async () => {
    expect(listDeviceTokens(storePath, PASSPHRASE)[0].lastSeenAt).toBeNull();
    const socket = connect(wsUrl);
    const first = nextMessage(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token });
    await first;
    expect(listDeviceTokens(storePath, PASSPHRASE)[0].lastSeenAt).not.toBeNull();
    socket.close();
  });

  it("revoking the device closes its live socket, within the documented re-verification window", async () => {
    // A revocation done outside this process (duo pair revoke) can only be
    // seen by re-verifying; the window matches the HTTP token cache's own
    // documented staleness. Overridden here so the test runs in milliseconds.
    await app.close();
    app = createServer(deps(storePath, { DUO_WS_REVERIFY_MS: "150" }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws`;

    const socket = connect(url);
    const first = nextMessage(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token });
    await first;

    const closed = nextClose(socket);
    revokeDeviceToken(storePath, PASSPHRASE, listDeviceTokens(storePath, PASSPHRASE)[0].id);
    const { code } = await closed;
    expect(code).toBe(AUTH_CLOSE);
  }, 15_000);

  it("an ask token is not a device token: it cannot open the socket", async () => {
    const { createAskToken } = await import("../src/serve/tokens.js");
    const minted = createAskToken(storePath, PASSPHRASE, "Sam", new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const socket = connect(wsUrl);
    const closed = nextClose(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    send(socket, { type: "auth", token: minted.token });
    expect((await closed).code).toBe(AUTH_CLOSE);
  });
});
