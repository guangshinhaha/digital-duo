import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { IdentityError, type IdentityVerifier } from "../src/hosted/google.js";
import { formatOrgMemberLine, runHostedOrgAdminGrant, runHostedOrgAdminRevoke, runHostedOrgMembers } from "../src/hosted/invite.js";
import {
  DEFAULT_ORG_ID,
  LastOrgAdminError,
  ORG_ADMIN_LOG_CAP,
  OrgMemberNotFoundError,
  OrgNotFoundError,
  ROOT_DUO_ID,
  RootNotAppointableError,
  SUPER_ADMIN_ACTOR,
} from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { createHostedServer, tenantPaths, type HostedServer, type HostedSettings } from "../src/hosted/server.js";
import type { ServeDeps } from "../src/serve/server.js";
import { createAskToken } from "../src/serve/tokens.js";
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
    googleClientId: "cid",
    adminEmails: ["shin@x.com"],
    synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: "https://matrix.example.com" },
    workspaceConnections: { enabled: false },
    ...overrides,
  };
}

/** Credentials are "subject|email|name". */
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

async function start(fake: FakeSynapse, hostedSettings: HostedSettings = settings(), root?: ServeDeps) {
  const hosted = await createHostedServer(
    { config: loadConfig({}), env: { DUO_CORS_ORIGINS: "https://web.example" }, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false },
    hostedSettings,
    root,
    fakeIdentity,
    { synapseFetch: fake.fetch, log: () => {}, provisionRetryMs: 3_600_000 },
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  return { hosted, base: `http://127.0.0.1:${(hosted.server.address() as AddressInfo).port}` };
}

const call = (base: string, method: "GET" | "POST", path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function json<T = any>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

interface Session {
  tenantId: string | null;
  basePath: string;
  token: string;
  orgId: string | null;
  isAdmin: boolean;
  orgRole: string;
}

interface Person extends Session {
  tenantId: string;
}

interface World {
  fake: FakeSynapse;
  hosted: HostedServer;
  base: string;
  orgA: { id: string; name: string };
  orgB: { id: string; name: string };
  /** Org A: two members. Ann and Ari. */
  ann: Person;
  ari: Person;
  abe: Person;
  bob: Person;
  /** As the person, on their own duo. */
  as(person: Session, method: "GET" | "POST", path: string, body?: unknown): Promise<Response>;
  /** As the server admin token (the terminal / super admin). */
  admin(method: "GET" | "POST", path: string, body?: unknown): Promise<Response>;
}

async function join_(base: string, orgId: string, who: string): Promise<Person> {
  const { code } = await json(await call(base, "POST", "/hosted/invites", ADMIN, { name: who, orgId }), 201);
  return json(await call(base, "POST", "/hosted/signup", undefined, { invite: code, credential: `sub-${who}|${who}@x.com|${who}` }), 201);
}

async function world(options: { root?: boolean; settings?: HostedSettings } = {}): Promise<World> {
  const fake = createFakeSynapse({ orgWall: true });
  const { hosted, base } = await start(fake, options.settings ?? settings(), options.root ? rootDeps() : undefined);
  const orgA = await json(await call(base, "POST", "/hosted/orgs", ADMIN, { name: "Alpha" }), 201);
  const orgB = await json(await call(base, "POST", "/hosted/orgs", ADMIN, { name: "Beta" }), 201);
  const ann = await join_(base, orgA.id, "ann");
  const ari = await join_(base, orgA.id, "ari");
  const abe = await join_(base, orgA.id, "abe");
  const bob = await join_(base, orgB.id, "bob");
  return {
    fake,
    hosted,
    base,
    orgA,
    orgB,
    ann,
    ari,
    abe,
    bob,
    as: (person, method, path, body) => call(base, method, `${person.basePath}${path}`, person.token, body),
    admin: (method, path, body) => call(base, method, path, ADMIN, body),
  };
}

const grantByAdmin = (w: World, orgId: string, person: Person) => w.admin("POST", `/hosted/orgs/${orgId}/admins/${person.tenantId}/grant`);

describe("org admin — registry", () => {
  const newRegistry = () => {
    const registry = new HostedRegistry(join(tempDir(), "hosted", "registry.json"), MASTER);
    const org = registry.createOrg("Alpha");
    const other = registry.createOrg("Beta");
    const add = (name: string, orgId: string) => {
      const { invite, code } = registry.createInvite(name, new Date(Date.now() + 3_600_000).toISOString(), null, orgId);
      void code;
      return registry.addTenant(invite.id, name, "pw", registry.newTenantId());
    };
    return { registry, org, other, add };
  };

  it("appoints once, is idempotent, and records who and when", () => {
    const { registry, org, add } = newRegistry();
    const ann = add("Ann", org.id);
    const ari = add("Ari", org.id);
    expect(registry.orgRoleOf(ann.id)).toBe("member");

    const first = registry.grantOrgAdmin(org.id, ann.id, SUPER_ADMIN_ACTOR);
    expect(first.changed).toBe(true);
    expect(first.member).toMatchObject({ orgRole: "org_admin", orgAdmin: { by: SUPER_ADMIN_ACTOR } });
    const since = first.member.orgAdmin!.since;

    const again = registry.grantOrgAdmin(org.id, ann.id, ari.id);
    expect(again.changed).toBe(false);
    expect(again.member.orgAdmin).toEqual({ since, by: SUPER_ADMIN_ACTOR });
    expect(again.member.orgAdminLog).toHaveLength(1);
    expect(registry.orgAdminCount(org.id)).toBe(1);
  });

  it("refuses ids that are not members of that org, with one error for unknown and foreign", () => {
    const { registry, org, other, add } = newRegistry();
    const bob = add("Bob", other.id);
    expect(() => registry.grantOrgAdmin(org.id, bob.id, SUPER_ADMIN_ACTOR)).toThrow(OrgMemberNotFoundError);
    expect(() => registry.grantOrgAdmin(org.id, "nosuchduo1", SUPER_ADMIN_ACTOR)).toThrow(OrgMemberNotFoundError);
    expect(() => registry.revokeOrgAdmin(org.id, bob.id, SUPER_ADMIN_ACTOR, { allowLast: true })).toThrow(OrgMemberNotFoundError);
    expect(() => registry.grantOrgAdmin("nosuchorg", bob.id, SUPER_ADMIN_ACTOR)).toThrow(OrgNotFoundError);
    // The root duo is only "not appointable" in the org it lives in; anywhere else it is just an unknown id.
    registry.declareRootDuo("Shin");
    expect(() => registry.grantOrgAdmin(DEFAULT_ORG_ID, ROOT_DUO_ID, SUPER_ADMIN_ACTOR)).toThrow(RootNotAppointableError);
    expect(() => registry.grantOrgAdmin(org.id, ROOT_DUO_ID, SUPER_ADMIN_ACTOR)).toThrow(OrgMemberNotFoundError);
    expect(registry.revokeOrgAdmin(DEFAULT_ORG_ID, ROOT_DUO_ID, SUPER_ADMIN_ACTOR, { allowLast: true }).changed).toBe(false);
  });

  it("keeps the last org admin unless the caller may override, and the failed revoke writes nothing", () => {
    const { registry, org, add } = newRegistry();
    const ann = add("Ann", org.id);
    const ari = add("Ari", org.id);
    registry.grantOrgAdmin(org.id, ann.id, SUPER_ADMIN_ACTOR);
    registry.grantOrgAdmin(org.id, ari.id, ann.id);
    const path = join(tempDir(), "hosted", "registry.json");

    expect(registry.revokeOrgAdmin(org.id, ari.id, ann.id, { allowLast: false }).changed).toBe(true);
    const before = readFileSync(path, "utf8");
    expect(() => registry.revokeOrgAdmin(org.id, ann.id, ann.id, { allowLast: false })).toThrow(LastOrgAdminError);
    expect(() => registry.revokeOrgAdmin(org.id, ann.id, ari.id, { allowLast: false })).toThrow(LastOrgAdminError);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(registry.orgAdminCount(org.id)).toBe(1);

    expect(registry.revokeOrgAdmin(org.id, ann.id, SUPER_ADMIN_ACTOR, { allowLast: true }).changed).toBe(true);
    expect(registry.orgAdminCount(org.id)).toBe(0);
    // Revoking a plain member is a no-op, not an error.
    expect(registry.revokeOrgAdmin(org.id, ann.id, SUPER_ADMIN_ACTOR, { allowLast: false }).changed).toBe(false);
  });

  it("two revokes that run back to back leave exactly one org admin", () => {
    const { registry, org, add } = newRegistry();
    const ann = add("Ann", org.id);
    const ari = add("Ari", org.id);
    registry.grantOrgAdmin(org.id, ann.id, SUPER_ADMIN_ACTOR);
    registry.grantOrgAdmin(org.id, ari.id, SUPER_ADMIN_ACTOR);
    const outcomes = [
      () => registry.revokeOrgAdmin(org.id, ari.id, ann.id, { allowLast: false }),
      () => registry.revokeOrgAdmin(org.id, ann.id, ari.id, { allowLast: false }),
    ].map((run) => {
      try {
        return run().changed ? "revoked" : "unchanged";
      } catch (error) {
        return error instanceof LastOrgAdminError ? "last" : "other";
      }
    });
    expect(outcomes.sort()).toEqual(["last", "revoked"]);
    expect(registry.orgAdminCount(org.id)).toBe(1);
  });

  it("keeps a bounded history of grants and revocations, oldest dropped first", () => {
    const { registry, org, add } = newRegistry();
    const ann = add("Ann", org.id);
    const ari = add("Ari", org.id);
    registry.grantOrgAdmin(org.id, ari.id, SUPER_ADMIN_ACTOR);
    for (let round = 0; round < ORG_ADMIN_LOG_CAP; round += 1) {
      registry.grantOrgAdmin(org.id, ann.id, ari.id);
      registry.revokeOrgAdmin(org.id, ann.id, ari.id, { allowLast: false });
    }
    const log = registry.listOrgMembers(org.id).find((member) => member.duoId === ann.id)!.orgAdminLog;
    expect(log).toHaveLength(ORG_ADMIN_LOG_CAP);
    expect(log.at(-1)).toMatchObject({ action: "revoke", by: ari.id });
    expect(log.every((entry) => entry.by === ari.id && typeof entry.at === "string")).toBe(true);
    // The history is ids, never an email.
    expect(JSON.stringify(log)).not.toContain("@");
  });

  it("the role survives a restart; an older build that rewrites the tenant keeps it", () => {
    const { registry, org, add } = newRegistry();
    const ann = add("Ann", org.id);
    registry.grantOrgAdmin(org.id, ann.id, SUPER_ADMIN_ACTOR);
    // Any older write path spreads the tenant: the unknown fields ride along.
    registry.refreshTenantEmail(ann.id, "ann@x.com");
    const reloaded = new HostedRegistry(join(tempDir(), "hosted", "registry.json"), MASTER);
    expect(reloaded.orgRoleOf(ann.id)).toBe("org_admin");
    expect(reloaded.listOrgMembers(org.id)[0]).toMatchObject({ orgRole: "org_admin", orgAdmin: { by: SUPER_ADMIN_ACTOR } });
    expect(JSON.parse(readFileSync(join(tempDir(), "hosted", "registry.json"), "utf8")).version).toBe(2);
  });

  it("a registry from before this change loads with nobody an org admin and nothing lost, and adds no version bump", () => {
    const path = join(tempDir(), "hosted", "registry.json");
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(import.meta.dirname, "fixtures", "hosted-registry-v1.json"), path);
    const registry = new HostedRegistry(path, MASTER);
    expect(registry.tenants().map((tenant) => tenant.id)).toEqual(["e2etest001", "samsamsam2"]);
    expect(registry.orgAdminCount(DEFAULT_ORG_ID)).toBe(0);
    expect(registry.listOrgMembers(DEFAULT_ORG_ID).every((member) => member.orgRole === "member" && member.orgAdmin === null && member.orgAdminLog.length === 0)).toBe(true);
    // The first appointment on it writes version 2 (as any write does), not a newer one, and touches nothing else.
    registry.grantOrgAdmin(DEFAULT_ORG_ID, "samsamsam2", SUPER_ADMIN_ACTOR);
    const written = JSON.parse(readFileSync(path, "utf8")) as { version: number; tenants: Array<{ id: string; email?: string; orgAdmin?: unknown }> };
    expect(written.version).toBe(2);
    expect(written.tenants.find((tenant) => tenant.id === "samsamsam2")).toMatchObject({ email: "sam@example.com", orgAdmin: { by: SUPER_ADMIN_ACTOR } });
    expect(written.tenants.find((tenant) => tenant.id === "e2etest001")?.orgAdmin).toBeUndefined();
  });

  it("a v2 registry written by this build, with tenants that have no orgAdmin fields at all, needs no migration", () => {
    const { registry, org, add } = newRegistry();
    add("Ann", org.id);
    const path = join(tempDir(), "hosted", "registry.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { tenants: Array<Record<string, unknown>> };
    expect(file.tenants[0]).not.toHaveProperty("orgAdmin");
    expect(file.tenants[0]).not.toHaveProperty("orgAdminLog");
    expect(new HostedRegistry(path, MASTER).orgRoleOf(registry.tenants()[0].id)).toBe("member");
  });
});

describe("org admin — GET /org and the sign-in responses", () => {
  it("tells every signed-in member their org, role and whether they are the super admin", async () => {
    const w = await world({ root: true });
    expect(await json(await w.as(w.ann, "GET", "/org"))).toEqual({ org: { id: w.orgA.id, name: "Alpha" }, role: "member", superAdmin: false });
    await grantByAdmin(w, w.orgA.id, w.ann);
    expect(await json(await w.as(w.ann, "GET", "/org"))).toEqual({ org: { id: w.orgA.id, name: "Alpha" }, role: "org_admin", superAdmin: false });

    // The root duo, claimed by the super admin's first sign-in, is a member of the default org and the super admin.
    const shin = await json<Session>(await call(w.base, "POST", "/hosted/login", undefined, { credential: "sub-shin|shin@x.com|Shin" }), 200);
    expect(shin).toMatchObject({ basePath: "", isAdmin: true, orgRole: "member" });
    expect(await json(await call(w.base, "GET", "/org", shin.token))).toEqual({ org: { id: DEFAULT_ORG_ID, name: "Default" }, role: "member", superAdmin: true });
  });

  it("login and sign-up keep isAdmin and gain orgRole", async () => {
    const w = await world();
    expect(w.ann).toMatchObject({ isAdmin: false, orgRole: "member", orgId: w.orgA.id });
    await grantByAdmin(w, w.orgA.id, w.ann);
    const login = await json<Session>(await call(w.base, "POST", "/hosted/login", undefined, { credential: "sub-ann|ann@x.com|ann" }), 200);
    expect(login).toMatchObject({ isAdmin: false, orgRole: "org_admin", orgId: w.orgA.id });
    // A super admin who is a plain member of an org: isAdmin true, orgRole member.
    const { code } = await json(await w.admin("POST", "/hosted/invites", { name: "Shin", orgId: w.orgA.id }), 201);
    const shin = await json<Session>(await call(w.base, "POST", "/hosted/signup", undefined, { invite: code, credential: "sub-shin|shin@x.com|Shin" }), 201);
    expect(shin).toMatchObject({ isAdmin: true, orgRole: "member" });
  });

  it("needs a signed-in device: no token is 401, an ask link is refused", async () => {
    const w = await world();
    expect((await call(w.base, "GET", `${w.ann.basePath}/org`)).status).toBe(401);
    expect((await call(w.base, "GET", `${w.ann.basePath}/org`, "nope")).status).toBe(401);
    const paths = tenantPaths(join(tempDir(), "hosted"), w.ann.tenantId);
    const ask = createAskToken(paths.storePath, w.hosted.registry.passphraseFor(w.hosted.registry.tenants().find((tenant) => tenant.id === w.ann.tenantId)!), "a visitor", 24 * 3_600_000);
    await grantByAdmin(w, w.orgA.id, w.ann);
    expect((await call(w.base, "GET", `${w.ann.basePath}/org/members`, ask.token)).status).toBe(401);
    expect((await call(w.base, "GET", `${w.ann.basePath}/org`, ask.token)).status).toBe(401);
  });
});

describe("org admin — appointing", () => {
  it("the super admin appoints a member: marked Org admin with who and when, and it opens the org's admin routes", async () => {
    const w = await world();
    const granted = await json(await grantByAdmin(w, w.orgA.id, w.ann));
    expect(granted.changed).toBe(true);
    expect(granted.member).toMatchObject({ duoId: w.ann.tenantId, orgRole: "org_admin", appointedBy: SUPER_ADMIN_ACTOR, appointedByName: "Super admin", superAdmin: false });
    expect(Date.parse(granted.member.appointedAt)).not.toBeNaN();

    // The org admin's members list marks them, and the terminal's route agrees.
    const members = await json<any[]>(await w.as(w.ann, "GET", "/org/members"), 200);
    expect(members.find((member) => member.duoId === w.ann.tenantId)).toMatchObject({ orgRole: "org_admin", appointedBy: SUPER_ADMIN_ACTOR });
    expect(members.find((member) => member.duoId === w.ari.tenantId)).toMatchObject({ orgRole: "member", appointedBy: null, appointedAt: null });
    const fromTerminal = await json<any[]>(await w.admin("GET", `/hosted/orgs/${w.orgA.id}/members`), 200);
    expect(fromTerminal).toEqual(members);
  });

  it("appointing again changes nothing: the first appointment stands", async () => {
    const w = await world();
    const first = await json(await grantByAdmin(w, w.orgA.id, w.ann));
    await grantByAdmin(w, w.orgA.id, w.ari);
    const again = await json(await w.as(w.ari, "POST", `/org/admins/${w.ann.tenantId}/grant`));
    expect(again).toMatchObject({ changed: false });
    expect(again.member.appointedBy).toBe(SUPER_ADMIN_ACTOR);
    expect(again.member.appointedAt).toBe(first.member.appointedAt);
  });

  it("an org admin appoints another member of their own org, shown as the appointer", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    const granted = await json(await w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/grant`), 200);
    expect(granted.member).toMatchObject({ orgRole: "org_admin", appointedBy: w.ann.tenantId, appointedByName: "ann" });
    // Grant and revoke work with no body and with an empty JSON one, as the app sends.
    expect((await call(w.base, "POST", `${w.ann.basePath}/org/admins/${w.abe.tenantId}/grant`, w.ann.token)).status).toBe(200);
    expect((await w.as(w.ari, "GET", "/org/members")).status).toBe(200);
  });

  it("a member cannot appoint anyone, themselves included", async () => {
    const w = await world();
    const before = await (await w.admin("GET", `/hosted/orgs/${w.orgA.id}/members`)).text();
    expect((await w.as(w.ari, "POST", `/org/admins/${w.ari.tenantId}/grant`)).status).toBe(403);
    expect((await w.as(w.ari, "POST", `/org/admins/${w.ann.tenantId}/grant`)).status).toBe(403);
    expect(await (await w.admin("GET", `/hosted/orgs/${w.orgA.id}/members`)).text()).toBe(before);
  });

  it("the super admin and the root duo cannot be appointed, with a clear error", async () => {
    const w = await world({ root: true });
    const { code } = await json(await w.admin("POST", "/hosted/invites", { name: "Shin", orgId: w.orgA.id }), 201);
    const shin = await json<Person>(await call(w.base, "POST", "/hosted/signup", undefined, { invite: code, credential: "sub-shin|shin@x.com|Shin" }), 201);
    await grantByAdmin(w, w.orgA.id, w.ann);

    // The org admin cannot appoint or revoke the super admin who is a member of their org; the list marks them apart.
    const list = await json<any[]>(await w.as(w.ann, "GET", "/org/members"), 200);
    expect(list.find((member) => member.duoId === shin.tenantId)).toMatchObject({ superAdmin: true, isAdmin: true, orgRole: "member" });
    for (const action of ["grant", "revoke"]) {
      const refused = await json(await w.as(w.ann, "POST", `/org/admins/${shin.tenantId}/${action}`), 409);
      expect(refused.error.code).toBe("super_admin_protected");
    }
    // The super admin's own route refuses to appoint the super admin as well.
    expect((await json(await grantByAdmin(w, w.orgA.id, shin), 409)).error.code).toBe("super_admin_protected");
    expect((await json(await w.admin("POST", `/hosted/orgs/${DEFAULT_ORG_ID}/admins/${ROOT_DUO_ID}/grant`), 409)).error).toMatchObject({ code: "root_not_appointable", message: expect.stringContaining("root duo") });
    expect(w.hosted.registry.orgAdminCount(w.orgA.id)).toBe(1);
  });
});

describe("org admin — own org only", () => {
  it("lists members (person and duo) and pending invites of the caller's org and nothing of another", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await json(await w.admin("POST", "/hosted/invites", { name: "Beta hire", orgId: w.orgB.id }), 201);
    const mine = await json(await w.as(w.ann, "POST", "/org/invites", { name: "Alpha hire", email: "New@X.com" }), 201);
    await json(await w.admin("POST", "/hosted/invites", { name: "Alpha via admin", orgId: w.orgA.id }), 201);
    // The invites the three members redeemed are used, so they are not pending; an expired one is not either.
    w.hosted.registry.createInvite("Stale", new Date(Date.now() - 1_000).toISOString(), null, w.orgA.id);

    const members = await json<any[]>(await w.as(w.ann, "GET", "/org/members"), 200);
    expect(members.map((member) => member.name).sort()).toEqual(["abe", "ann", "ari"]);
    expect(members[0]).toEqual(expect.objectContaining({ duoId: expect.any(String), email: expect.stringContaining("@"), joinedAt: expect.any(String) }));

    const invites = await json<any[]>(await w.as(w.ann, "GET", "/org/invites"), 200);
    expect(invites.map((invite) => invite.name).sort()).toEqual(["Alpha hire", "Alpha via admin"]);
    expect(invites.every((invite) => invite.orgId === w.orgA.id)).toBe(true);
    expect(invites.find((invite) => invite.name === "Alpha hire")).toMatchObject({ id: mine.id, email: "new@x.com" });

    // No other org's name, people or invites anywhere in what the org admin can read; and never a code hash or a code.
    const everything = JSON.stringify([members, invites, await (await w.as(w.ann, "GET", "/org")).json()]);
    for (const secret of ["Beta", "bob", "Beta hire", w.bob.tenantId, "codeHash"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain(mine.code);
  });

  it("creates an invite that lands in the caller's org whatever a body orgId says; the invitee joins as a member", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    const invitesBefore = w.hosted.registry.invites().length;

    for (const hostile of [w.orgB.id, "nosuchorg", DEFAULT_ORG_ID, { x: 1 }, 7]) {
      const refused = await json(await w.as(w.ann, "POST", "/org/invites", { name: "Eve", orgId: hostile }), 403);
      expect(refused.error.code).toBe("forbidden");
    }
    expect(w.hosted.registry.invites().length).toBe(invitesBefore);

    // Naming the caller's own org is harmless.
    const own = await json(await w.as(w.ann, "POST", "/org/invites", { name: "Kim", orgId: w.orgA.id }), 201);
    expect(own).toMatchObject({ orgId: w.orgA.id, name: "Kim", code: expect.any(String), link: expect.stringContaining("#join?host=") });
    expect(own.link).toContain(encodeURIComponent(own.code));
    const kim = await json<Person>(await call(w.base, "POST", "/hosted/signup", undefined, { invite: own.code, credential: "sub-kim|kim@x.com|Kim" }), 201);
    expect(kim).toMatchObject({ orgId: w.orgA.id, orgRole: "member" });
    // Single use: the same link does not admit a second person.
    expect((await call(w.base, "POST", "/hosted/signup", undefined, { invite: own.code, credential: "sub-lee|lee@x.com|Lee" })).status).toBe(403);
    // The pending list no longer shows it.
    expect((await json<any[]>(await w.as(w.ann, "GET", "/org/invites"), 200)).map((invite) => invite.name)).not.toContain("Kim");
  });

  it("validates the invite like the super admin's", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    expect((await w.as(w.ann, "POST", "/org/invites", {})).status).toBe(400);
    expect((await w.as(w.ann, "POST", "/org/invites", { name: "Kim", expiresInHours: 0 })).status).toBe(400);
    expect((await w.as(w.ann, "POST", "/org/invites", { name: "Kim", email: "not-an-email" })).status).toBe(400);
  });

  it("renames the org for everyone in it, and its Space in the chat, through the same path as the super admin", async () => {
    const w = await world();
    await w.hosted.matrix!.whenIdle();
    await w.hosted.spaces!.whenIdle();
    await grantByAdmin(w, w.orgA.id, w.ann);
    const spaceId = w.hosted.registry.org(w.orgA.id)!.spaceRoomId!;
    expect(w.fake.rooms.get(spaceId)!.name).toBe("Alpha");

    const renamed = await json(await w.as(w.ann, "POST", "/org/rename", { name: "  Platform  " }), 200);
    expect(renamed).toEqual({ org: { id: w.orgA.id, name: "Platform" } });
    expect(w.fake.rooms.get(spaceId)!.name).toBe("Platform");
    // A plain member sees the new name on their own GET /org, and so does the super admin's listing.
    expect((await json(await w.as(w.ari, "GET", "/org"), 200)).org.name).toBe("Platform");
    expect((await json<any[]>(await w.admin("GET", "/hosted/orgs"), 200)).find((org) => org.id === w.orgA.id).name).toBe("Platform");

    // Names stay unique (case-insensitively) and bounded; another org's id in the body is refused, not followed.
    expect((await json(await w.as(w.ann, "POST", "/org/rename", { name: "beta" }), 409)).error.code).toBe("org_name_taken");
    expect((await w.as(w.ann, "POST", "/org/rename", { name: "" })).status).toBe(400);
    expect((await json(await w.as(w.ann, "POST", "/org/rename", { name: "Hijack", orgId: w.orgB.id }), 403)).error.code).toBe("forbidden");
    expect(w.hosted.registry.org(w.orgB.id)!.name).toBe("Beta");
    // A member may not rename.
    expect((await w.as(w.ari, "POST", "/org/rename", { name: "Mine" })).status).toBe(403);
    expect(w.hosted.registry.org(w.orgA.id)!.name).toBe("Platform");
  });

  it("refuses an id from another org or an unknown id with the same body: no existence oracle", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await grantByAdmin(w, w.orgB.id, w.bob);
    for (const action of ["grant", "revoke"]) {
      const foreign = await w.as(w.ann, "POST", `/org/admins/${w.bob.tenantId}/${action}`);
      const unknown = await w.as(w.ann, "POST", `/org/admins/zzzzzzzzzz/${action}`);
      const root = await w.as(w.ann, "POST", `/org/admins/${ROOT_DUO_ID}/${action}`);
      expect(foreign.status).toBe(404);
      const body = await foreign.text();
      expect(await unknown.text()).toBe(body);
      expect(root.status).toBe(404);
      expect(await root.text()).toBe(body);
      expect(JSON.parse(body).error.code).toBe("not_found");
    }
    // Bob is untouched.
    expect(w.hosted.registry.orgRoleOf(w.bob.tenantId)).toBe("org_admin");
  });
});

describe("org admin — revoking", () => {
  it("one org admin revokes another, or steps down; the revoked person's next request is refused and they stay a member", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await grantByAdmin(w, w.orgA.id, w.ari);

    // A signed-in app checks its role: it is refused next request, and GET /org drops the admin entry.
    expect((await json(await w.as(w.ari, "GET", "/org"), 200)).role).toBe("org_admin");
    const revoked = await json(await w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/revoke`), 200);
    expect(revoked).toMatchObject({ changed: true, member: { duoId: w.ari.tenantId, orgRole: "member", appointedBy: null } });
    expect(await json(await w.as(w.ari, "GET", "/org"), 200)).toMatchObject({ role: "member" });
    const refused = await json(await w.as(w.ari, "GET", "/org/members"), 403);
    expect(refused.error.code).toBe("forbidden");
    expect((await w.as(w.ari, "POST", "/org/rename", { name: "X" })).status).toBe(403);
    // Still a normal member, with their duo and access.
    expect(w.hosted.registry.tenants().some((tenant) => tenant.id === w.ari.tenantId)).toBe(true);
    expect((await w.as(w.ari, "GET", "/org")).status).toBe(200);

    // Appoint again, then Ann steps down herself while Ari remains.
    await grantByAdmin(w, w.orgA.id, w.ari);
    const steppedDown = await json(await w.as(w.ann, "POST", `/org/admins/${w.ann.tenantId}/revoke`), 200);
    expect(steppedDown.member.orgRole).toBe("member");
    expect((await json(await w.as(w.ann, "GET", "/org"), 200)).role).toBe("member");
    expect(w.hosted.registry.orgAdminCount(w.orgA.id)).toBe(1);
  });

  it("the last org admin cannot revoke themselves; only the super admin can revoke them", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    const refused = await json(await w.as(w.ann, "POST", `/org/admins/${w.ann.tenantId}/revoke`), 409);
    expect(refused.error).toMatchObject({ code: "last_org_admin", message: expect.stringContaining("last org admin") });
    expect(w.hosted.registry.orgRoleOf(w.ann.tenantId)).toBe("org_admin");
    // A member trying is refused as any member is; nothing changes.
    expect((await w.as(w.ari, "POST", `/org/admins/${w.ann.tenantId}/revoke`)).status).toBe(403);
    expect(w.hosted.registry.orgRoleOf(w.ann.tenantId)).toBe("org_admin");

    // The super admin, by the server token, succeeds; the org is then simply without an org admin and everything still works for the super admin.
    const revoked = await json(await w.admin("POST", `/hosted/orgs/${w.orgA.id}/admins/${w.ann.tenantId}/revoke`), 200);
    expect(revoked.member.orgRole).toBe("member");
    expect(w.hosted.registry.orgAdminCount(w.orgA.id)).toBe(0);
    expect((await w.admin("GET", `/hosted/orgs/${w.orgA.id}/members`)).status).toBe(200);
    expect((await w.admin("POST", "/hosted/invites", { name: "Kim", orgId: w.orgA.id })).status).toBe(201);
    expect((await w.admin("POST", `/hosted/orgs/${w.orgA.id}/rename`, { name: "Alpha 2" })).status).toBe(200);
    expect((await w.admin("GET", "/hosted/orgs")).status).toBe(200);
  });

  it("a super admin's own signed-in device may also revoke the last org admin", async () => {
    const w = await world({ root: true });
    const shin = await json<Session>(await call(w.base, "POST", "/hosted/login", undefined, { credential: "sub-shin|shin@x.com|Shin" }), 200);
    await grantByAdmin(w, w.orgA.id, w.ann);
    expect((await call(w.base, "POST", `/hosted/orgs/${w.orgA.id}/admins/${w.ann.tenantId}/revoke`, shin.token)).status).toBe(200);
    expect(w.hosted.registry.orgAdminCount(w.orgA.id)).toBe(0);
  });

  it("two org admins revoking each other at the same moment leave exactly one", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await grantByAdmin(w, w.orgA.id, w.ari);
    const [one, two] = await Promise.all([
      w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/revoke`),
      w.as(w.ari, "POST", `/org/admins/${w.ann.tenantId}/revoke`),
    ]);
    // Whichever ran first won. The other's caller had just been revoked, so their request is refused as not-an-admin.
    expect([one.status, two.status].sort()).toEqual([200, 403]);
    expect(w.hosted.registry.orgAdminCount(w.orgA.id)).toBe(1);
  });

  it("one org admin asked to revoke the other and themselves at once: the second is refused as the last org admin", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await grantByAdmin(w, w.orgA.id, w.ari);
    const [first, second] = await Promise.all([
      w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/revoke`),
      w.as(w.ann, "POST", `/org/admins/${w.ann.tenantId}/revoke`),
    ]);
    expect(first.status).toBe(200);
    expect((await json(second, 409)).error.code).toBe("last_org_admin");
    expect(w.hosted.registry.orgRoleOf(w.ann.tenantId)).toBe("org_admin");
  });
});

