import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MatrixProvisioner, orgIdOfUserId } from "../src/hosted/matrix-accounts.js";
import { OrgSpaceProvisioner, GENERAL_ROOM_NAME, orgSpaceComplete } from "../src/hosted/org-spaces.js";
import { DEFAULT_ORG_ID, ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { SynapseAdmin } from "../src/hosted/synapse-admin.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const MASTER = "master-key-for-tests";

function setup(options: { fake?: FakeSynapse; retryBaseMs?: number } = {}) {
  const path = join(tempDir(), "registry.json");
  const registry = new HostedRegistry(path, MASTER);
  // The fake enforces the org wall on joins, as the module (#235) will: provisioning joins must pass it.
  const fake = options.fake ?? createFakeSynapse({ orgWall: true });
  const logs: string[] = [];
  const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch });
  const accounts = new MatrixProvisioner({ registry, admin, serverName: "duo.test", log: (line) => logs.push(line) });
  const spaces = new OrgSpaceProvisioner({ registry, admin, serverName: "duo.test", log: (line) => logs.push(line), retryBaseMs: options.retryBaseMs });
  return { registry, fake, logs, accounts, spaces, path };
}

function addDuo(registry: HostedRegistry, name: string, orgId = DEFAULT_ORG_ID): string {
  const { invite } = registry.createInvite(name, new Date(Date.now() + 3_600_000).toISOString(), null, orgId);
  return registry.addTenant(invite.id, name, "passphrase").id;
}

