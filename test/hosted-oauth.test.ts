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

describe("what the owner allows at sign-in (#256)", () => {
  /** The whole flow with a requested scope and an owner's choice, returning the token answer. */
  async function connectScoped(base: string, opts: { scope?: string; scopes?: string[] }) {
    const clientId = await registerClient(base);
    const { verifier, challenge } = pkce();
    const requestId = requestIdFrom(await authorize(base, clientId, challenge, opts.scope === undefined ? {} : { scope: opts.scope }));
    const info = (await (await fetch(`${base}/oauth/requests/${requestId}`)).json()) as { scopes: { id: string; defaultOn: boolean; label: string }[] };
    const approved = await json(base, `/oauth/requests/${requestId}/approve`, { credential: "sub-sam|sam@x.com|Sam", ...(opts.scopes === undefined ? {} : { scopes: opts.scopes }) });
    return { info, approved, clientId, verifier, requestId };
  }

  async function exchange(base: string, flow: { approved: Response; clientId: string; verifier: string }) {
    const { redirectTo } = (await flow.approved.json()) as { redirectTo: string };
    const response = await token(base, { grant_type: "authorization_code", code: codeFrom(redirectTo), redirect_uri: REDIRECT, client_id: flow.clientId, code_verifier: flow.verifier });
    expect(response.status).toBe(200);
    return (await response.json()) as { access_token: string; refresh_token: string; scope: string };
  }

  async function callTool(base: string, accessToken: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const client = new Client({ name: "test-claude", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
    try {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, text: (result.content as { text: string }[])[0].text };
    } finally {
      await client.close();
    }
  }

  it("lists every permission Claude could be given, with sending off to start with, when Claude names none", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const flow = await connectScoped(base, {});
    expect(flow.info.scopes.map((scope) => scope.id)).toEqual(["duo:read", "duo:save", "duo:operate", "duo:send"]);
    expect(Object.fromEntries(flow.info.scopes.map((scope) => [scope.id, scope.defaultOn]))).toEqual({ "duo:read": true, "duo:save": true, "duo:operate": true, "duo:send": false });
  });

  it("grants read, save and operate, and never send, when the owner leaves the choices as they were", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const tokens = await exchange(base, await connectScoped(base, {}));
    expect(tokens.scope).toBe("duo:read duo:save duo:operate");
    expect((await callTool(base, tokens.access_token, "edit_draft", { id: "x", text: "y" })).text).toMatch(/Send permission \(duo:send\)/);
  });

  it("grants send when the owner ticks it", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const tokens = await exchange(base, await connectScoped(base, { scopes: ["duo:read", "duo:send"] }));
    expect(tokens.scope).toBe("duo:read duo:send");
    // Allowed to try: the refusal is now about the draft, not the permission.
    expect((await callTool(base, tokens.access_token, "mark_draft_sent", { id: "nope" })).text).toMatch(/No draft with id/);
  });

  it("shows only what Claude asked for, and grants no more than that whatever the owner sends", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const flow = await connectScoped(base, { scope: "duo:read", scopes: ["duo:read", "duo:send", "duo:operate"] });
    expect(flow.info.scopes.map((scope) => scope.id)).toEqual(["duo:read"]);
    const tokens = await exchange(base, flow);
    expect(tokens.scope).toBe("duo:read");
    const refused = await callTool(base, tokens.access_token, "save_to_duo", { text: "A note." });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Save permission \(duo:save\)/);
    expect((await callTool(base, tokens.access_token, "what_my_duo_knows", {})).isError).toBe(false);
  });

  it("refuses an owner who allows nothing, and keeps the request open", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const flow = await connectScoped(base, { scopes: [] });
    expect(flow.approved.status).toBe(400);
    expect(((await flow.approved.json()) as { error: { code: string } }).error.code).toBe("no_scopes");
    const retry = await approve(base, flow.requestId, "sub-sam|sam@x.com|Sam");
    expect(retry.status).toBe(200);
  });

  it("refuses a choice that names something that is not a permission", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const flow = await connectScoped(base, { scopes: ["duo:read", "duo:everything"] });
    expect(flow.approved.status).toBe(400);
  });

  it("sends Claude back with invalid_scope when it asks only for permissions this server does not offer", async () => {
    const { base } = await start();
    const clientId = await registerClient(base);
    const response = await authorize(base, clientId, pkce().challenge, { scope: "admin everything" });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_scope");
  });

  it("keeps the granted permissions through a refresh, and shows the owner what each connection may do", async () => {
    const { base } = await start();
    const sam = await signUp(base, "sub-sam|sam@x.com|Sam");
    const flow = await connectScoped(base, { scopes: ["duo:read", "duo:operate"] });
    const tokens = await exchange(base, flow);
    const refreshed = await token(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: flow.clientId });
    expect(((await refreshed.json()) as { scope: string }).scope).toBe("duo:read duo:operate");

    const status = (await (await fetch(`${base}${sam.basePath}/connector`, { headers: { authorization: `Bearer ${sam.token}` } })).json()) as { connections: { scopes: string[] }[] };
    expect(status.connections[0].scopes).toEqual(["duo:read", "duo:operate"]);
  });
});

