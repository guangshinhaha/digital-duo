import { readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { runHostedProvision } from "../src/hosted/invite.js";
import { orgSpaceComplete } from "../src/hosted/org-spaces.js";
import { createHostedServer, type HostedServer, type HostedServerExtras, type HostedSettings } from "../src/hosted/server.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const MASTER = "master-key-for-tests";
const running: HostedServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function settings(): HostedSettings {
  return {
    hostedRoot: join(tempDir(), "hosted"),
    masterKey: MASTER,
    adminToken: ADMIN,
    publicUrl: "https://daemon.example",
    webUrl: "https://web.example",
    googleClientId: undefined,
    adminEmails: [],
    synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: "https://matrix.example.com" },
  };
}

async function start(fake: FakeSynapse, extras: HostedServerExtras = {}) {
  const hosted = await createHostedServer(
    {
      config: loadConfig({}),
      env: { DUO_CORS_ORIGINS: "https://web.example" },
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: undefined,
      trustProxy: false,
    },
    settings(),
    undefined,
    undefined,
    { synapseFetch: fake.fetch, log: () => {}, provisionRetryMs: 3_600_000, ...extras },
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}` };
}

const admin = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

async function post(base: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: admin, body: JSON.stringify(body) });
}

async function redeem(base: string, orgId: string, name = "Sam Tan"): Promise<string> {
  const invite = (await (await post(base, "/hosted/invites", { name, orgId })).json()) as { code: string };
  const response = await fetch(`${base}/hosted/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: invite.code, name }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { tenantId: string }).tenantId;
}

describe("org spaces through the hosted server", () => {
  it("creating an org makes its non-public Space and #general; the route reports their ids", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { hosted, base } = await start(fake);
    const response = await post(base, "/hosted/orgs", { name: "Platform team" });
    expect(response.status).toBe(201);
    const org = (await response.json()) as { id: string; spaceRoomId?: string; generalRoomId?: string };
    expect(org.spaceRoomId).toBeDefined();
    expect(fake.rooms.get(org.spaceRoomId!)).toMatchObject({ name: "Platform team", type: "m.space", joinRule: "invite" });
    expect(orgSpaceComplete(hosted.registry.org(org.id)!)).toBe(true);
    expect([...fake.rooms.values()].every((room) => room.joinRule === "invite" && room.visibility === "private")).toBe(true);
  });

  it("redeeming an invite puts the person and their duo in their org's Space and #general, and no other org's", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { hosted, base } = await start(fake);
    const a = (await (await post(base, "/hosted/orgs", { name: "Org A" })).json()) as { id: string };
    const b = (await (await post(base, "/hosted/orgs", { name: "Org B" })).json()) as { id: string };
    const inA = await redeem(base, a.id, "Ann");
    const inB = await redeem(base, b.id, "Bob");
    await hosted.matrix!.whenIdle();
    await hosted.spaces!.whenIdle();

    for (const [tenant, own, other] of [[inA, a.id, b.id], [inB, b.id, a.id]] as const) {
      const { personUserId, duoUserId } = hosted.registry.matrixAccounts(tenant)!;
      const ownOrg = hosted.registry.org(own)!;
      const otherOrg = hosted.registry.org(other)!;
      for (const roomId of [ownOrg.spaceRoomId!, ownOrg.generalRoomId!]) {
        expect(fake.rooms.get(roomId)!.members.has(personUserId)).toBe(true);
        expect(fake.rooms.get(roomId)!.members.has(duoUserId)).toBe(true);
      }
      for (const roomId of [otherOrg.spaceRoomId!, otherOrg.generalRoomId!]) {
        expect(fake.rooms.get(roomId)!.members.has(personUserId)).toBe(false);
        expect(fake.rooms.get(roomId)!.members.has(duoUserId)).toBe(false);
      }
    }
  });

  it("a Synapse outage blocks neither org creation nor an invite; both finish on the retry", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    fake.down = true;
    const { hosted, base } = await start(fake, { provisionRetryMs: 25, signupProvisionWaitMs: 30 });
    const response = await post(base, "/hosted/orgs", { name: "Platform team" });
    expect(response.status).toBe(201);
    const org = (await response.json()) as { id: string; spacePending?: unknown };
    expect(org.spacePending).toBeDefined();
    const tenant = await redeem(base, org.id);
    expect(hosted.registry.matrixSpaces(tenant)).toBeUndefined();

    fake.down = false;
    await expect.poll(() => hosted.registry.matrixSpaces(tenant), { timeout: 8_000 }).toBeDefined();
    expect(orgSpaceComplete(hosted.registry.org(org.id)!)).toBe(true);
    expect(hosted.registry.org(org.id)!.spacePending).toBeUndefined();
  });

  it("renaming an org through the route renames its Space", async () => {
    const fake = createFakeSynapse({ orgWall: true });
    const { hosted, base } = await start(fake);
    const org = (await (await post(base, "/hosted/orgs", { name: "Platform team" })).json()) as { id: string };
    const renamed = await post(base, `/hosted/orgs/${org.id}/rename`, { name: "Platform" });
    expect(renamed.status).toBe(200);
    expect(fake.rooms.get(hosted.registry.org(org.id)!.spaceRoomId!)!.name).toBe("Platform");
  });

  it("`duo hosted provision` backfills spaces for existing orgs and members, and repeating it is a no-op", async () => {
    // Life before spaces: a duo with accounts and an org with no rooms.
    const fake = createFakeSynapse({ orgWall: true });
    const before = await start(fake);
    const org = (await (await post(before.base, "/hosted/orgs", { name: "Old org" })).json()) as { id: string };
    const tenant = await redeem(before.base, org.id);
    await before.hosted.matrix!.whenIdle();
    await before.hosted.spaces!.whenIdle();
    await running.pop()!.close();
    // Forget the spaces the run above made: the registry as an older build left it.
    const path = join(tempDir(), "hosted", "registry.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { orgs: Array<Record<string, unknown>>; tenants: Array<Record<string, unknown>> };
    for (const entry of file.orgs) {
      for (const key of ["spaceRoomId", "generalRoomId", "spaceSyncedName", "generalLinked", "spacePending"]) {
        delete entry[key];
      }
    }
    for (const entry of file.tenants) {
      delete entry.matrixSpaces;
    }
    writeFileSync(path, JSON.stringify(file));
    const rooms = fake.rooms.size;
    // The old build's rooms are long past Synapse's 30 minute transaction window (else it would hand the same rooms back).
    fake.expireTransactions();

    const { hosted, base } = await start(fake);
    await hosted.matrix!.whenIdle();
    await hosted.spaces!.whenIdle();
    // The startup backfill already did it.
    expect(hosted.registry.matrixSpaces(tenant)).toBeDefined();
    expect(fake.rooms.size).toBe(rooms + 4);

    const env = { PORT: new URL(base).port, DUO_HOSTED_MASTER_KEY: MASTER, DUO_HOSTED_ADMIN_TOKEN: ADMIN };
    const again = await runHostedProvision(env);
    expect(again.spaces.orgs).toMatchObject({ provisioned: 0, already: 2, pending: 0 });
    expect(again.spaces.members).toMatchObject({ provisioned: 0, already: 1 });
    expect(JSON.stringify(again)).not.toContain("syt_");
  });
});
