import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

// Issue #167: browser-origin clients (the Vite dev server at localhost:5173,
// the Tauri shell at tauri.localhost) are blocked by the Same-Origin Policy
// unless the daemon answers CORS — with an explicit origin allowlist, never a
// wildcard, and without weakening the bearer-token auth one notch.

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const DEV_ORIGIN = "http://localhost:5173";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function deps(storePath: string, env: NodeJS.ProcessEnv): ServeDeps {
  const config = loadConfig();
  return {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    env,
  };
}

function corsEnv(origins: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DUO_SHARED_PERSONA_PATH: join(tempDir(), "shared-duo", "persona.json") };
  if (origins !== undefined) {
    env.DUO_CORS_ORIGINS = origins;
  }
  return env;
}

describe("createServer — CORS (issue #167)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("echoes an allowlisted origin on a plain GET", async () => {
    app = createServer(deps(storePath, corsEnv(`${DEV_ORIGIN},http://tauri.localhost`)));
    const response = await app.inject({ method: "GET", url: "/duos", headers: { ...authHeader, origin: DEV_ORIGIN } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
  });

  it("allows every origin in the allowlist, tolerating surrounding whitespace", async () => {
    app = createServer(deps(storePath, corsEnv(" http://tauri.localhost ,  http://localhost:5173 ")));
    for (const origin of ["http://tauri.localhost", DEV_ORIGIN]) {
      const response = await app.inject({ method: "GET", url: "/duos", headers: { ...authHeader, origin } });
      expect(response.headers["access-control-allow-origin"], origin).toBe(origin);
    }
  });

  it("sends no access-control-allow-origin for a disallowed origin — default-deny, not a wildcard", async () => {
    app = createServer(deps(storePath, corsEnv(DEV_ORIGIN)));
    const response = await app.inject({ method: "GET", url: "/duos", headers: { ...authHeader, origin: "https://evil.example" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends no CORS headers at all when no allowlist is configured", async () => {
    app = createServer(deps(storePath, corsEnv(undefined)));
    const response = await app.inject({ method: "GET", url: "/duos", headers: { ...authHeader, origin: DEV_ORIGIN } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a JSON POST's preflight without a bearer token — browsers cannot send one on OPTIONS", async () => {
    app = createServer(deps(storePath, corsEnv(DEV_ORIGIN)));
    const response = await app.inject({
      method: "OPTIONS",
      url: "/drafts",
      headers: {
        origin: DEV_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(response.statusCode).toBeLessThan(400);
    expect(response.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    const allowedHeaders = (response.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("content-type");
  });

  it("does not answer a preflight when the origin is not allowlisted", async () => {
    app = createServer(deps(storePath, corsEnv(DEV_ORIGIN)));
    const response = await app.inject({
      method: "OPTIONS",
      url: "/drafts",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS never bypasses device-token auth: an allowed origin without a token still 401s", async () => {
    app = createServer(deps(storePath, corsEnv(DEV_ORIGIN)));
    const response = await app.inject({ method: "GET", url: "/duos", headers: { origin: DEV_ORIGIN } });
    expect(response.statusCode).toBe(401);
    // The 401 itself carries the CORS header, so a browser client can read
    // the error body — the point of answering CORS at all.
    expect(response.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
  });

  it("an allowlisted cross-origin error response is readable by the browser", async () => {
    app = createServer(deps(storePath, corsEnv(DEV_ORIGIN)));
    const response = await app.inject({ method: "GET", url: "/drafts/not-a-real-id", headers: { ...authHeader, origin: DEV_ORIGIN } });
    expect(response.statusCode).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
  });
});