const roomsCalls = (fake: FakeSynapse) => fake.requests.filter((request) => /createRoom|\/state\/|\/join\//.test(request.path));

describe("OrgSpaceProvisioner: an org's Space and #general", () => {
  it("creates a non-public Space (named after the org) and a non-public #general in it, and records both ids", async () => {
    const { registry, fake, spaces } = setup();
    const org = registry.createOrg("Platform team");
    const outcome = await spaces.ensureOrg(org.id);

    expect(outcome.status).toBe("provisioned");
    const stored = registry.org(org.id)!;
    expect(stored.spaceRoomId).toBe(outcome.spaceRoomId);
    expect(stored.generalRoomId).toBe(outcome.generalRoomId);
    expect(orgSpaceComplete(stored)).toBe(true);
    expect(stored.spacePending).toBeUndefined();

    const space = fake.rooms.get(stored.spaceRoomId!)!;
    const general = fake.rooms.get(stored.generalRoomId!)!;
    expect(space).toMatchObject({ name: "Platform team", type: "m.space", visibility: "private", preset: "private_chat", joinRule: "invite" });
    expect(general).toMatchObject({ name: GENERAL_ROOM_NAME, type: undefined, visibility: "private", preset: "private_chat", joinRule: "invite" });
    // #general is a child of the Space, the service account is in both, and nothing anywhere is public.
    expect(space.children.get(general.roomId)).toEqual({ via: ["duo.test"], suggested: true });
    expect(space.members.has("@workspace-admin:duo.test")).toBe(true);
    expect(general.members.has("@workspace-admin:duo.test")).toBe(true);
    expect([...fake.rooms.values()].every((room) => room.joinRule === "invite" && room.visibility === "private")).toBe(true);
  });

  it("a second run is a no-op: no call at all", async () => {
    const { registry, fake, spaces } = setup();
    const org = registry.createOrg("Platform team");
    await spaces.syncAll();
    const calls = fake.requests.length;
    expect((await spaces.ensureOrg(org.id)).status).toBe("already");
    expect((await spaces.syncAll()).orgs).toMatchObject({ provisioned: 0, already: 2 });
    expect(fake.requests).toHaveLength(calls);
    // The default org and this one, a Space and a #general each.
    expect(fake.rooms.size).toBe(4);
  });

  it("concurrent callers share one attempt, so an org never gets two Spaces", async () => {
    const { registry, fake, spaces } = setup();
    const org = registry.createOrg("Platform team");
    await Promise.all([spaces.ensureOrg(org.id), spaces.ensureOrg(org.id), spaces.ensureOrg(org.id)]);
    expect([...fake.rooms.values()].filter((room) => room.name === "Platform team")).toHaveLength(1);
  });

  it("a Synapse outage marks the org pending (never throws), and the retry finishes it", async () => {
    const { registry, fake, spaces } = setup({ retryBaseMs: 1 });
    fake.down = true;
    const org = registry.createOrg("Platform team");
    const outcome = await spaces.ensureOrg(org.id);
    expect(outcome.status).toBe("pending");
    expect(registry.org(org.id)!.spacePending).toMatchObject({ attempts: 1 });
    expect(registry.org(org.id)!.spaceRoomId).toBeUndefined();
    expect(spaces.hasRetryDue(Date.now() + 10_000)).toBe(true);

    fake.down = false;
    const retried = await spaces.retryPending(Date.now() + 10_000);
    // The default org, which never had a Space, is due too.
    expect(retried.orgs.provisioned).toBe(2);
    expect(orgSpaceComplete(registry.org(org.id)!)).toBe(true);
    expect(registry.org(org.id)!.spacePending).toBeUndefined();
  });

  it("backs off between failed attempts, like the accounts flow", async () => {
    const { registry, fake, spaces } = setup({ retryBaseMs: 60_000 });
    fake.down = true;
    registry.createOrg("Platform team");
    await spaces.syncAll();
    expect(spaces.hasRetryDue(Date.now() + 1_000)).toBe(false);
    expect(spaces.hasRetryDue(Date.now() + 61_000)).toBe(true);
  });

  it("resumes half-finished work: a Space that exists is not created again when #general fails", async () => {
    const { registry, fake, spaces } = setup();
    const org = registry.createOrg("Platform team");
    // Space is call 1 (succeeds); #general is call 2 (fails once).
    let seen = 0;
    const realFetch = fake.fetch;
    const flaky: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      if (path.endsWith("/createRoom") && (seen += 1) === 2) {
        return new Response(JSON.stringify({ errcode: "M_UNKNOWN" }), { status: 500 });
      }
      return realFetch(input, init);
    };
    const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: flaky });
    const partial = new OrgSpaceProvisioner({ registry, admin, serverName: "duo.test", log: () => {} });
    expect((await partial.ensureOrg(org.id)).status).toBe("pending");
    const spaceRoomId = registry.org(org.id)!.spaceRoomId;
    expect(spaceRoomId).toBeDefined();
    expect(registry.org(org.id)!.generalRoomId).toBeUndefined();

    expect((await partial.ensureOrg(org.id)).status).toBe("provisioned");
    expect(registry.org(org.id)!.spaceRoomId).toBe(spaceRoomId);
    expect(fake.rooms.size).toBe(2);
  });

  it("renaming the org renames the Space, once, and #general keeps its name", async () => {
    const { registry, fake, spaces } = setup();
    const org = registry.createOrg("Platform team");
    await spaces.ensureOrg(org.id);
    registry.renameOrg(org.id, "Platform");
    expect(orgSpaceComplete(registry.org(org.id)!)).toBe(false);

    expect((await spaces.ensureOrg(org.id)).status).toBe("provisioned");
    const stored = registry.org(org.id)!;
    expect(fake.rooms.get(stored.spaceRoomId!)!.name).toBe("Platform");
    expect(fake.rooms.get(stored.generalRoomId!)!.name).toBe(GENERAL_ROOM_NAME);
    const calls = fake.requests.length;
    expect((await spaces.ensureOrg(org.id)).status).toBe("already");
    expect(fake.requests).toHaveLength(calls);
  });

  it("a rename while Synapse is down is pending and lands on the retry", async () => {
    const { registry, fake, spaces } = setup({ retryBaseMs: 1 });
    const org = registry.createOrg("Platform team");
    await spaces.ensureOrg(org.id);
    registry.renameOrg(org.id, "Platform");
    fake.down = true;
    expect((await spaces.ensureOrg(org.id)).status).toBe("pending");
    fake.down = false;
    await spaces.retryPending(Date.now() + 10_000);
    expect(fake.rooms.get(registry.org(org.id)!.spaceRoomId!)!.name).toBe("Platform");
  });

  it("never sends a token anywhere but the Authorization header, and logs none", async () => {
    const { registry, fake, logs, spaces } = setup();
    const org = registry.createOrg("Platform team");
    const id = addDuo(registry, "Sam", org.id);
    await spaces.syncMember(id);
    expect(JSON.stringify(fake.requests.map((request) => [request.path, request.body]))).not.toContain(FAKE_ADMIN_TOKEN);
    expect(logs.join("\n")).not.toContain(FAKE_ADMIN_TOKEN);
    expect(logs.join("\n")).not.toContain("syt_");
  });
});