describe("org admin — what is refused, and how", () => {
  it("a member, an org admin asking for a super admin's power, and another org's admin all get the same 403", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await grantByAdmin(w, w.orgB.id, w.bob);
    const routes: Array<[method: "GET" | "POST", path: string, body?: unknown]> = [
      ["GET", "/hosted/orgs"],
      ["POST", "/hosted/orgs", { name: "Sneaky" }],
      ["GET", "/hosted/duos"],
      ["GET", "/hosted/invites"],
      ["POST", "/hosted/invites", { name: "Eve", orgId: "default" }],
      ["POST", "/hosted/matrix/provision", {}],
      ["POST", "/hosted/matrix/remint", { duoId: "x" }],
      ["GET", `/hosted/orgs/${w.orgA.id}/members`],
      ["GET", `/hosted/orgs/${w.orgB.id}/members`],
      ["GET", "/hosted/orgs/nosuchorg/members"],
      ["POST", `/hosted/orgs/${w.orgB.id}/rename`, { name: "Hijack" }],
      ["POST", "/hosted/orgs/nosuchorg/rename", { name: "Hijack" }],
      ["POST", `/hosted/orgs/${w.orgA.id}/admins/${w.ari.tenantId}/grant`],
      ["POST", `/hosted/orgs/${w.orgB.id}/admins/${w.bob.tenantId}/revoke`],
      ["POST", `/hosted/orgs/nosuchorg/admins/${w.bob.tenantId}/revoke`],
    ];
    const bodies = new Map<string, string>();
    for (const [who, person] of [["member", w.ari], ["org admin", w.ann], ["other org's admin", w.bob]] as const) {
      for (const [method, path, body] of routes) {
        const response = await call(w.base, method, path, person.token, body);
        expect(response.status, `${who} ${method} ${path}`).toBe(403);
        const text = await response.text();
        expect(bodies.get(`${method} ${path}`) ?? text, `${who} ${method} ${path}`).toBe(text);
        bodies.set(`${method} ${path}`, text);
      }
    }
    expect(new Set(bodies.values()).size).toBe(1);
    expect(JSON.parse([...bodies.values()][0]).error.code).toBe("forbidden");
    // Nothing changed: no new org, the names, the roles.
    expect(w.hosted.registry.orgs().map((org) => org.name)).toEqual(["Default", "Alpha", "Beta"]);
    expect(w.hosted.registry.orgAdminCount(w.orgA.id)).toBe(1);
    expect(w.hosted.registry.orgAdminCount(w.orgB.id)).toBe(1);
  });

  it("a member gets the same 403 on every org admin route of their own duo", async () => {
    const w = await world();
    const bodies = new Set<string>();
    for (const [method, path, body] of [
      ["GET", "/org/members"],
      ["GET", "/org/invites"],
      ["POST", "/org/invites", { name: "Kim" }],
      ["POST", "/org/rename", { name: "Mine" }],
      ["POST", `/org/admins/${w.abe.tenantId}/grant`],
      ["POST", `/org/admins/${w.abe.tenantId}/revoke`],
      ["POST", `/org/admins/${w.bob.tenantId}/grant`],
      ["POST", `/org/admins/zzzzzzzzzz/grant`],
    ] as const) {
      const response = await w.as(w.ari, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("with no credential the routes are 401, as today", async () => {
    const w = await world();
    expect((await call(w.base, "GET", `/hosted/orgs/${w.orgA.id}/members`)).status).toBe(401);
    expect((await call(w.base, "POST", `/hosted/orgs/${w.orgA.id}/admins/${w.ann.tenantId}/grant`)).status).toBe(401);
  });

  it("the org admin routes are absent on a duo served without hosted mode", async () => {
    const { createServer } = await import("../src/serve/server.js");
    const deps = rootDeps();
    createEncryptedStore(deps.storePath, deps.passphrase);
    const app = createServer(deps);
    const { createDeviceToken } = await import("../src/serve/tokens.js");
    const device = createDeviceToken(deps.storePath, deps.passphrase, "test");
    const response = await app.inject({ method: "GET", url: "/org", headers: { authorization: `Bearer ${device.token}` } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("org admin — recorded, and kept across a restart", () => {
  it("shows the super admin and the org's org admins who appointed and revoked whom, and when", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/grant`);
    await w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/revoke`);

    for (const members of [
      await json<any[]>(await w.as(w.ann, "GET", "/org/members"), 200),
      await json<any[]>(await w.admin("GET", `/hosted/orgs/${w.orgA.id}/members`), 200),
    ]) {
      const ari = members.find((member) => member.duoId === w.ari.tenantId);
      expect(ari.orgRole).toBe("member");
      expect(ari.orgAdminLog.map((entry: any) => [entry.action, entry.by, entry.byName])).toEqual([
        ["grant", w.ann.tenantId, "ann"],
        ["revoke", w.ann.tenantId, "ann"],
      ]);
      expect(ari.orgAdminLog.every((entry: any) => Date.parse(entry.at) > 0)).toBe(true);
      const ann = members.find((member) => member.duoId === w.ann.tenantId);
      expect(ann.orgAdminLog).toEqual([expect.objectContaining({ action: "grant", by: SUPER_ADMIN_ACTOR, byName: "Super admin" })]);
    }
    // In the registry file, ids and dates only: no email in the audit list.
    const file = readFileSync(join(tempDir(), "hosted", "registry.json"), "utf8");
    const stored = (JSON.parse(file) as { tenants: Array<{ id: string; orgAdminLog?: unknown[]; orgAdmin?: unknown }> }).tenants.find((tenant) => tenant.id === w.ari.tenantId)!;
    expect(stored.orgAdminLog).toHaveLength(2);
    expect(JSON.stringify(stored.orgAdminLog)).not.toContain("@");
    expect(stored.orgAdmin).toBeUndefined();
  });

  it("the role survives a restart, and so does a person's session", async () => {
    const w = await world();
    await grantByAdmin(w, w.orgA.id, w.ann);
    await w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/grant`);
    await running.pop()!.close();

    const { base } = await start(w.fake);
    const ann = { ...w.ann };
    expect(await json(await call(base, "GET", `${ann.basePath}/org`, ann.token), 200)).toMatchObject({ role: "org_admin" });
    expect(await json(await call(base, "GET", `${w.ari.basePath}/org`, w.ari.token), 200)).toMatchObject({ role: "org_admin" });
    expect(await json(await call(base, "GET", `${w.abe.basePath}/org`, w.abe.token), 200)).toMatchObject({ role: "member" });
    const members = await json<any[]>(await call(base, "GET", `${ann.basePath}/org/members`, ann.token), 200);
    expect(members.find((member) => member.duoId === w.ari.tenantId)).toMatchObject({ appointedBy: w.ann.tenantId });
    // And it is in the login answer after the restart.
    expect((await json<Session>(await call(base, "POST", "/hosted/login", undefined, { credential: "sub-ann|ann@x.com|ann" }), 200)).orgRole).toBe("org_admin");
  });
});

describe("org admin — chat power is unchanged", () => {
  it("changing a role makes no Matrix call and changes no room's members or power levels", async () => {
    const w = await world();
    await w.hosted.matrix!.whenIdle();
    await w.hosted.spaces!.whenIdle();
    const rooms = () =>
      JSON.stringify([...w.fake.rooms.values()].map((room) => ({ id: room.roomId, name: room.name, members: [...room.members].sort(), levels: room.powerLevels })));
    const calls = w.fake.requests.length;
    const before = rooms();

    await grantByAdmin(w, w.orgA.id, w.ann);
    await w.as(w.ann, "POST", `/org/admins/${w.ari.tenantId}/grant`);
    await w.as(w.ann, "GET", "/org/members");
    await w.as(w.ann, "GET", "/org/invites");
    await w.as(w.ann, "POST", "/org/invites", { name: "Kim" });
    await w.as(w.ari, "POST", `/org/admins/${w.ann.tenantId}/revoke`);
    await w.admin("POST", `/hosted/orgs/${w.orgA.id}/admins/${w.ari.tenantId}/revoke`);
    await w.as(w.ann, "GET", "/org");

    expect(w.fake.requests.length).toBe(calls);
    expect(rooms()).toBe(before);
  });

  it("the Matrix, Space and workspace-session code never reads the role", () => {
    const dir = join(import.meta.dirname, "..", "src", "hosted");
    const chatFiles = ["matrix-accounts.ts", "org-spaces.ts", "workspace-session.ts", "duo-workspace.ts", "synapse-admin.ts"];
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(chatFiles));
    for (const file of chatFiles) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/orgAdmin|orgRole|org_admin|OrgAdmin|orgRoleOf/);
    }
  });
});

describe("duo hosted org admin … (terminal)", () => {
  it("appoints and revokes as the super admin, shows the role marks, and may revoke the last org admin", async () => {
    const w = await world();
    const env = { DUO_HOSTED_MASTER_KEY: MASTER, DUO_HOSTED_ADMIN_TOKEN: ADMIN, PORT: new URL(w.base).port };

    const granted = await runHostedOrgAdminGrant(w.orgA.id, w.ann.tenantId, env);
    expect(granted).toMatchObject({ changed: true, member: { name: "ann", orgRole: "org_admin" } });
    expect((await runHostedOrgAdminGrant(w.orgA.id, w.ann.tenantId, env)).changed).toBe(false);

    const lines = (await runHostedOrgMembers(w.orgA.id, env)).map(formatOrgMemberLine);
    expect(lines.find((line) => line.includes("ann@x.com"))).toMatch(/org admin \(appointed by Super admin on \d{4}-\d{2}-\d{2}\)/);
    expect(lines.find((line) => line.includes("ari@x.com"))).toBe(`${w.ari.tenantId}\tari\tari@x.com`);

    // The last org admin: the terminal is the super admin, so it succeeds where the org admin was refused.
    expect((await w.as(w.ann, "POST", `/org/admins/${w.ann.tenantId}/revoke`)).status).toBe(409);
    expect(await runHostedOrgAdminRevoke(w.orgA.id, w.ann.tenantId, env)).toMatchObject({ changed: true, member: { orgRole: "member" } });
    expect((await runHostedOrgAdminRevoke(w.orgA.id, w.ann.tenantId, env)).changed).toBe(false);

    await expect(runHostedOrgAdminGrant(w.orgA.id, w.bob.tenantId, env)).rejects.toThrow(/no such member/);
    await expect(runHostedOrgAdminGrant("nosuchorg", w.ann.tenantId, env)).rejects.toThrow(/no org "nosuchorg"/);
  });

  it("marks a super admin apart from an org admin in the member listing", () => {
    const base = { duoId: "d", name: "N", email: "n@x.com", isRoot: false, joinedAt: null, isAdmin: true, orgAdminLog: [], appointedBy: null, appointedByName: null, appointedAt: null };
    expect(formatOrgMemberLine({ ...base, superAdmin: true, orgRole: "member" })).toBe("d\tN\tn@x.com\tsuper admin");
    expect(formatOrgMemberLine({ ...base, superAdmin: false, orgRole: "member" })).toBe("d\tN\tn@x.com");
  });
});
