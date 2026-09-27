import { readFileSync, truncateSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { IdentityError, type IdentityVerifier } from "../src/hosted/google.js";
import { ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { createHostedServer, type HostedServer, type HostedServerExtras, type HostedSettings } from "../src/hosted/server.js";
import { SynapseAdmin } from "../src/hosted/synapse-admin.js";
import { FAILURE_BACKOFF_MS, RENEW_COOLDOWN_MS, REUSE_MIN_REMAINING_MS, SESSION_LIFETIME_MS, WorkspaceSessions } from "../src/hosted/workspace-session.js";
import type { ServeDeps } from "../src/serve/server.js";
import { createAskToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";
import { tenantPaths } from "../src/hosted/server.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const MASTER = "master-key-for-tests";
const PUBLIC_URL = "https://matrix.example.com";
const running: HostedServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function settings(overrides: Partial<HostedSettings> = {}): HostedSettings {
  return {
    hostedRoot: join(tempDir(), "hosted"),
    masterKey: MASTER,
    adminToken: ADMIN,
    publicUrl: "https://daemon.example",
    webUrl: "https://web.example",
    googleClientId: undefined,
    adminEmails: [],
    synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: PUBLIC_URL },
    ...overrides,
  };
}

const fakeIdentity: IdentityVerifier = {
  async verify(credential) {
    const [subject, email, name] = credential.split("|");
    if (!subject || !email) {
      throw new IdentityError("bad credential");
    }
    return { subject, email, name };
  },
};

function rootDeps(): ServeDeps {
  const storePath = join(tempDir(), "root", "data", "duo.db");
  createEncryptedStore(storePath, "rootpw");
  const config = loadConfig({});
  return {
    storePath,
    passphrase: "rootpw",
    duoDir: join(tempDir(), "root", "duo"),
    lifecycleLogPath: join(tempDir(), "root", "lifecycle.json"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: "Shin",
    env: {},
  };
}

interface Started {
  hosted: HostedServer;
  base: string;
  logs: string[];
  hostedRoot: string;
}

async function start(
  overrides: Partial<HostedSettings> = {},
  options: { fake?: FakeSynapse; root?: ServeDeps; identity?: IdentityVerifier; extras?: HostedServerExtras } = {},
): Promise<Started> {
  const logs: string[] = [];
  const config = settings(overrides);
  const hosted = await createHostedServer(
    {
      config: loadConfig({}),
      env: { DUO_CORS_ORIGINS: "https://web.example" },
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: undefined,
      trustProxy: false,
    },
    config,
    options.root,
    options.identity,
    { synapseFetch: options.fake?.fetch, log: (line) => logs.push(line), provisionRetryMs: 3_600_000, ...options.extras },
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}`, logs, hostedRoot: config.hostedRoot };
}

async function invite(base: string): Promise<string> {
  const response = await fetch(`${base}/hosted/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ name: "Sam" }),
  });
  return ((await response.json()) as { code: string }).code;
}