describe("OrgSpaceProvisioner: members", () => {
  it("joins the person and the duo into the Space and #general, after their accounts exist", async () => {
    const { registry, fake, accounts, spaces } = setup();
    const org = registry.createOrg("Platform team");
    const id = addDuo(registry, "Sam", org.id);

    // Before accounts there is nothing to join, and that is not an error.
    expect((await spaces.syncMember(id)).status).toBe("waiting");
    expect(fake.rooms.size).toBe(0);

    await accounts.provision(id);
    expect((await spaces.syncMember(id)).status).toBe("provisioned");
    const { personUserId, duoUserId } = registry.matrixAccounts(id)!;
    const stored = registry.org(org.id)!;
    for (const roomId of [stored.spaceRoomId!, stored.generalRoomId!]) {
      const room = fake.rooms.get(roomId)!;
      expect(room.members.has(personUserId)).toBe(true);
      expect(room.members.has(duoUserId)).toBe(true);
    }
    expect(registry.matrixSpaces(id)).toMatchObject({ spaceRoomId: stored.spaceRoomId, generalRoomId: stored.generalRoomId });
    expect(registry.spacePending(id)).toBeUndefined();
  });

  it("is idempotent: a recorded member costs no call", async () => {
    const { registry, fake, accounts, spaces } = setup();
    const id = addDuo(registry, "Sam");
    await accounts.provision(id);
    await spaces.syncMember(id);
    const calls = fake.requests.length;
    expect((await spaces.syncMember(id)).status).toBe("already");
    expect((await spaces.syncAll()).members).toMatchObject({ provisioned: 0, already: 1 });
    expect(fake.requests).toHaveLength(calls);
  });

  it("survives a restart: the registry alone says who is in", async () => {
    const { registry, path, accounts, spaces, fake } = setup();
    const id = addDuo(registry, "Sam");
    await accounts.provision(id);
    await spaces.syncMember(id);
    const reopened = new HostedRegistry(path, MASTER);
    const again = new OrgSpaceProvisioner({ registry: reopened, admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch }), serverName: "duo.test", log: () => {} });
    const calls = fake.requests.length;
    expect((await again.syncAll()).members.already).toBe(1);
    expect(fake.requests).toHaveLength(calls);
  });

  it("an outage leaves the member pending, never throws, and the retry joins them", async () => {
    const { registry, fake, accounts, spaces } = setup({ retryBaseMs: 1 });
    const id = addDuo(registry, "Sam");
    await accounts.provision(id);
    fake.down = true;
    expect((await spaces.syncMember(id)).status).toBe("pending");
    expect(registry.spacePending(id)).toBeDefined();
    expect(registry.matrixSpaces(id)).toBeUndefined();

    fake.down = false;
    const summary = await spaces.retryPending(Date.now() + 10_000);
    expect(summary.orgs.provisioned).toBe(1);
    expect(summary.members.provisioned).toBe(1);
    expect(registry.matrixSpaces(id)).toBeDefined();
    expect(registry.spacePending(id)).toBeUndefined();
  });

  it("a member whose joins half-fail is finished by the next run without creating anything new", async () => {
    const { registry, fake, accounts, spaces } = setup();
    const id = addDuo(registry, "Sam");
    await accounts.provision(id);
    await spaces.ensureOrg(DEFAULT_ORG_ID);
    // Space create, link and #general are done (calls 1-3 counted here); let the person's two joins pass, then fail the duo's.
    const start = fake.requests.length;
    const original = fake.fetch;
    let joins = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.includes("/join/") && (joins += 1) === 3) {
        return new Response(JSON.stringify({ errcode: "M_UNKNOWN" }), { status: 502 });
      }
      return original(input, init);
    };
    const partial = new OrgSpaceProvisioner({
      registry,
      admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: flaky }),
      serverName: "duo.test",
      log: () => {},
    });
    expect((await partial.syncMember(id)).status).toBe("pending");
    expect(registry.matrixSpaces(id)).toBeUndefined();
    expect((await partial.syncMember(id)).status).toBe("provisioned");
    expect(fake.rooms.size).toBe(2);
    expect(fake.requests.length).toBeGreaterThan(start);
    const { duoUserId } = registry.matrixAccounts(id)!;
    expect(fake.rooms.get(registry.org(DEFAULT_ORG_ID)!.spaceRoomId!)!.members.has(duoUserId)).toBe(true);
  });

  it("the pre-hosted root duo is joined to its org's Space too", async () => {
    const { registry, fake, accounts, spaces } = setup();
    registry.declareRootDuo("Shin");
    await accounts.provision(ROOT_DUO_ID);
    expect((await spaces.syncMember(ROOT_DUO_ID)).status).toBe("provisioned");
    const space = fake.rooms.get(registry.org(DEFAULT_ORG_ID)!.spaceRoomId!)!;
    expect(space.members.has("@default.root:duo.test")).toBe(true);
    expect(space.members.has("@duo-default.root:duo.test")).toBe(true);
    expect(registry.matrixSpaces(ROOT_DUO_ID)).toBeDefined();
    // It survives a restart.
    expect(new HostedRegistry(join(tempDir(), "registry.json"), MASTER).matrixSpaces(ROOT_DUO_ID)).toBeDefined();
  });
});

