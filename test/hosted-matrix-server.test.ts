import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { IdentityError, type IdentityVerifier } from "../src/hosted/google.js";
import { runHostedProvision } from "../src/hosted/invite.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import {
  createHostedServer,
  HostedConfigError,
  hostedSettingsFrom,
  HOSTED_SECRET_ENV,
  rootEnvFrom,
  synapseSettingsFrom,
  tenantDeps,
  tenantEnvFrom,
  type HostedServer,
  type HostedServerExtras,
  type HostedSettings,
} from "../src/hosted/server.js";
import type { ServeDeps } from "../src/serve/server.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const MASTER = "master-key-for-tests";
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
    synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: "https://matrix.example.com" },
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
}

async function start(
  overrides: Partial<HostedSettings> = {},
  options: { fake?: FakeSynapse; root?: ServeDeps; identity?: IdentityVerifier; extras?: HostedServerExtras } = {},
): Promise<Started> {
  const logs: string[] = [];
  const hosted = await createHostedServer(
    {
      config: loadConfig({}),
      env: { DUO_CORS_ORIGINS: "https://web.example" },
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: undefined,
      trustProxy: false,
    },
    settings(overrides),
    options.root,
    options.identity,
    { synapseFetch: options.fake?.fetch, log: (line) => logs.push(line), provisionRetryMs: 3_600_000, ...options.extras },
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}`, logs };
}

const admin = { authorization: `Bearer ${ADMIN}` };

async function invite(base: string, orgId?: string): Promise<string> {
  const response = await fetch(`${base}/hosted/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", ...admin },
    body: JSON.stringify({ name: "Sam", ...(orgId ? { orgId } : {}) }),
  });
  return ((await response.json()) as { code: string }).code;
}

async function signup(base: string, code: string, name = "Sam Tan", credential?: string): Promise<Response> {
  return fetch(`${base}/hosted/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: code, name, ...(credential ? { credential } : {}) }),
  });
}

describe("joining through an invite provisions Matrix accounts", () => {
  it("creates the person's and the duo's accounts on Synapse, in the invite's org, with no password", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({}, { fake });
    const org = hosted.registry.createOrg("Other Team");
    const response = await signup(base, await invite(base, org.id));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { tenantId: string };

    const accounts = hosted.registry.matrixAccounts(body.tenantId)!;
    expect(accounts.personUserId).toBe(`@${org.id}.${body.tenantId}:duo.test`);
    expect(accounts.duoUserId).toBe(`@duo-${org.id}.${body.tenantId}:duo.test`);
    expect(fake.users.get(accounts.personUserId)).toEqual({ displayname: "Sam Tan", admin: false, hasPassword: false });
    expect(fake.users.get(accounts.duoUserId)).toEqual({ displayname: "Sam Tan's duo", admin: false, hasPassword: false });
    expect(hosted.registry.duoMatrixToken(body.tenantId)).toBe(fake.minted[0]!.token);
  });

  it("takes the display name from the Google profile", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({ googleClientId: "cid" }, { fake, identity: fakeIdentity });
    const response = await fetch(`${base}/hosted/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: await invite(base), credential: "sub-1|sam@x.com|Sam From Google" }),
    });
    const { tenantId } = (await response.json()) as { tenantId: string };
    expect(fake.users.get(hosted.registry.matrixAccounts(tenantId)!.personUserId)!.displayname).toBe("Sam From Google");
  });

  it("a Synapse outage does not block the invite: the duo is served, marked pending, and retried", async () => {
    const fake = createFakeSynapse();
    fake.down = true;
    const { hosted, base } = await start({}, { fake, extras: { provisionRetryMs: 25 } });
    const response = await signup(base, await invite(base));
    expect(response.status).toBe(201);
    const { tenantId, basePath } = (await response.json()) as { tenantId: string; basePath: string };
    // The duo works even though it has no Matrix accounts yet.
    expect((await fetch(`${base}${basePath}/health`)).status).toBe(200);
    expect(hosted.registry.matrixAccounts(tenantId)).toBeUndefined();
    expect(hosted.registry.matrixPending(tenantId)).toBeDefined();

    fake.down = false;
    await expect.poll(() => hosted.registry.matrixAccounts(tenantId), { timeout: 5_000 }).toBeDefined();
    expect(hosted.registry.matrixPending(tenantId)).toBeUndefined();
  });

  it("a Synapse that hangs does not hold the sign-up past the wait", async () => {
    const fake = createFakeSynapse();
    fake.hangNext();
    const { hosted, base } = await start({}, { fake, extras: { signupProvisionWaitMs: 40, synapseTimeoutMs: 400 } });
    const started = Date.now();
    const response = await signup(base, await invite(base));
    expect(response.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(350);
    const { tenantId } = (await response.json()) as { tenantId: string };
    await hosted.matrix!.whenIdle();
    expect(hosted.registry.matrixPending(tenantId)).toBeDefined();
  });

  it("without the Synapse variables, hosted mode behaves as before and the provision route says so", async () => {
    const { hosted, base } = await start({ synapse: undefined });
    expect(hosted.matrix).toBeUndefined();
    const { tenantId } = (await (await signup(base, await invite(base))).json()) as { tenantId: string };
    expect(hosted.registry.matrixAccounts(tenantId)).toBeUndefined();
    const response = await fetch(`${base}/hosted/matrix/provision`, { method: "POST", headers: admin });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("matrix_not_configured");
  });
});