/** Joins and returns the new duo's id and its first device token. */
async function join_(base: string, name: string): Promise<{ tenantId: string; token: string }> {
  const response = await fetch(`${base}/hosted/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: await invite(base), name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { tenantId: string; token: string };
}

/**
 * The route is per duo, served by that duo's own auth: `/t/<tenantId>/workspace/session` for a tenant, and
 * `/workspace/session` at the bare origin (`tenantId: null`) for the root duo.
 */
function sessionPath(tenantId: string | null): string {
  return tenantId === null ? "/workspace/session" : `/t/${tenantId}/workspace/session`;
}

function session(base: string, tenantId: string | null, token?: string, options: { method?: string; body?: string; contentType?: string; path?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(`${base}${options.path ?? sessionPath(tenantId)}`, {
    method: options.method ?? "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.contentType ? { "content-type": options.contentType } : {}), ...options.headers },
    body: options.body,
  });
}

interface SessionBody {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
  expiresAt: string;
}

async function whoAmI(fake: FakeSynapse, token: string): Promise<string | undefined> {
  const response = await fake.fetch(`${FAKE_SYNAPSE_URL}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${token}` } });
  return response.ok ? ((await response.json()) as { user_id: string }).user_id : undefined;
}

describe("POST /t/<id>/workspace/session hands the signed-in caller their own Matrix session", () => {
  it("returns the person's account, the public URL, a token that expires in about a day, and no device", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam Tan");
    const accounts = hosted.registry.matrixAccounts(tenantId)!;

    const before = Date.now();
    const response = await session(base, tenantId, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SessionBody;

    expect(Object.keys(body).sort()).toEqual(["accessToken", "deviceId", "expiresAt", "homeserverUrl", "userId"]);
    expect(body.userId).toBe(accounts.personUserId);
    expect(body.homeserverUrl).toBe(PUBLIC_URL);
    expect(body.homeserverUrl).not.toContain("railway.internal");
    expect(body.deviceId).toBeNull();
    const expiresMs = Date.parse(body.expiresAt);
    expect(expiresMs).toBeGreaterThanOrEqual(before + SESSION_LIFETIME_MS - 1_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + SESSION_LIFETIME_MS + 1_000);

    // Synapse was asked for a bounded token, for the person, and the token really is the person's.
    const minted = fake.minted.filter((entry) => entry.userId === accounts.personUserId);
    expect(minted).toHaveLength(1);
    expect(minted[0]!.token).toBe(body.accessToken);
    expect(minted[0]!.validUntilMs).toBe(expiresMs);
    expect(await whoAmI(fake, body.accessToken)).toBe(accounts.personUserId);
  });

  it("never returns the duo's token, the admin token, or the duo's account", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam Tan");
    const duoToken = hosted.registry.duoMatrixToken(tenantId)!;
    const accounts = hosted.registry.matrixAccounts(tenantId)!;

    const responses = [await session(base, tenantId, token), await session(base, tenantId, token), await session(base, tenantId), await session(base, tenantId, ADMIN), await session(base, tenantId, "nope")];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(duoToken);
      expect(text).not.toContain(FAKE_ADMIN_TOKEN);
      expect(text).not.toContain(accounts.duoUserId);
      expect(text).not.toContain(MASTER);
    }
    // The duo's token was minted once, at provisioning; the session route asked for the person's alone.
    expect(fake.minted.filter((entry) => entry.userId === accounts.duoUserId)).toHaveLength(1);
    expect(fake.minted.filter((entry) => entry.userId !== accounts.personUserId && entry.userId !== accounts.duoUserId)).toHaveLength(0);
  });

  it("the account is the mounted duo's, and a request field or another duo's path cannot name someone else's", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({}, { fake });
    const sam = await join_(base, "Sam");
    const kim = await join_(base, "Kim");
    const samAccounts = hosted.registry.matrixAccounts(sam.tenantId)!;
    const kimAccounts = hosted.registry.matrixAccounts(kim.tenantId)!;
    expect(samAccounts.personUserId).not.toBe(kimAccounts.personUserId);

    const asKim = (await (await session(base, kim.tenantId, kim.token)).json()) as SessionBody;
    expect(asKim.userId).toBe(kimAccounts.personUserId);

    // Sam names Kim (and Kim's duo, and the service account) every way a client could: body, query, headers.
    const results = await Promise.all([
      session(base, sam.tenantId, sam.token, { contentType: "application/json", body: JSON.stringify({ userId: kimAccounts.personUserId, duoId: kim.tenantId, tenantId: kim.tenantId, user_id: kimAccounts.duoUserId }) }),
      session(base, sam.tenantId, sam.token, { contentType: "application/json", body: JSON.stringify({ userId: "@workspace-admin:duo.test" }) }),
      session(base, sam.tenantId, sam.token, { path: `${sessionPath(sam.tenantId)}?userId=${encodeURIComponent(kimAccounts.personUserId)}&duoId=${kim.tenantId}`, headers: { "x-duo-id": kim.tenantId } }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200, 200]);
    for (const response of results) {
      const body = (await response.json()) as SessionBody;
      expect(body.userId).toBe(samAccounts.personUserId);
      expect(await whoAmI(fake, body.accessToken)).toBe(samAccounts.personUserId);
    }
    // Sam's valid token at KIM's path is not Kim's device: a 401 with nothing minted for Kim beyond her own first call,
    // and the same at the bare origin, where there is no root duo.
    const kimMintsBefore = fake.minted.filter((entry) => entry.userId === kimAccounts.personUserId).length;
    expect((await session(base, kim.tenantId, sam.token)).status).toBe(401);
    expect((await session(base, null, sam.token)).status).toBe(404);
    expect(fake.minted.filter((entry) => entry.userId === kimAccounts.personUserId)).toHaveLength(kimMintsBefore);
    // Only ever the two people, and never the duo accounts (beyond their provisioning mints).
    const sessionMints = fake.minted.filter((entry) => entry.validUntilMs !== null);
    expect(new Set(sessionMints.map((entry) => entry.userId))).toEqual(new Set([samAccounts.personUserId, kimAccounts.personUserId]));
  });

  it("an org's members get sessions in their own org's namespace", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({}, { fake });
    const org = hosted.registry.createOrg("Other Team");
    const code = (await (await fetch(`${base}/hosted/invites`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ name: "Lee", orgId: org.id }) })).json()) as { code: string };
    const joined = (await (await fetch(`${base}/hosted/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: code.code, name: "Lee" }) })).json()) as { tenantId: string; token: string };
    const body = (await (await session(base, joined.tenantId, joined.token)).json()) as SessionBody;
    expect(body.userId).toBe(`@${org.id}.${joined.tenantId}:duo.test`);
  });

  it("works for the root duo's owner at the bare origin, who signed in with Google (login answers tenantId null, basePath empty)", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({ googleClientId: "cid", adminEmails: ["boss@x.com"] }, { fake, root: rootDeps(), identity: fakeIdentity });
    await hosted.matrix!.whenIdle();
    const login = (await (await fetch(`${base}/hosted/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: "sub-boss|boss@x.com|Boss" }) })).json()) as { token: string; tenantId: string | null; basePath: string };
    expect(login.tenantId).toBeNull();
    expect(login.basePath).toBe("");
    const response = await session(base, login.tenantId, login.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionBody;
    expect(body.userId).toBe(hosted.registry.matrixAccounts(ROOT_DUO_ID)!.personUserId);
    expect(body.userId).toMatch(/^@[a-z0-9]+\.root:duo\.test$/);
  });

  it("login and signup tell the client which path to use: basePath + /workspace/session", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({ googleClientId: "cid" }, { fake, identity: fakeIdentity });
    const code = await invite(base);
    const signedUp = (await (await fetch(`${base}/hosted/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: code, credential: "sub-s|sam@x.com|Sam" }) })).json()) as { tenantId: string; basePath: string; token: string };
    const login = (await (await fetch(`${base}/hosted/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: "sub-s|sam@x.com|Sam" }) })).json()) as { tenantId: string; basePath: string; token: string };
    for (const answer of [signedUp, login]) {
      expect(answer.basePath).toBe(`/t/${answer.tenantId}`);
      expect((await fetch(`${base}${answer.basePath}/workspace/session`, { method: "POST", headers: { authorization: `Bearer ${answer.token}` } })).status).toBe(200);
    }
  });
});

describe("revoking a device ends the person's session", () => {
  it("a revoked device stops getting sessions on its very next request, and the minted token is logged out", async () => {
    const fake = createFakeSynapse();
    const { base, logs } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    const minted = (await (await session(base, tenantId, token)).json()) as SessionBody;
    expect(await whoAmI(fake, minted.accessToken)).toBeDefined();

    const devices = (await (await fetch(`${base}/t/${tenantId}/devices`, { headers: { authorization: `Bearer ${token}` } })).json()) as Array<{ id: string }>;
    const revoke = await fetch(`${base}/t/${tenantId}/devices/${devices[0]!.id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(revoke.status).toBe(200);

    // Same tick: the duo's auth cache is evicted by the revoke, no waiting out its window.
    expect((await session(base, tenantId, token)).status).toBe(401);
    // And the token that device had been given no longer works at Matrix either.
    await expect.poll(() => whoAmI(fake, minted.accessToken)).toBeUndefined();
    expect(fake.requests.some((request) => request.method === "POST" && request.path === "/_matrix/client/v3/logout")).toBe(true);
    expect(logs.some((line) => line.includes(`ended the workspace session for duo ${tenantId}`))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain(minted.accessToken);
    }
  });

  it("a Synapse that cannot be reached at revoke time does not fail the revoke", async () => {
    const fake = createFakeSynapse();
    const { base, logs } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    await session(base, tenantId, token);
    fake.down = true;
    const devices = (await (await fetch(`${base}/t/${tenantId}/devices`, { headers: { authorization: `Bearer ${token}` } })).json()) as Array<{ id: string }>;
    const revoke = await fetch(`${base}/t/${tenantId}/devices/${devices[0]!.id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(revoke.status).toBe(200);
    await expect.poll(() => logs.some((line) => line.includes(`could not end the workspace session for duo ${tenantId}`))).toBe(true);
  });
});

describe("a client that was told M_UNKNOWN_TOKEN renews", () => {
  it("DELETE drops the cached token (after the cooldown) and the next POST mints a live one", async () => {
    const fake = createFakeSynapse();
    let clock = 1_000_000_000_000;
    fake.now = () => clock;
    const { base } = await start({}, { fake, extras: { sessionNow: () => clock } });
    const { tenantId, token } = await join_(base, "Sam");
    const first = (await (await session(base, tenantId, token)).json()) as SessionBody;
    // The client signs out with Matrix's own /logout, which the daemon never sees; asking again hands it the same, dead, token.
    await fake.fetch(`${FAKE_SYNAPSE_URL}/_matrix/client/v3/logout`, { method: "POST", headers: { authorization: `Bearer ${first.accessToken}` } });
    expect(((await (await session(base, tenantId, token)).json()) as SessionBody).accessToken).toBe(first.accessToken);
    expect(fake.requests.some((request) => request.path === "/_matrix/client/v3/account/whoami")).toBe(false);

    // Inside the cooldown a renew changes nothing (a client loop cannot mint per request).
    expect((await session(base, tenantId, token, { method: "DELETE" })).status).toBe(204);
    expect(((await (await session(base, tenantId, token)).json()) as SessionBody).accessToken).toBe(first.accessToken);

    clock += RENEW_COOLDOWN_MS + 1;
    const renew = await session(base, tenantId, token, { method: "DELETE" });
    expect(renew.status).toBe(204);
    expect(renew.headers.get("cache-control")).toBe("no-store");
    const second = (await (await session(base, tenantId, token)).json()) as SessionBody;
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(await whoAmI(fake, second.accessToken)).toBe(first.userId);
  });

  it("DELETE needs a device token, and is 404 with no workspace", async () => {
    const { base } = await start({}, { fake: createFakeSynapse() });
    const { tenantId } = await join_(base, "Sam");
    expect((await session(base, tenantId, undefined, { method: "DELETE" })).status).toBe(401);
    expect((await session(base, tenantId, "nope", { method: "DELETE" })).status).toBe(401);
    const noSynapse = await start({ synapse: undefined });
    const sam = await join_(noSynapse.base, "Sam");
    expect((await session(noSynapse.base, sam.tenantId, sam.token, { method: "DELETE" })).status).toBe(404);
  });
});

describe("who may call it", () => {
  it("401 with no credential, and 401 for a token that is no device of that duo", async () => {
    const { base } = await start({}, { fake: createFakeSynapse() });
    const { tenantId } = await join_(base, "Sam");
    const none = await session(base, tenantId);
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    expect((await session(base, tenantId, "not-a-device-token")).status).toBe(401);
  });

  it("401 for an ask link: only a paired device is a person", async () => {
    const { base, hostedRoot } = await start({}, { fake: createFakeSynapse() });
    const { tenantId } = await join_(base, "Sam");
    const tenant = { id: tenantId };
    const registry = new HostedRegistry(join(hostedRoot, "registry.json"), MASTER);
    const link = createAskToken(tenantPaths(hostedRoot, tenant.id).storePath, registry.passphraseFor(registry.tenants().find((t) => t.id === tenantId)!), "Kim", new Date(Date.now() + 3_600_000).toISOString());
    expect((await session(base, tenantId, link.token)).status).toBe(401);
  });

  it("403 for the server-side admin token, on a tenant path and at the bare origin: it belongs to no duo", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake, root: rootDeps() });
    const { tenantId } = await join_(base, "Sam");
    for (const target of [tenantId, null]) {
      const response = await session(base, target, ADMIN);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("no_duo");
    }
    expect(fake.minted.every((entry) => entry.validUntilMs === null)).toBe(true);
  });

  it("a super admin's own signed-in device is a duo and gets its own session", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({ googleClientId: "cid", adminEmails: ["boss@x.com"] }, { fake, identity: fakeIdentity });
    const code = await invite(base);
    const signedUp = (await (await fetch(`${base}/hosted/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: code, credential: "sub-b|boss@x.com|Boss" }) })).json()) as { tenantId: string; token: string };
    const body = (await (await session(base, signedUp.tenantId, signedUp.token)).json()) as SessionBody;
    expect(body.userId).toBe(hosted.registry.matrixAccounts(signedUp.tenantId)!.personUserId);
  });

  it("wrong tokens are limited by the duo's own auth limiter, per duo, and share nothing with sign-in", async () => {
    const { base } = await start({}, { fake: createFakeSynapse() });
    const sam = await join_(base, "Sam");
    const kim = await join_(base, "Kim");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await session(base, kim.tenantId, `guess-${attempt}`)).status).toBe(401);
    }
    expect((await session(base, kim.tenantId, "guess-again")).status).toBe(429);
    // Another duo's route is untouched, and so is sign-in from the same address.
    expect((await session(base, sam.tenantId, sam.token)).status).toBe(200);
    const login = await fetch(`${base}/hosted/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(login.status).not.toBe(429);
  });

  it("404 when the server has no workspace to sign in to", async () => {
    const noSynapse = await start({ synapse: undefined });
    const { tenantId, token } = await join_(noSynapse.base, "Sam");
    const response = await session(noSynapse.base, tenantId, token);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("workspace_not_configured");

    // Synapse configured for provisioning, but no public URL to give clients.
    const noPublic = await start(
      { synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: undefined } },
      { fake: createFakeSynapse() },
    );
    const second = await join_(noPublic.base, "Kim");
    expect((await session(noPublic.base, second.tenantId, second.token)).status).toBe(404);
  });

  it("the old scanning route is gone", async () => {
    const { base } = await start({}, { fake: createFakeSynapse() });
    const { token } = await join_(base, "Sam");
    expect((await session(base, null, token, { path: "/hosted/workspace/session" })).status).toBe(404);
  });

  it("a corrupt store in one duo fails that duo's own routes only, never another duo's session", async () => {
    const fake = createFakeSynapse();
    const { base, hostedRoot } = await start({}, { fake });
    const sam = await join_(base, "Sam");
    const kim = await join_(base, "Kim");
    truncateSync(tenantPaths(hostedRoot, sam.tenantId).storePath, 10);
    const broken = await session(base, sam.tenantId, sam.token);
    expect(broken.status).toBeGreaterThanOrEqual(400);
    expect(await broken.text()).not.toContain(hostedRoot);
    expect((await session(base, kim.tenantId, kim.token)).status).toBe(200);
  });
});

describe("a body the route ignores", () => {
  it("Content-Type: application/json with no body, an empty object, or junk is not a 400", async () => {
    const { base } = await start({}, { fake: createFakeSynapse() });
    const { tenantId, token } = await join_(base, "Sam");
    for (const options of [{ contentType: "application/json" }, { contentType: "application/json", body: "{}" }, { contentType: "application/json", body: "{not json" }, { contentType: "text/plain", body: "hello" }]) {
      expect((await session(base, tenantId, token, options)).status).toBe(200);
    }
    expect((await session(base, tenantId, token, { method: "DELETE", contentType: "application/json" })).status).toBe(204);
  });
});

describe("a workspace that is not ready", () => {
  it("503 workspace_pending, with Retry-After, for a duo whose accounts are not provisioned yet; then 200 once they are", async () => {
    const fake = createFakeSynapse();
    fake.down = true;
    const { hosted, base } = await start({}, { fake, extras: { signupProvisionWaitMs: 50 } });
    const { tenantId, token } = await join_(base, "Sam");
    expect(hosted.registry.matrixAccounts(tenantId)).toBeUndefined();
    const requestsBefore = fake.requests.length;

    const pending = await session(base, tenantId, token);
    expect(pending.status).toBe(503);
    expect(pending.headers.get("retry-after")).toBe("60");
    expect(((await pending.json()) as { error: { code: string } }).error.code).toBe("workspace_pending");
    // A pending duo costs Synapse nothing: the route did not call it.
    expect(fake.requests.length).toBe(requestsBefore);

    fake.down = false;
    await hosted.matrix!.provisionAll();
    expect((await session(base, tenantId, token)).status).toBe(200);
  });

  it("503 workspace_unavailable, promptly and without a stack, when Synapse is down; the next call inside the backoff does not call it again", async () => {
    const fake = createFakeSynapse();
    const { base, logs } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    fake.down = true;
    const started = Date.now();
    const response = await session(base, tenantId, token);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "workspace_unavailable", message: expect.any(String) } });
    expect(text).not.toMatch(/ECONNREFUSED|railway\.internal|at .*\.ts/);
    expect(logs.some((line) => line.includes("could not mint a workspace session"))).toBe(true);

    const requestsBefore = fake.requests.length;
    expect((await session(base, tenantId, token)).status).toBe(503);
    expect(fake.requests.length).toBe(requestsBefore);
  });

  it("a Synapse that hangs is cut off at the timeout, not held forever", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake, extras: { synapseTimeoutMs: 300 } });
    const { tenantId, token } = await join_(base, "Sam");
    fake.hangNext();
    const started = Date.now();
    const response = await session(base, tenantId, token);
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("workspace_unavailable");
  });

  it("the default cut-off is the short 5s one, not the 10s of provisioning", { timeout: 20_000 }, async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    fake.hangNext();
    const started = Date.now();
    const response = await session(base, tenantId, token);
    const elapsed = Date.now() - started;
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(8_000);
  });

  it("a refusal from Synapse (a bad admin token) is the same 503, with no Synapse text in the body", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    fake.failNext(1, 401, "M_UNKNOWN_TOKEN");
    const response = await session(base, tenantId, token);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(FAKE_ADMIN_TOKEN);
  });
});

describe("a client loop cannot mint without bound", () => {
  it("many calls, sequential and concurrent, mint one person token and hand it out again", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    const personUserId = hosted.registry.matrixAccounts(tenantId)!.personUserId;

    const bodies = (await Promise.all(Array.from({ length: 15 }, () => session(base, tenantId, token).then((response) => response.json())))) as SessionBody[];
    for (let call = 0; call < 10; call += 1) {
      bodies.push((await (await session(base, tenantId, token)).json()) as SessionBody);
    }
    expect(new Set(bodies.map((body) => body.accessToken)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.expiresAt)).size).toBe(1);
    expect(fake.minted.filter((entry) => entry.userId === personUserId)).toHaveLength(1);
  });

  it("a person's token is never probed at Synapse (a probe would record the daemon as the person's client)", async () => {
    const fake = createFakeSynapse();
    const { tenantId, token, base } = await (async () => {
      const started = await start({}, { fake });
      return { ...(await join_(started.base, "Sam")), base: started.base };
    })();
    for (let call = 0; call < 3; call += 1) {
      await session(base, tenantId, token);
    }
    expect(fake.requests.filter((request) => request.path === "/_matrix/client/v3/account/whoami")).toHaveLength(0);
  });
});

describe("secrets stay out of logs and files", () => {
  it("no log line and no file in the hosted root holds a session token", async () => {
    const fake = createFakeSynapse();
    const { hosted, base, logs, hostedRoot } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    const body = (await (await session(base, tenantId, token)).json()) as SessionBody;
    // A second person whose mint fails: the failure line is logged too, and holds no token.
    const kim = await join_(base, "Kim");
    fake.failNext(1, 500);
    expect((await session(base, kim.tenantId, kim.token)).status).toBe(503);

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(body.accessToken);
      expect(line).not.toContain(FAKE_ADMIN_TOKEN);
      expect(line).not.toContain(token);
      expect(line).not.toContain(kim.token);
    }
    expect(logs.some((line) => line.includes(`minted a workspace session for duo ${tenantId}`))).toBe(true);
    // The session token is memory only: the registry file has the duo's token (encrypted) and no session token.
    const registryFile = readFileSync(join(hostedRoot, "registry.json"), "utf8");
    expect(registryFile).not.toContain(body.accessToken);
    expect(hosted.registry.matrixAccounts(tenantId)).toBeDefined();
    expect(logs.some((line) => line.includes("could not mint a workspace session"))).toBe(true);
  });
});

describe("CORS", () => {
  it("answers the preflight and the call for the web app's origin", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    const preflight = await fetch(`${base}${sessionPath(tenantId)}`, {
      method: "OPTIONS",
      headers: { origin: "https://web.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    const response = await fetch(`${base}${sessionPath(tenantId)}`, { method: "POST", headers: { origin: "https://web.example", authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://web.example");
  });

  it("exposes Retry-After on a 503, so a browser page can read it", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake });
    const { tenantId, token } = await join_(base, "Sam");
    fake.down = true;
    const response = await fetch(`${base}${sessionPath(tenantId)}`, { method: "POST", headers: { origin: "https://web.example", authorization: `Bearer ${token}` } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("retry-after");
  });
});

describe("WorkspaceSessions (the reuse, renew and end policy, on a fake clock)", () => {
  function fixture() {
    const fake = createFakeSynapse();
    const dir = tempDir();
    const registry = new HostedRegistry(join(dir, "registry.json"), MASTER);
    const tenant = registry.addTenant(registry.createInvite("Sam", new Date(Date.now() + 3_600_000).toISOString(), null).invite.id, "Sam", "pw", undefined, {});
    registry.setMatrixAccounts(tenant.id, { personUserId: `@default.${tenant.id}:duo.test`, duoUserId: `@duo-default.${tenant.id}:duo.test` }, "duo-token");
    let clock = 1_000_000_000_000;
    fake.now = () => clock;
    fake.users.set(`@default.${tenant.id}:duo.test`, { displayname: "Sam", admin: false, hasPassword: false });
    const logs: string[] = [];
    return {
      fake,
      registry,
      tenant,
      logs,
      advance: (ms: number) => {
        clock += ms;
      },
      sessions: (adminFetch: FakeSynapse) =>
        new WorkspaceSessions({
          registry,
          admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: adminFetch.fetch }),
          publicUrl: PUBLIC_URL,
          log: (line) => logs.push(line),
          now: () => clock,
        }),
      clock: () => clock,
    };
  }

  it("mints with a 24h valid_until_ms, reuses the token until 6h remain, then mints a fresh one", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);

    const first = await sessions.sessionFor(f.tenant.id);
    expect(first.status).toBe("ok");
    const start = f.clock();
    expect(f.fake.minted[0]!.validUntilMs).toBe(start + SESSION_LIFETIME_MS);

    f.advance(SESSION_LIFETIME_MS - REUSE_MIN_REMAINING_MS - 1_000);
    const reused = await sessions.sessionFor(f.tenant.id);
    expect(f.fake.minted).toHaveLength(1);
    expect(reused).toEqual(first);

    f.advance(2_000);
    const fresh = await sessions.sessionFor(f.tenant.id);
    expect(f.fake.minted).toHaveLength(2);
    expect(fresh.status === "ok" && first.status === "ok" && fresh.session.accessToken !== first.session.accessToken).toBe(true);
    expect(f.fake.minted[1]!.validUntilMs).toBe(f.clock() + SESSION_LIFETIME_MS);
  });

  it("renew is a no-op inside the cooldown; after it, the token is logged out and the next call mints a new one", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    const first = await sessions.sessionFor(f.tenant.id);
    if (first.status !== "ok") throw new Error("expected a session");

    await sessions.renew(f.tenant.id);
    expect(await sessions.sessionFor(f.tenant.id)).toEqual(first);
    expect(f.fake.minted).toHaveLength(1);

    f.advance(RENEW_COOLDOWN_MS + 1);
    await sessions.renew(f.tenant.id);
    const second = await sessions.sessionFor(f.tenant.id);
    if (second.status !== "ok") throw new Error("expected a session");
    expect(second.session.accessToken).not.toBe(first.session.accessToken);
    expect(f.fake.minted).toHaveLength(2);
    expect(await whoAmI(f.fake, first.session.accessToken)).toBeUndefined();
  });

  it("end logs out the cached token with the token itself, forgets it, and forgets the failure backoff too", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    const first = await sessions.sessionFor(f.tenant.id);
    if (first.status !== "ok") throw new Error("expected a session");
    await sessions.end(f.tenant.id);
    expect(await whoAmI(f.fake, first.session.accessToken)).toBeUndefined();
    const logout = f.fake.requests.filter((request) => request.path === "/_matrix/client/v3/logout");
    expect(logout).toHaveLength(1);
    // Nothing cached now: a second end asks Synapse for nothing.
    await sessions.end(f.tenant.id);
    expect(f.fake.requests.filter((request) => request.path === "/_matrix/client/v3/logout")).toHaveLength(1);
    const next = await sessions.sessionFor(f.tenant.id);
    expect(next.status).toBe("ok");
    expect(f.fake.minted).toHaveLength(2);
    expect(f.logs.join("\n")).not.toContain(first.session.accessToken);
  });

  it("end never throws when Synapse is down, and logs the reason without the token", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    const first = await sessions.sessionFor(f.tenant.id);
    if (first.status !== "ok") throw new Error("expected a session");
    f.fake.down = true;
    await expect(sessions.end(f.tenant.id)).resolves.toBeUndefined();
    expect(f.logs.some((line) => line.includes("could not end the workspace session"))).toBe(true);
    expect(f.logs.join("\n")).not.toContain(first.session.accessToken);
  });

  it("a mint that was running when the duo's session was ended does not survive it", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    const running = sessions.sessionFor(f.tenant.id);
    await sessions.end(f.tenant.id);
    expect((await running).status).toBe("unavailable");
    const minted = f.fake.minted[0]!;
    expect(await whoAmI(f.fake, minted.token)).toBeUndefined();
    // Not cached: the next call mints again.
    expect((await sessions.sessionFor(f.tenant.id)).status).toBe("ok");
    expect(f.fake.minted).toHaveLength(2);
  });

  it("remembers a failed mint for a few seconds only", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    f.fake.down = true;
    expect((await sessions.sessionFor(f.tenant.id)).status).toBe("unavailable");
    const requests = f.fake.requests.length;
    expect((await sessions.sessionFor(f.tenant.id)).status).toBe("unavailable");
    expect(f.fake.requests.length).toBe(requests);

    f.fake.down = false;
    f.advance(FAILURE_BACKOFF_MS + 1);
    expect((await sessions.sessionFor(f.tenant.id)).status).toBe("ok");
  });

  it("refuses a recorded person account that is really a duo's or the service account's", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    f.registry.setMatrixAccounts(f.tenant.id, { personUserId: `@duo-default.${f.tenant.id}:duo.test`, duoUserId: `@duo-default.${f.tenant.id}:duo.test` }, "t");
    expect((await sessions.sessionFor(f.tenant.id)).status).toBe("unavailable");
    f.registry.setMatrixAccounts(f.tenant.id, { personUserId: "@workspace-admin:duo.test", duoUserId: `@duo-default.${f.tenant.id}:duo.test` }, "t");
    expect((await sessions.sessionFor(f.tenant.id)).status).toBe("unavailable");
    expect(f.fake.minted).toHaveLength(0);
  });

  it("the token stays out of the cache's log lines, and an unknown duo is pending", async () => {
    const f = fixture();
    const sessions = f.sessions(f.fake);
    const outcome = await sessions.sessionFor(f.tenant.id);
    expect(f.logs.join("\n")).not.toContain(outcome.status === "ok" ? outcome.session.accessToken : "?");
    expect((await sessions.sessionFor("nosuchduo")).status).toBe("pending");
  });
});
