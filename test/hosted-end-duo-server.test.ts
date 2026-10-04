import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { runHostedEnd } from "../src/hosted/invite.js";
import { ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { createHostedServer, type HostedServer, type HostedServerExtras, type HostedSettings } from "../src/hosted/server.js";
import { createEncryptedStore } from "../src/store/store.js";
import type { ServeDeps } from "../src/serve/server.js";

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
  fake: FakeSynapse,
  overrides: Partial<HostedSettings> = {},
  options: { root?: ServeDeps; extras?: HostedServerExtras } = {},
): Promise<Started> {
  const logs: string[] = [];
  const hosted = await createHostedServer(
    { config: loadConfig({}), env: { DUO_CORS_ORIGINS: "https://web.example" }, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false },
    settings(overrides),
    options.root,
    undefined,
    { synapseFetch: fake.fetch, log: (line) => logs.push(line), provisionRetryMs: 3_600_000, ...options.extras },
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}`, logs };
}

const admin = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

async function post(base: string, path: string, headers: Record<string, string> = admin): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers, body: "{}" });
}

async function invite(base: string, orgId?: string): Promise<string> {
  const created = await fetch(`${base}/hosted/invites`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: "Sam", ...(orgId ? { orgId } : {}) }),
  });
  return ((await created.json()) as { code: string }).code;
}

async function signup(base: string, code: string, name = "Sam Tan"): Promise<{ tenantId: string; basePath: string }> {
  const response = await fetch(`${base}/hosted/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: code, name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { tenantId: string; basePath: string };
}

describe("ending a hosted duo through the daemon (#275)", () => {
  it("deactivates both Matrix accounts, removes it from its org's Space and rooms, drops its registry entry, and unmounts its app", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { hosted, base } = await start(fake);
    const { tenantId, basePath } = await signup(base, await invite(base));
    await hosted.matrix!.whenIdle();
    await hosted.spaces!.whenIdle();
    const { personUserId, duoUserId } = hosted.registry.matrixAccounts(tenantId)!;
    const org = hosted.registry.org("default")!;
    expect(fake.rooms.get(org.spaceRoomId!)!.members.has(personUserId)).toBe(true);
    expect((await fetch(`${base}${basePath}/health`)).status).toBe(200);

    const response = await post(base, `/hosted/duos/${tenantId}/end`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ duoId: tenantId, found: true, deactivated: { person: true, duo: true }, errors: [] });

    expect(fake.deactivated.get(personUserId)).toEqual({ erased: true });
    expect(fake.deactivated.get(duoUserId)).toEqual({ erased: true });
    // Deactivation with erase parts both accounts from every room they were in.
    expect(fake.rooms.get(org.spaceRoomId!)!.members.has(personUserId)).toBe(false);
    expect(fake.rooms.get(org.generalRoomId!)!.members.has(duoUserId)).toBe(false);

    expect(hosted.registry.tenants().some((tenant) => tenant.id === tenantId)).toBe(false);
    expect(hosted.registry.matrixAccounts(tenantId)).toBeUndefined();
    expect(hosted.registry.listOrgMembers("default").some((member) => member.duoId === tenantId)).toBe(false);

    // The per-duo app is unmounted: its old routes answer 404 (through the front), not 200.
    expect((await fetch(`${base}${basePath}/health`)).status).toBe(404);
  });

  it("drops the duo's live workspace connection", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { hosted, base } = await start(fake);
    const { tenantId } = await signup(base, await invite(base));
    await hosted.matrix!.whenIdle();
    expect(hosted.workspace!.states().some((state) => state.duoId === tenantId)).toBe(true);

    await post(base, `/hosted/duos/${tenantId}/end`);
    expect(hosted.workspace!.states().some((state) => state.duoId === tenantId)).toBe(false);
  });

  it("refuses the root duo with a clear message, and changes nothing", async () => {
    const fake = createFakeSynapse();
    const { hosted, base } = await start(fake, {}, { root: rootDeps() });
    const response = await post(base, `/hosted/duos/${ROOT_DUO_ID}/end`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("root_not_endable");
    expect(body.error.message).toMatch(/root duo/i);
    expect(hosted.registry.matrixAccounts(ROOT_DUO_ID)).toBeDefined();
  });

  it("is refused for anyone but the super admin: 401 with no credential, 403 with the wrong one", async () => {
    const fake = createFakeSynapse();
    const { base } = await start(fake);
    const { tenantId } = await signup(base, await invite(base));
    expect((await post(base, `/hosted/duos/${tenantId}/end`, { "content-type": "application/json" })).status).toBe(401);
    expect((await post(base, `/hosted/duos/${tenantId}/end`, { authorization: "Bearer nope", "content-type": "application/json" })).status).toBe(403);
  });

  it("ending an already-ended or nonexistent duo is idempotent: a clean 200 with found: false, not an error", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { base } = await start(fake);
    const { tenantId } = await signup(base, await invite(base));

    const first = await post(base, `/hosted/duos/${tenantId}/end`);
    expect(first.status).toBe(200);
    expect((await first.json()) as { found: boolean }).toMatchObject({ found: true });

    const second = await post(base, `/hosted/duos/${tenantId}/end`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ duoId: tenantId, found: false, deactivated: { person: false, duo: false }, errors: [] });

    const never = await post(base, `/hosted/duos/nosuchduoid/end`);
    expect(never.status).toBe(200);
    expect(await never.json()).toEqual({ duoId: "nosuchduoid", found: false, deactivated: { person: false, duo: false }, errors: [] });
  });

  it("`duo hosted end` (runHostedEnd) talks to the daemon and reports the outcome", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { base } = await start(fake);
    const { tenantId } = await signup(base, await invite(base));
    const env = { PORT: new URL(base).port, DUO_HOSTED_MASTER_KEY: MASTER, DUO_HOSTED_ADMIN_TOKEN: ADMIN };

    const outcome = await runHostedEnd(tenantId, env);
    expect(outcome).toEqual({ duoId: tenantId, found: true, deactivated: { person: true, duo: true }, errors: [] });

    const again = await runHostedEnd(tenantId, env);
    expect(again.found).toBe(false);
  });

  it("no Matrix token ever appears in the end route's response or the daemon's logs", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { hosted, base, logs } = await start(fake);
    const { tenantId } = await signup(base, await invite(base));
    await hosted.matrix!.whenIdle();
    const token = hosted.registry.duoMatrixToken(tenantId)!;
    const response = await post(base, `/hosted/duos/${tenantId}/end`);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(FAKE_ADMIN_TOKEN);
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).not.toContain(FAKE_ADMIN_TOKEN);
  });
});