describe("the backfill", () => {
  it("at startup provisions every existing duo, and the root duo, when the admin token is configured", async () => {
    // Life before Synapse: two duos, no accounts.
    const before = await start({ synapse: undefined });
    const a = ((await (await signup(before.base, await invite(before.base), "A")).json()) as { tenantId: string }).tenantId;
    const b = ((await (await signup(before.base, await invite(before.base), "B")).json()) as { tenantId: string }).tenantId;
    await running.pop()!.close();

    const fake = createFakeSynapse();
    const { hosted } = await start({ hostedRoot: join(tempDir(), "hosted") }, { fake, root: rootDeps() });
    await hosted.matrix!.whenIdle();
    expect(hosted.registry.matrixAccounts(a)?.duoUserId).toBe(`@duo-default.${a}:duo.test`);
    expect(hosted.registry.matrixAccounts(b)?.personUserId).toBe(`@default.${b}:duo.test`);
    expect(hosted.registry.matrixAccounts("root")?.duoUserId).toBe("@duo-default.root:duo.test");
    expect(fake.users.size).toBe(6);
    expect(fake.minted).toHaveLength(3);
  });

  it("a restart is a no-op once everything is provisioned", async () => {
    const fake = createFakeSynapse();
    const first = await start({}, { fake });
    await signup(first.base, await invite(first.base));
    await first.hosted.matrix!.whenIdle();
    await running.pop()!.close();
    const calls = fake.requests.length;

    const second = await start({}, { fake });
    await second.hosted.matrix!.whenIdle();
    expect(fake.requests).toHaveLength(calls);
    expect(fake.minted).toHaveLength(1);
  });

  it("a Synapse that is down at startup leaves duos pending and the server up; the admin route finishes it later", async () => {
    const before = await start({ synapse: undefined });
    const id = ((await (await signup(before.base, await invite(before.base))).json()) as { tenantId: string }).tenantId;
    await running.pop()!.close();

    const fake = createFakeSynapse();
    fake.down = true;
    const { hosted, base } = await start({}, { fake });
    await hosted.matrix!.whenIdle();
    expect(hosted.registry.matrixPending(id)).toBeDefined();
    expect((await fetch(`${base}/hosted/health`)).status).toBe(200);

    fake.down = false;
    const response = await fetch(`${base}/hosted/matrix/provision`, { method: "POST", headers: admin });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provisioned: 1, already: 0, pending: 0 });
    expect(hosted.registry.matrixAccounts(id)).toBeDefined();
  });

  it("`duo hosted provision` (runHostedProvision) asks the running daemon, finishes owed accounts, and is idempotent", async () => {
    const before = await start({ synapse: undefined });
    const id = ((await (await signup(before.base, await invite(before.base))).json()) as { tenantId: string }).tenantId;
    await running.pop()!.close();

    const fake = createFakeSynapse();
    fake.down = true;
    const { base } = await start({}, { fake });
    const env = { PORT: new URL(base).port, DUO_HOSTED_MASTER_KEY: MASTER, DUO_HOSTED_ADMIN_TOKEN: ADMIN };
    expect(await runHostedProvision(env)).toMatchObject({ provisioned: 0, pending: 1 });

    fake.down = false;
    const done = await runHostedProvision(env);
    expect(done).toMatchObject({ provisioned: 1, already: 0, pending: 0 });
    expect(done.outcomes[0]).toMatchObject({ duoId: id, status: "provisioned" });
    expect(await runHostedProvision(env)).toMatchObject({ provisioned: 0, already: 1, pending: 0 });
    expect(JSON.stringify(done)).not.toContain("syt_");
  });
});