describe("OrgSpaceProvisioner: the org wall", () => {
  it("a member of org A is never joined to org B's Space or #general, and each org's rooms hold only its own", async () => {
    const { registry, fake, accounts, spaces } = setup();
    const a = registry.createOrg("Org A");
    const b = registry.createOrg("Org B");
    const inA = addDuo(registry, "Ann", a.id);
    const inB = addDuo(registry, "Bob", b.id);
    await accounts.provisionAll();
    await spaces.syncAll();

    const roomsOf = (orgId: string) => [registry.org(orgId)!.spaceRoomId!, registry.org(orgId)!.generalRoomId!].map((roomId) => fake.rooms.get(roomId)!);
    expect(registry.org(a.id)!.spaceRoomId).not.toBe(registry.org(b.id)!.spaceRoomId);
    for (const room of roomsOf(a.id)) {
      const members = [...room.members].filter((member) => member !== "@workspace-admin:duo.test");
      expect(members.sort()).toEqual([registry.matrixAccounts(inA)!.duoUserId, registry.matrixAccounts(inA)!.personUserId].sort());
      expect(members.every((member) => orgIdOfUserId(member) === a.id)).toBe(true);
    }
    for (const room of roomsOf(b.id)) {
      expect([...room.members].filter((member) => member !== "@workspace-admin:duo.test").every((member) => orgIdOfUserId(member) === b.id)).toBe(true);
    }
    expect(registry.matrixSpaces(inB)!.spaceRoomId).toBe(registry.org(b.id)!.spaceRoomId);
  });

  it("refuses to join accounts whose ids belong to another org than the duo's, and joins nothing", async () => {
    const { registry, fake, accounts, spaces, path, logs } = setup();
    const a = registry.createOrg("Org A");
    const b = registry.createOrg("Org B");
    const id = addDuo(registry, "Ann", a.id);
    await accounts.provision(id);
    await spaces.ensureOrg(b.id);
    // Tamper: the registry now says the duo's accounts are org B's.
    const file = JSON.parse(readFileSync(path, "utf8")) as { tenants: Array<{ id: string; matrix: { personUserId: string; duoUserId: string } }> };
    const tenant = file.tenants.find((candidate) => candidate.id === id)!;
    tenant.matrix.personUserId = `@${b.id}.${id}:duo.test`;
    tenant.matrix.duoUserId = `@duo-${b.id}.${id}:duo.test`;
    writeFileSync(path, JSON.stringify(file));
    const tampered = new HostedRegistry(path, MASTER);
    const strict = new OrgSpaceProvisioner({ registry: tampered, admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch }), serverName: "duo.test", log: (line) => logs.push(line) });

    const before = fake.requests.filter((request) => request.path.includes("/join/")).length;
    const outcome = await strict.syncMember(id);
    expect(outcome.status).toBe("failed");
    expect(fake.requests.filter((request) => request.path.includes("/join/"))).toHaveLength(before);
    expect(tampered.matrixSpaces(id)).toBeUndefined();
  });

  it("the org wall in the fake also stops a stray cross-org join at Synapse (the module's job, #235)", async () => {
    const { registry, fake, accounts, spaces } = setup();
    const a = registry.createOrg("Org A");
    const b = registry.createOrg("Org B");
    const inA = addDuo(registry, "Ann", a.id);
    const inB = addDuo(registry, "Bob", b.id);
    await accounts.provisionAll();
    await spaces.syncAll();
    const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch });
    await expect(admin.joinUser(registry.org(a.id)!.spaceRoomId!, registry.matrixAccounts(inB)!.personUserId)).rejects.toMatchObject({ status: 403, errcode: "M_FORBIDDEN" });
    expect(registry.matrixAccounts(inA)!.personUserId).not.toBe(registry.matrixAccounts(inB)!.personUserId);
  });
});