describe("claude.ai connector by sign-in: hardening (#240 review)", () => {
  it("answers a repeated or malformed PKCE challenge by sending Claude back with an error, not a crash", async () => {
    const { base } = await start();
    const clientId = await registerClient(base);
    const good = pkce().challenge;

    const repeated = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${good}&code_challenge=${good}&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(repeated.status).toBe(302);
    expect(new URL(repeated.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");

    const malformed = await authorize(base, clientId, "short");
    expect(malformed.status).toBe(302);
    expect(new URL(malformed.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");

    const repeatedState = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${good}&code_challenge_method=S256&state=a&state=b`,
      { redirect: "manual" },
    );
    expect(new URL(repeatedState.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");
  });

  it("accepts the token endpoint's form body type there and nowhere else on the control app", async () => {
    const { base } = await start();
    const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ credential: "x|y@z.com|Y" }) };
    expect((await fetch(`${base}/hosted/login`, form)).status).toBe(415);
    expect((await token(base, { grant_type: "nope" })).status).toBe(400);
  });

  it("gives a code to only one of two overlapping approvals of the same request", async () => {
    const { base } = await start();
    await signUp(base, "sub-sam|sam@x.com|Sam");
    const clientId = await registerClient(base);
    const requestId = requestIdFrom(await authorize(base, clientId, pkce().challenge));

    const [first, second] = await Promise.all([approve(base, requestId, "sub-sam|sam@x.com|Sam"), approve(base, requestId, "sub-sam|sam@x.com|Sam")]);
    expect([first.status, second.status].sort()).toEqual([200, 404]);
  });

  it("counts failed token attempts per client, so one client's failures do not lock out another sharing its address", async () => {
    const { base } = await start();
    const noisy = await registerClient(base);
    const quiet = await registerClient(base);
    const bad = { grant_type: "refresh_token", refresh_token: "nope" };

    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      last = (await token(base, { ...bad, client_id: noisy })).status;
    }
    expect(last).toBe(429);
    expect((await token(base, { ...bad, client_id: quiet })).status).toBe(400);
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
    const code = oauth.issueCode(pending, duoId, ["duo:save"]);
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
    const code = oauth.issueCode(oauth.beginAuthorization({ client, redirectUri: REDIRECT, state: undefined, codeChallenge: challenge }), "duo-a", ["duo:save"]);
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
    const oauth = new OAuthStore(join(tempDir(), "oauth.json"), CLAUDE_REDIRECT_URIS, () => clock.now, { maxClients: 5 });
    for (let i = 0; i < 5; i += 1) {
      grantFor(oauth, "duo-a");
    }
    expect(() => oauth.registerClient({ clientName: "One more", redirectUris: [REDIRECT] })).toThrow(/Too many/);
  });

  it("forgets grants whose refresh token has lapsed, so their clients stop blocking new ones", () => {
    const clock = { now: 1_000_000 };
    const oauth = new OAuthStore(join(tempDir(), "oauth.json"), CLAUDE_REDIRECT_URIS, () => clock.now, { maxClients: 3 });
    for (let i = 0; i < 3; i += 1) {
      grantFor(oauth, "duo-a");
    }
    expect(oauth.connections("duo-a")).toHaveLength(3);
    expect(() => oauth.registerClient({ clientName: "Blocked", redirectUris: [REDIRECT] })).toThrow(/Too many/);

    clock.now += 31 * 24 * 60 * 60_000;
    expect(() => oauth.registerClient({ clientName: "Fits now", redirectUris: [REDIRECT] })).not.toThrow();
    expect(oauth.connections("duo-a")).toEqual([]);
  });

  it("does not forget a client that has only just registered to make room for another", () => {
    const clock = { now: 1_000_000 };
    const oauth = new OAuthStore(join(tempDir(), "oauth.json"), CLAUDE_REDIRECT_URIS, () => clock.now, { maxClients: 2 });
    const first = oauth.registerClient({ clientName: "First", redirectUris: [REDIRECT] });
    oauth.registerClient({ clientName: "Second", redirectUris: [REDIRECT] });
    expect(() => oauth.registerClient({ clientName: "Third", redirectUris: [REDIRECT] })).toThrow(/Too many/);
    expect(oauth.getClient(first.id)).toBeDefined();

    clock.now += 61 * 60_000;
    oauth.registerClient({ clientName: "Third", redirectUris: [REDIRECT] });
    expect(oauth.getClient(first.id)).toBeUndefined();
  });

  it("caps sign-ins waiting on an owner", () => {
    const clock = { now: 1_000_000 };
    const oauth = new OAuthStore(join(tempDir(), "oauth.json"), CLAUDE_REDIRECT_URIS, () => clock.now, { maxPendingRequests: 3 });
    const client = oauth.registerClient({ clientName: "Claude", redirectUris: [REDIRECT] });
    const begin = () => oauth.beginAuthorization({ client, redirectUri: REDIRECT, state: undefined, codeChallenge: pkce().challenge });
    begin();
    begin();
    begin();
    expect(begin).toThrow(/Too many sign-ins/);
    clock.now += 11 * 60_000;
    expect(begin).not.toThrow();
  });

  it("treats a grant made before permissions existed as save-only", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = join(tempDir(), "oauth.json");
    const clock = { now: 1_000_000 };
    const written = new OAuthStore(path, CLAUDE_REDIRECT_URIS, () => clock.now);
    const { tokens } = grantFor(written, "duo-a");
    // Strip the scopes the way a file written by the earlier version would lack them.
    const { readFileSync } = await import("node:fs");
    const file = JSON.parse(readFileSync(path, "utf8")) as { grants: { scopes?: string[] }[] };
    for (const grant of file.grants) {
      delete grant.scopes;
    }
    writeFileSync(path, JSON.stringify(file));
    const restarted = new OAuthStore(path, CLAUDE_REDIRECT_URIS, () => clock.now);
    expect(restarted.verifyAccess(tokens.accessToken)?.scopes).toEqual(["duo:save"]);
    expect(restarted.connections("duo-a")[0].scopes).toEqual(["duo:save"]);
  });

  it("sets a damaged file aside and starts empty rather than stopping the daemon", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    const path = join(tempDir(), "oauth.json");
    writeFileSync(path, "{ this is not json");
    const oauth = new OAuthStore(path, CLAUDE_REDIRECT_URIS);
    expect(oauth.connections("duo-a")).toEqual([]);
    expect(existsSync(`${path}.corrupt`)).toBe(true);
    expect(() => oauth.registerClient({ clientName: "Claude", redirectUris: [REDIRECT] })).not.toThrow();
  });
});