describe("no route returns the duo's Matrix token, or the admin token", () => {
  it("sweeps every response the server can give for either token or the token ciphertext", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start({ googleClientId: "cid", adminEmails: ["shin@x.com"] }, { fake, root: rootDeps(), identity: fakeIdentity });
    const code = await invite(base);
    const signupResponse = await fetch(`${base}/hosted/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: code, credential: "sub-1|sam@x.com|Sam" }),
    });
    const signupBody = await signupResponse.text();
    const { tenantId, token: deviceToken } = JSON.parse(signupBody) as { tenantId: string; token: string };
    await hosted.matrix!.whenIdle();
    const login = await fetch(`${base}/hosted/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "sub-1|sam@x.com|Sam" }),
    });
    await fetch(`${base}/hosted/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: "sub-2|shin@x.com|Shin" }) });
    await hosted.matrix!.whenIdle();

    const bodies = [signupBody, await login.text()];
    for (const path of ["/hosted/duos", "/hosted/orgs", "/hosted/invites", "/hosted/config", "/hosted/health", `/hosted/orgs/default/members`]) {
      bodies.push(await (await fetch(`${base}${path}`, { headers: admin })).text());
    }
    bodies.push(await (await fetch(`${base}/hosted/matrix/provision`, { method: "POST", headers: admin })).text());
    for (const path of ["/health", "/knowledge", "/duos"]) {
      bodies.push(await (await fetch(`${base}/t/${tenantId}${path}`, { headers: { authorization: `Bearer ${deviceToken}` } })).text());
    }

    const secrets = [FAKE_ADMIN_TOKEN, ...fake.minted.map((entry) => entry.token), hosted.registry.duoMatrixToken(tenantId)!];
    const cipher = hosted.registry.tenants().find((tenant) => tenant.id === tenantId)!.matrix!.duoTokenCipher;
    expect(fake.minted.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      for (const secret of [...secrets, cipher]) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it("the admin's duo listing shows a duo's account ids and date, and no ciphertext", async () => {
    const fake = createFakeSynapse();
    const { base } = await start({}, { fake });
    const { tenantId } = (await (await signup(base, await invite(base))).json()) as { tenantId: string };
    const listing = (await (await fetch(`${base}/hosted/duos`, { headers: admin })).json()) as Array<Record<string, unknown>>;
    expect(listing[0]!.id).toBe(tenantId);
    expect(listing[0]!.matrix).toEqual({
      personUserId: `@default.${tenantId}:duo.test`,
      duoUserId: `@duo-default.${tenantId}:duo.test`,
      provisionedAt: expect.any(String),
    });
    expect(listing[0]).not.toHaveProperty("passphraseCipher");
  });

  it("only the admin may run the backfill", async () => {
    const { base } = await start({}, { fake: createFakeSynapse() });
    expect((await fetch(`${base}/hosted/matrix/provision`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/hosted/matrix/provision`, { method: "POST", headers: { authorization: "Bearer nope" } })).status).toBe(403);
  });

  it("neither the registry file nor the server's logs hold a token in the clear", async () => {
    const fake = createFakeSynapse();
    fake.failNext(1, 500);
    const { hosted, base, logs } = await start({}, { fake });
    await signup(base, await invite(base));
    await hosted.matrix!.provisionAll();
    const { readFileSync } = await import("node:fs");
    const file = readFileSync(join(tempDir(), "hosted", "registry.json"), "utf8");
    for (const secret of [FAKE_ADMIN_TOKEN, ...fake.minted.map((entry) => entry.token)]) {
      expect(file).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    expect(fake.minted).toHaveLength(1);
  });
});