describe("OrgSpaceProvisioner: the backfill", () => {
  it("covers the default org and every existing org and member, and the sweep is safe to repeat", async () => {
    const { registry, fake, accounts, spaces } = setup();
    registry.declareRootDuo("Shin");
    const other = registry.createOrg("Other");
    addDuo(registry, "A");
    addDuo(registry, "B", other.id);
    await accounts.provisionAll();

    const first = await spaces.syncAll();
    expect(first.orgs).toMatchObject({ provisioned: 2, pending: 0, failed: 0 });
    expect(first.members).toMatchObject({ provisioned: 3, pending: 0, failed: 0, waiting: 0 });
    expect(registry.orgs().every(orgSpaceComplete)).toBe(true);

    const calls = fake.requests.length;
    const second = await spaces.syncAll();
    expect(second.orgs).toMatchObject({ provisioned: 0, already: 2 });
    expect(second.members).toMatchObject({ provisioned: 0, already: 3 });
    expect(fake.requests).toHaveLength(calls);
    expect(roomsCalls(fake).length).toBeGreaterThan(0);
  });

  it("members whose accounts are still owed are `waiting`, not failures", async () => {
    const { registry, spaces } = setup();
    addDuo(registry, "A");
    const summary = await spaces.syncAll();
    expect(summary.members).toMatchObject({ waiting: 1, pending: 0, failed: 0 });
    expect(summary.orgs.provisioned).toBe(1);
  });
});

