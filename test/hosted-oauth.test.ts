import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { IdentityError, type IdentityVerifier } from "../src/hosted/google.js";
import { CLAUDE_REDIRECT_URIS, OAuthError, OAuthStore } from "../src/hosted/oauth.js";
import { createHostedServer, tenantPaths, type HostedServer, type HostedSettings } from "../src/hosted/server.js";
import { listRecords } from "../src/ingest/record-store.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const REDIRECT = CLAUDE_REDIRECT_URIS[0];
const running: HostedServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** A verifier whose credentials are just "subject|email|name". */
const fakeIdentity: IdentityVerifier = {
  async verify(credential) {
    const [subject, email, name] = credential.split("|");
    if (!subject || !email) {
      throw new IdentityError("bad credential");
    }
    return { subject, email, name };
  },
};

function settings(): HostedSettings {
  return {
    hostedRoot: join(tempDir(), "hosted"),
    masterKey: "master-key-for-tests",
    adminToken: ADMIN,
    publicUrl: "https://daemon.example",
    webUrl: "https://web.example",
    googleClientId: "test-client",
    adminEmails: [],
  };
}

async function start(): Promise<{ hosted: HostedServer; base: string; hostedRoot: string }> {
  const config = loadConfig({});
  const opts = settings();
  const hosted = await createHostedServer(
    { config, env: { DUO_CORS_ORIGINS: "https://web.example" }, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false },
    opts,
    undefined,
    fakeIdentity,
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}`, hostedRoot: opts.hostedRoot };
}

async function json(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** Creates a duo for a Google identity ("sub|email|name") through the real invite and sign-up routes. */
async function signUp(base: string, credential: string): Promise<{ tenantId: string; basePath: string; token: string }> {
  const invite = (await (await json(base, "/hosted/invites", { name: "x" }, { authorization: `Bearer ${ADMIN}` })).json()) as { code: string };
  const response = await json(base, "/hosted/signup", { invite: invite.code, credential });
  expect(response.status).toBe(201);
  return (await response.json()) as { tenantId: string; basePath: string; token: string };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerClient(base: string): Promise<string> {
  const response = await json(base, "/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT] });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Starts a sign-in as Claude would: returns the id the owner is sent to the web app with. */
async function authorize(base: string, clientId: string, challenge: string, extra: Record<string, string> = {}): Promise<Response> {
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...extra });
  return fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
}

function requestIdFrom(response: Response): string {
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith("https://web.example/#connect?")).toBe(true);
  return new URL(location.replace("/#", "/?")).searchParams.get("request") ?? "";
}

async function approve(base: string, requestId: string, credential: string): Promise<Response> {
  return json(base, `/oauth/requests/${requestId}/approve`, { credential });
}

function codeFrom(redirectTo: string): string {
  return new URL(redirectTo).searchParams.get("code") ?? "";
}

async function token(base: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
}

/** The whole flow, as claude.ai runs it, for the Google identity given. */
async function connect(base: string, credential: string) {
  const clientId = await registerClient(base);
  const { verifier, challenge } = pkce();
  const requestId = requestIdFrom(await authorize(base, clientId, challenge));
  const approved = await approve(base, requestId, credential);
  expect(approved.status).toBe(200);
  const { redirectTo } = (await approved.json()) as { redirectTo: string };
  expect(new URL(redirectTo).searchParams.get("state")).toBe("xyz");
  const exchanged = await token(base, { grant_type: "authorization_code", code: codeFrom(redirectTo), redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  return { clientId, verifier, challenge, ...tokens };
}

async function saveAs(base: string, accessToken: string, text: string): Promise<string> {
  const client = new Client({ name: "test-claude", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  try {
    const result = await client.callTool({ name: "save_to_duo", arguments: { text } });
    return (result.content as { text: string }[])[0].text;
  } finally {
    await client.close();
  }
}

function connectorRecords(hosted: HostedServer, hostedRoot: string, tenantId: string) {
  const tenant = hosted.registry.tenants().find((candidate) => candidate.id === tenantId)!;
  return listRecords(tenantPaths(hostedRoot, tenantId).storePath, hosted.registry.passphraseFor(tenant)).filter((record) => record.source === "connector");
}

describe("claude.ai connector by sign-in (#240)", () => {
  it("publishes the OAuth metadata Claude discovers the server from", async () => {
    const { base } = await start();
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(resource).toMatchObject({ resource: "https://daemon.example/mcp", authorization_servers: ["https://daemon.example"] });
    const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({
      issuer: "https://daemon.example",
      authorization_endpoint: "https://daemon.example/oauth/authorize",
      token_endpoint: "https://daemon.example/oauth/token",
      registration_endpoint: "https://daemon.example/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("answers /mcp without a token by pointing Claude at the sign-in metadata", async () => {
    const { base } = await start();
    const bare = await json(base, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://daemon.example/.well-known/oauth-protected-resource"');
    const wrong = await json(base, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer not-a-token" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("signs the owner in and saves into that owner's duo, and no one else's", async () => {
    const { hosted, base, hostedRoot } = await start();
    const sam = await signUp(base, "sub-sam|sam@x.com|Sam");
    const kim = await signUp(base, "sub-kim|kim@x.com|Kim");

    const connection = await connect(base, "sub-sam|sam@x.com|Sam");
    expect(connection.token_type).toBe("Bearer");
    expect(connection.expires_in).toBe(3600);
    expect(await saveAs(base, connection.access_token, "The printer on the second floor is broken.")).toMatch(/^Saved to your duo/);

    expect(connectorRecords(hosted, hostedRoot, sam.tenantId).map((record) => record.text)).toEqual(["The printer on the second floor is broken."]);
    expect(connectorRecords(hosted, hostedRoot, kim.tenantId)).toEqual([]);
  });

  it("refuses a Google account that owns no duo, and issues no code", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const clientId = await registerClient(base);
    const { challenge } = pkce();
    const requestId = requestIdFrom(await authorize(base, clientId, challenge));

    const refused = await approve(base, requestId, "sub-stranger|eve@x.com|Eve");
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("no_duo");
    // The request is still open for the right owner: nothing was consumed or issued.
    expect((await approve(base, requestId, "sub-sam|sam@x.com|Sam")).status).toBe(200);
  });

  it("refuses a bad sign-in credential", async () => {
    const { base } = await start();
    const clientId = await registerClient(base);
    const requestId = requestIdFrom(await authorize(base, clientId, pkce().challenge));
    const refused = await approve(base, requestId, "malformed");
    expect(refused.status).toBe(401);
  });

  it("only registers Claude's own callback addresses", async () => {
    const { base } = await start();
    const refused = await json(base, "/oauth/register", { client_name: "Evil", redirect_uris: ["https://evil.example/callback"] });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("never redirects to an address it does not know, but sends other mistakes back to Claude", async () => {
    const { base } = await start();
    const clientId = await registerClient(base);
    const { challenge } = pkce();

    const unknownAddress = await authorize(base, clientId, challenge, { redirect_uri: "https://evil.example/callback" });
    expect(unknownAddress.status).toBe(400);
    expect(unknownAddress.headers.get("location")).toBeNull();
    const unknownClient = await authorize(base, "nobody", challenge);
    expect(unknownClient.status).toBe(400);

    const noPkce = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz`, { redirect: "manual" });
    expect(noPkce.status).toBe(302);
    const back = new URL(noPkce.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("xyz");
  });

  it("sends Claude back with access_denied when the owner declines", async () => {
    const { base } = await start();
    const clientId = await registerClient(base);
    const requestId = requestIdFrom(await authorize(base, clientId, pkce().challenge));
    const denied = (await (await json(base, `/oauth/requests/${requestId}/deny`, {})).json()) as { redirectTo: string };
    expect(new URL(denied.redirectTo).searchParams.get("error")).toBe("access_denied");
    expect((await approve(base, requestId, "sub-sam|sam@x.com|Sam")).status).toBe(404);
  });

  it("refuses a wrong PKCE verifier, and a code used twice", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const clientId = await registerClient(base);
    const { verifier, challenge } = pkce();

    const first = (await (await approve(base, requestIdFrom(await authorize(base, clientId, challenge)), "sub-sam|sam@x.com|Sam")).json()) as { redirectTo: string };
    const wrong = await token(base, { grant_type: "authorization_code", code: codeFrom(first.redirectTo), redirect_uri: REDIRECT, client_id: clientId, code_verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    // A failed attempt spends the code: the right verifier no longer works either.
    const retry = await token(base, { grant_type: "authorization_code", code: codeFrom(first.redirectTo), redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect(retry.status).toBe(400);

    const second = (await (await approve(base, requestIdFrom(await authorize(base, clientId, challenge)), "sub-sam|sam@x.com|Sam")).json()) as { redirectTo: string };
    const form = { grant_type: "authorization_code", code: codeFrom(second.redirectTo), redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
    expect((await token(base, form)).status).toBe(200);
    expect((await token(base, form)).status).toBe(400);
  });

  it("refreshes to a new pair, retires the old access token, and revokes the connection if a used refresh token comes back", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const connection = await connect(base, "sub-sam|sam@x.com|Sam");

    const refreshed = await token(base, { grant_type: "refresh_token", refresh_token: connection.refresh_token, client_id: connection.clientId });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(connection.access_token);
    expect(await saveAs(base, next.access_token, "After refreshing.")).toMatch(/^Saved to your duo/);
    expect((await json(base, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${connection.access_token}` })).status).toBe(401);

    const replay = await token(base, { grant_type: "refresh_token", refresh_token: connection.refresh_token, client_id: connection.clientId });
    expect(replay.status).toBe(400);
    expect((await json(base, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${next.access_token}` })).status).toBe(401);
  });

  it("shows the owner the connection and revokes it from the app; the next save is refused", async () => {
    const { base } = await start();
    const sam = await signUp(base, "sub-sam|sam@x.com|Sam");
    const auth = { authorization: `Bearer ${sam.token}` };
    const connection = await connect(base, "sub-sam|sam@x.com|Sam");

    const status = (await (await fetch(`${base}${sam.basePath}/connector`, { headers: auth })).json()) as {
      mode: string;
      url: string;
      connections: { id: string; clientName: string; lastUsedAt: string | null }[];
    };
    expect(status.mode).toBe("signin");
    expect(status.url).toBe("https://daemon.example/mcp");
    expect(status.connections).toHaveLength(1);
    expect(status.connections[0].clientName).toBe("Claude");
    expect(JSON.stringify(status)).not.toContain(connection.access_token);

    expect(await saveAs(base, connection.access_token, "Before revoking.")).toMatch(/^Saved/);
    const revoked = await fetch(`${base}${sam.basePath}/connector/connections/${status.connections[0].id}/revoke`, { method: "POST", headers: auth });
    expect(revoked.status).toBe(200);
    expect((await json(base, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${connection.access_token}` })).status).toBe(401);
    const after = (await (await fetch(`${base}${sam.basePath}/connector`, { headers: auth })).json()) as { connections: unknown[] };
    expect(after.connections).toEqual([]);
  });

  it("does not let one duo revoke another duo's connection", async () => {
    const { base } = await start();
    const sam = await signUp(base, "sub-sam|sam@x.com|Sam");
    const kim = await signUp(base, "sub-kim|kim@x.com|Kim");
    const connection = await connect(base, "sub-sam|sam@x.com|Sam");
    const listed = (await (await fetch(`${base}${sam.basePath}/connector`, { headers: { authorization: `Bearer ${sam.token}` } })).json()) as { connections: { id: string }[] };

    const attempt = await fetch(`${base}${kim.basePath}/connector/connections/${listed.connections[0].id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${kim.token}` } });
    expect(attempt.status).toBe(404);
    expect(await saveAs(base, connection.access_token, "Still connected.")).toMatch(/^Saved/);
  });

  it("turns the secret connector URL off: it cannot be minted and is refused if presented", async () => {
    const { base } = await start();
    const sam = await signUp(base, "sub-sam|sam@x.com|Sam");
    const minted = await fetch(`${base}${sam.basePath}/connector`, { method: "POST", headers: { authorization: `Bearer ${sam.token}` } });
    expect(minted.status).toBe(409);
    const secret = await json(base, `${sam.basePath}/mcp/anything`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(secret.status).toBe(401);
    expect(JSON.stringify(await secret.json())).toContain("turned off");
  });
});

describe("OAuthStore", () => {
  function store(clock: { now: number }, path = join(tempDir(), "oauth.json")) {
    return { path, store: new OAuthStore(path, CLAUDE_REDIRECT_URIS, () => clock.now) };
  }
  function grantFor(oauth: OAuthStore, duoId: string) {
    const client = oauth.registerClient({ clientName: "Claude", redirectUris: [REDIRECT] });
    const { verifier, challenge } = pkce();
    const pending = oauth.beginAuthorization({ client, redirectUri: REDIRECT, state: undefined, codeChallenge: challenge });
    const code = oauth.issueCode(pending, duoId);
    return { client, tokens: oauth.exchangeCode({ code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier }) };
  }

  it("lets an access token lapse after an hour, but a refresh token carry on for a month", () => {
    const clock = { now: 1_000_000 };
    const { store: oauth } = store(clock);
    const { client, tokens } = grantFor(oauth, "duo-a");
    expect(oauth.verifyAccess(tokens.accessToken)).toMatchObject({ duoId: "duo-a" });

    clock.now += 61 * 60_000;
    expect(oauth.verifyAccess(tokens.accessToken)).toBeUndefined();
    const refreshed = oauth.refresh({ refreshToken: tokens.refreshToken, clientId: client.id });
    expect(oauth.verifyAccess(refreshed.accessToken)).toMatchObject({ duoId: "duo-a" });

    clock.now += 31 * 24 * 60 * 60_000;
    expect(() => oauth.refresh({ refreshToken: refreshed.refreshToken, clientId: client.id })).toThrow(OAuthError);
  });

  it("expires an unused code after five minutes", () => {
    const clock = { now: 1_000_000 };
    const { store: oauth } = store(clock);
    const client = oauth.registerClient({ clientName: "Claude", redirectUris: [REDIRECT] });
    const { verifier, challenge } = pkce();
    const code = oauth.issueCode(oauth.beginAuthorization({ client, redirectUri: REDIRECT, state: undefined, codeChallenge: challenge }), "duo-a");
    clock.now += 6 * 60_000;
    expect(() => oauth.exchangeCode({ code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier })).toThrow(/expired/);
  });

  it("keeps connections across a restart, and stores no raw token", async () => {
    const clock = { now: 1_000_000 };
    const first = store(clock);
    const { tokens } = grantFor(first.store, "duo-a");
    const restarted = new OAuthStore(first.path, CLAUDE_REDIRECT_URIS, () => clock.now);
    expect(restarted.verifyAccess(tokens.accessToken)).toMatchObject({ duoId: "duo-a" });
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(first.path, "utf8");
    expect(onDisk).not.toContain(tokens.accessToken);
    expect(onDisk).not.toContain(tokens.refreshToken);
  });

  it("refuses to register more clients than it will remember when all are in use", () => {
    const clock = { now: 1_000_000 };
    const { store: oauth } = store(clock);
    for (let i = 0; i < 100; i += 1) {
      grantFor(oauth, "duo-a");
    }
    expect(() => oauth.registerClient({ clientName: "One more", redirectUris: [REDIRECT] })).toThrow(/Too many/);
  });
});