describe("a duo's env is built from an allowlist", () => {
  const processEnv: NodeJS.ProcessEnv = {
    DUO_HOSTED_MASTER_KEY: "master-key-secret-value",
    DUO_HOSTED_ADMIN_TOKEN: "hosted-admin-secret-value",
    DUO_WORKSPACE_ADMIN_TOKEN: "synapse-admin-secret-value",
    DUO_WORKSPACE_ACCESS_TOKEN: "workspace-token-secret-value",
    DUO_OPENROUTER_API_KEY: "openrouter-secret-value",
    DUO_PASSPHRASE: "root-passphrase-secret-value",
    DUO_CORS_ORIGINS: "https://web.example",
    DUO_WS_REVERIFY_MS: "1000",
  };

  it("a tenant's deps.env holds the allowlisted variables and its own paths, and none of the secrets", async () => {
    const registry = new HostedRegistry(join(tempDir(), "registry.json"), MASTER);
    const { invite: redeemable } = registry.createInvite("Sam", new Date(Date.now() + 3_600_000).toISOString());
    const tenant = registry.addTenant(redeemable.id, "Sam", "tenant-passphrase");
    const shared = { config: loadConfig({}), env: processEnv, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false };
    const deps = tenantDeps(shared, settings(), tenant, "tenant-passphrase");

    expect(deps.env.DUO_CORS_ORIGINS).toBe("https://web.example");
    expect(deps.env.DUO_WS_REVERIFY_MS).toBe("1000");
    expect(deps.env.DUO_STORE_PATH).toContain(tenant.id);
    const everything = JSON.stringify(deps.env);
    for (const [key, value] of Object.entries(processEnv)) {
      if (key.includes("SECRET") || /KEY|TOKEN|PASSPHRASE/.test(key)) {
        expect(everything).not.toContain(value!);
      }
    }
    // Only the tenant's own passphrase is there, under its own name.
    expect(deps.env.DUO_PASSPHRASE).toBe("tenant-passphrase");
    expect(Object.keys(tenantEnvFrom(processEnv)).sort()).toEqual(["DUO_CORS_ORIGINS", "DUO_WS_REVERIFY_MS"]);
  });

  it("the root duo keeps its env minus the three hosted secrets", () => {
    const env = rootEnvFrom(processEnv);
    for (const key of HOSTED_SECRET_ENV) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.DUO_PASSPHRASE).toBe("root-passphrase-secret-value");
    expect(env.DUO_CORS_ORIGINS).toBe("https://web.example");
    // The caller's env is not mutated.
    expect(processEnv.DUO_HOSTED_MASTER_KEY).toBe("master-key-secret-value");
  });
});

describe("the Synapse admin variables", () => {
  it("are read from DUO_WORKSPACE_PRIVATE_URL, DUO_WORKSPACE_ADMIN_TOKEN, and optionally the server name and public URL", () => {
    const env = {
      DUO_HOSTED_MASTER_KEY: "x".repeat(20),
      DUO_HOSTED_ADMIN_TOKEN: "y".repeat(20),
      DUO_WORKSPACE_PRIVATE_URL: "http://synapse.railway.internal:8008",
      DUO_WORKSPACE_ADMIN_TOKEN: "syt_admin",
      DUO_WORKSPACE_SERVER_NAME: "duo",
      DUO_WORKSPACE_PUBLIC_URL: "https://matrix.example.com/",
    };
    expect(hostedSettingsFrom(env).synapse).toEqual({
      adminUrl: "http://synapse.railway.internal:8008",
      adminToken: "syt_admin",
      serverName: "duo",
      publicUrl: "https://matrix.example.com",
    });
  });

  it("never read DUO_WORKSPACE_HOMESERVER: that variable belongs to the personal-hardware trio", () => {
    expect(() => synapseSettingsFrom({ DUO_WORKSPACE_HOMESERVER: "https://m.example.com", DUO_WORKSPACE_ADMIN_TOKEN: "t" })).toThrow(/DUO_WORKSPACE_PRIVATE_URL/);
    expect(synapseSettingsFrom({ DUO_WORKSPACE_HOMESERVER: "https://m.example.com" })).toBeUndefined();
  });

  it("are all-or-nothing, and the URL must be https or on the private network", () => {
    expect(synapseSettingsFrom({})).toBeUndefined();
    expect(() => synapseSettingsFrom({ DUO_WORKSPACE_PRIVATE_URL: "https://m.example.com" })).toThrow(/DUO_WORKSPACE_ADMIN_TOKEN/);
    expect(() => synapseSettingsFrom({ DUO_WORKSPACE_ADMIN_TOKEN: "t" })).toThrow(/DUO_WORKSPACE_PRIVATE_URL/);
    expect(() => synapseSettingsFrom({ DUO_WORKSPACE_PRIVATE_URL: "http://m.example.com", DUO_WORKSPACE_ADMIN_TOKEN: "t" })).toThrow(HostedConfigError);
    let message = "";
    try {
      synapseSettingsFrom({ DUO_WORKSPACE_PRIVATE_URL: "http://m.example.com", DUO_WORKSPACE_ADMIN_TOKEN: "super-secret-admin" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("super-secret-admin");
  });
});