describe("the registry additions are backward compatible", () => {
  it("a registry with no space fields loads, and an org's space fields survive a rename and a reload", async () => {
    const { registry, path, spaces } = setup();
    const org = registry.createOrg("Platform team");
    await spaces.ensureOrg(org.id);
    registry.renameOrg(org.id, "Platform");
    const reopened = new HostedRegistry(path, MASTER);
    expect(reopened.org(org.id)).toMatchObject({ name: "Platform", spaceRoomId: registry.org(org.id)!.spaceRoomId, generalRoomId: registry.org(org.id)!.generalRoomId });

    const file = JSON.parse(readFileSync(path, "utf8")) as { orgs: Array<Record<string, unknown>>; version: number };
    expect(file.version).toBe(2);
    for (const entry of file.orgs) {
      delete entry.spaceRoomId;
      delete entry.generalRoomId;
      delete entry.spaceSyncedName;
      delete entry.generalLinked;
    }
    writeFileSync(path, JSON.stringify(file));
    const legacy = new HostedRegistry(path, MASTER);
    expect(legacy.org(org.id)!.spaceRoomId).toBeUndefined();
    expect(orgSpaceComplete(legacy.org(org.id)!)).toBe(false);
  });
});

describe("SynapseAdmin room calls (endpoint shapes per the Synapse and Matrix docs)", () => {
  it("createPrivateRoom always sends a private, invite-only room; a Space adds the m.space type", async () => {
    const fake = createFakeSynapse();
    const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch });
    const spaceId = await admin.createPrivateRoom({ name: "Org", space: true });
    const roomId = await admin.createPrivateRoom({ name: "general" });
    expect(spaceId).toMatch(/^!.+:duo\.test$/);
    const [space, room] = fake.requests.filter((request) => request.path === "/_matrix/client/v3/createRoom");
    expect(space!.body).toEqual({
      name: "Org",
      visibility: "private",
      preset: "private_chat",
      creation_content: { type: "m.space" },
      power_level_content_override: { events_default: 100 },
    });
    expect(room!.body).toEqual({ name: "general", visibility: "private", preset: "private_chat" });
    expect(space!.authorization).toBe(`Bearer ${FAKE_ADMIN_TOKEN}`);
    expect(fake.rooms.get(roomId)!.joinRule).toBe("invite");
  });

  it("addSpaceChild, setRoomName and joinUser hit the documented endpoints with the documented bodies", async () => {
    const fake = createFakeSynapse();
    const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch });
    const space = await admin.createPrivateRoom({ name: "Org", space: true });
    const general = await admin.createPrivateRoom({ name: "general" });
    await admin.addSpaceChild(space, general, ["duo.test"]);
    await admin.setRoomName(space, "New name");
    await fake.fetch(`${FAKE_SYNAPSE_URL}/_synapse/admin/v2/users/${encodeURIComponent("@a.b:duo.test")}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${FAKE_ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    });
    await admin.joinUser(space, "@a.b:duo.test");
    await admin.joinUser(space, "@a.b:duo.test");

    const seen = fake.requests.map((request) => `${request.method} ${request.path}`);
    expect(seen).toContain(`PUT /_matrix/client/v3/rooms/${encodeURIComponent(space)}/state/m.space.child/${encodeURIComponent(general)}`);
    expect(seen).toContain(`PUT /_matrix/client/v3/rooms/${encodeURIComponent(space)}/state/m.room.name`);
    expect(seen).toContain(`POST /_synapse/admin/v1/join/${encodeURIComponent(space)}`);
    expect(fake.requests.find((request) => request.path.includes("/join/"))!.body).toEqual({ user_id: "@a.b:duo.test" });
    expect(fake.rooms.get(space)!.name).toBe("New name");
    expect(fake.rooms.get(space)!.children.get(general)).toEqual({ via: ["duo.test"], suggested: true });
    expect(fake.rooms.get(space)!.members.has("@a.b:duo.test")).toBe(true);
  });

  it("errors carry the status and errcode, never the token", async () => {
    const fake = createFakeSynapse();
    fake.failNext(1, 500);
    const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch });
    const error = await admin.createPrivateRoom({ name: "x" }).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ status: 500, retryable: true });
    expect((error as Error).message).not.toContain(FAKE_ADMIN_TOKEN);
  });
});
