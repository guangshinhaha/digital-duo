import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { IdentityError, type IdentityVerifier } from "../src/hosted/google.js";
import { runHostedInvite, runHostedOrgCreate, runHostedOrgList, runHostedOrgMembers, runHostedOrgRename } from "../src/hosted/invite.js";
import { assertOrgId, DEFAULT_ORG_ID, normalizeOrgName, ORG_ID_PATTERN, OrgNameError, OrgNameTakenError, OrgNotFoundError, ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { createHostedServer, hostedSettingsFrom, type HostedServer, type HostedSettings } from "../src/hosted/server.js";
import type { ServeDeps } from "../src/serve/server.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const MASTER = "master-key-for-tests";
const running: HostedServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

const fixture = () => join(import.meta.dirname, "fixtures", "hosted-registry-v1.json");

function settings(overrides: Partial<HostedSettings> = {}): HostedSettings {
  return {
    hostedRoot: join(tempDir(), "hosted"),
    masterKey: MASTER,
    adminToken: ADMIN,
    publicUrl: "https://daemon.example",
    webUrl: "https://web.example",
    googleClientId: "cid",
    adminEmails: ["shin@x.com"],
    ...overrides,
  };
}

/** Credentials are "subject|email|name"; the Google check itself is covered in hosted-google.test.ts. */
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

async function start(hostedSettings: HostedSettings, root?: ServeDeps): Promise<{ hosted: HostedServer; base: string }> {
  const hosted = await createHostedServer(
    { config: loadConfig({}), env: { DUO_CORS_ORIGINS: "https://web.example" }, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false },
    hostedSettings,
    root,
    fakeIdentity,
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

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

interface Org {
  id: string;
  name: string;
  memberCount: number;
}
interface Session {
  tenantId: string | null;
  basePath: string;
  token: string;
  orgId: string | null;
  isAdmin: boolean;
}

async function joinInto(base: string, orgId: string | undefined, who: string): Promise<Session> {
  const { code } = await json<{ code: string }>(await call(base, "POST", "/hosted/invites", ADMIN, { name: who, ...(orgId ? { orgId } : {}) }), 201);
  return json<Session>(await call(base, "POST", "/hosted/signup", undefined, { invite: code, credential: `sub-${who}|${who}@x.com|${who}` }), 201);
}

describe("registry migration — a pre-orgs registry file loads into a default org", () => {
  function copyOfFixture(): string {
    const path = join(tempDir(), "hosted", "registry.json");
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(fixture(), path);
    return path;
  }

  it("puts every existing duo, invite and the root duo in the default org, keeping ids", () => {
    const registry = new HostedRegistry(copyOfFixture(), MASTER);
    expect(registry.orgs().map((org) => org.id)).toEqual([DEFAULT_ORG_ID]);
    expect(registry.tenants().map((tenant) => [tenant.id, tenant.name, tenant.orgId])).toEqual([
      ["e2etest001", "E2E Test", DEFAULT_ORG_ID],
      ["samsamsam2", "Sam Tan", DEFAULT_ORG_ID],
    ]);
    expect(registry.invites().every((invite) => invite.orgId === DEFAULT_ORG_ID)).toBe(true);
    expect(registry.orgOf("e2etest001")?.id).toBe(DEFAULT_ORG_ID);
    expect(registry.orgOf(ROOT_DUO_ID)?.id).toBe(DEFAULT_ORG_ID);
    expect(registry.orgOf("nosuchduo")).toBeUndefined();
    expect(registry.root()?.email).toBe("shin@example.com");
    // The default org is dated from the oldest duo, not from when the migration ran.
    expect(registry.org(DEFAULT_ORG_ID)?.createdAt).toBe("2026-09-26T03:00:00.000Z");
  });

  it("is lazy: loading never rewrites the file, the next write persists version 2", () => {
    const path = copyOfFixture();
    const before = readFileSync(path, "utf8");
    const registry = new HostedRegistry(path, MASTER);
    expect(readFileSync(path, "utf8")).toBe(before);
    registry.createOrg("Team B");
    const after = JSON.parse(readFileSync(path, "utf8")) as { version: number; orgs: unknown[]; tenants: Array<{ orgId: string }>; rootOrgId: string };
    expect(after.version).toBe(2);
    expect(after.orgs).toHaveLength(2);
    expect(after.tenants.map((tenant) => tenant.orgId)).toEqual([DEFAULT_ORG_ID, DEFAULT_ORG_ID]);
    expect(after.rootOrgId).toBe(DEFAULT_ORG_ID);
    // And a second load of the migrated file is a no-op.
    expect(new HostedRegistry(path, MASTER).orgs()).toHaveLength(2);
  });

  it("keeps a copy of the v1 file before the first migrated write, and never overwrites it", () => {
    const path = copyOfFixture();
    const original = readFileSync(path, "utf8");
    const registry = new HostedRegistry(path, MASTER);
    expect(existsSync(`${path}.v1.bak`)).toBe(false);
    registry.createOrg("Team B");
    expect(readFileSync(`${path}.v1.bak`, "utf8")).toBe(original);
    registry.createOrg("Team C");
    expect(readFileSync(`${path}.v1.bak`, "utf8")).toBe(original);
    // A later process loads a v2 file: no copy is made or replaced.
    writeFileSync(`${path}.v1.bak`, "sentinel");
    new HostedRegistry(path, MASTER).createOrg("Team D");
    expect(readFileSync(`${path}.v1.bak`, "utf8")).toBe("sentinel");
  });

  it("does not replace an existing .bak, and makes none for a v2 file or a brand-new registry", () => {
    const path = copyOfFixture();
    writeFileSync(`${path}.v1.bak`, "older backup");
    new HostedRegistry(path, MASTER).createOrg("Team B");
    expect(readFileSync(`${path}.v1.bak`, "utf8")).toBe("older backup");

    const fresh = join(tempDir(), "fresh2", "registry.json");
    new HostedRegistry(fresh, MASTER).createOrg("Team B");
    expect(existsSync(`${fresh}.v1.bak`)).toBe(false);
  });

  it("repairs a v2 file written by a rolled-back pre-orgs build: a tenant or invite with no org goes to the default org", () => {
    const path = join(tempDir(), "hosted", "registry.json");
    mkdirSync(dirname(path), { recursive: true });
    const v1 = JSON.parse(readFileSync(fixture(), "utf8")) as { tenants: Array<Record<string, unknown>>; invites: Array<Record<string, unknown>> };
    const org = { id: "acme2", name: "Acme", createdAt: "2026-09-26T02:00:00.000Z" };
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        orgs: [{ id: DEFAULT_ORG_ID, name: "Default", createdAt: "2026-09-26T01:00:00.000Z" }, org],
        rootOrgId: "acme2",
        tenants: [{ ...v1.tenants[0], orgId: "acme2" }, v1.tenants[1]],
        invites: v1.invites,
        root: null,
      }),
    );
    const registry = new HostedRegistry(path, MASTER);
    // Existing orgs and explicit assignments are kept; the record with no org is repaired.
    expect(registry.orgs().map((entry) => entry.id)).toEqual([DEFAULT_ORG_ID, "acme2"]);
    expect(registry.orgOf("e2etest001")?.id).toBe("acme2");
    expect(registry.orgOf("samsamsam2")?.id).toBe(DEFAULT_ORG_ID);
    expect(registry.invites().every((invite) => invite.orgId === DEFAULT_ORG_ID)).toBe(true);
    expect(registry.orgOf(ROOT_DUO_ID)?.id).toBe("acme2");
    expect(registry.listOrgMembers(DEFAULT_ORG_ID).map((member) => member.duoId)).toEqual(["samsamsam2"]);
    // A v2 file needs no .bak.
    registry.createOrg("Team B");
    expect(existsSync(`${path}.v1.bak`)).toBe(false);
  });

  it("refuses to load a v2 file with an invalid org id, naming it", () => {
    const path = join(tempDir(), "hosted", "registry.json");
    mkdirSync(dirname(path), { recursive: true });
    for (const id of ["acme.eu", "Acme", "a-b"]) {
      writeFileSync(path, JSON.stringify({ version: 2, orgs: [{ id: DEFAULT_ORG_ID, name: "Default", createdAt: "x" }, { id, name: "Acme", createdAt: "x" }], tenants: [], invites: [], rootOrgId: DEFAULT_ORG_ID }));
      expect(() => new HostedRegistry(path, MASTER), id).toThrow(new RegExp(`"${id}" must be lowercase letters and digits only`));
    }
  });

  it("starts a brand-new registry with the default org, and refuses a file from a newer server", () => {
    expect(new HostedRegistry(join(tempDir(), "fresh", "registry.json"), MASTER).orgs().map((org) => org.id)).toEqual([DEFAULT_ORG_ID]);
    const path = join(tempDir(), "future", "registry.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99, orgs: [], tenants: [], invites: [] }));
    expect(() => new HostedRegistry(path, MASTER)).toThrow(/newer than this server/);
  });

  it("a migrated duo keeps working at its URL, with its old device token", async () => {
    const hostedSettings = settings();
    const first = await start(hostedSettings);
    const sam = await joinInto(first.base, undefined, "sam");
    await running.pop()!.close();

    // Rewrite the registry the way the pre-orgs server wrote it.
    const path = join(hostedSettings.hostedRoot, "registry.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { version?: number; orgs?: unknown; rootOrgId?: string; tenants: Array<{ orgId?: string }>; invites: Array<{ orgId?: string }> };
    delete file.version;
    delete file.orgs;
    delete file.rootOrgId;
    file.tenants.forEach((tenant) => delete tenant.orgId);
    file.invites.forEach((invite) => delete invite.orgId);
    writeFileSync(path, JSON.stringify(file));

    const second = await start(hostedSettings);
    const drafts = await call(second.base, "GET", `${sam.basePath}/drafts`, sam.token);
    expect(drafts.status).toBe(200);
    const orgs = await json<Org[]>(await call(second.base, "GET", "/hosted/orgs", ADMIN), 200);
    expect(orgs).toEqual([expect.objectContaining({ id: DEFAULT_ORG_ID, memberCount: 1 })]);
  });
});

describe("registry — orgs", () => {
  const fresh = () => new HostedRegistry(join(tempDir(), "hosted", "registry.json"), MASTER);

  it("creates, renames and lists orgs; names are trimmed and unique ignoring case", () => {
    const registry = fresh();
    const org = registry.createOrg("  Team B ");
    expect(org.name).toBe("Team B");
    expect(registry.renameOrg(org.id, "Team Bee").name).toBe("Team Bee");
    expect(registry.listOrgs().map((entry) => [entry.name, entry.memberCount])).toEqual([["Default", 0], ["Team Bee", 0]]);
    expect(() => registry.createOrg("team BEE")).toThrow(OrgNameTakenError);
    expect(() => registry.renameOrg(org.id, "default")).toThrow(OrgNameTakenError);
    expect(() => registry.renameOrg(org.id, "Team Bee")).not.toThrow();
    expect(() => registry.createOrg("   ")).toThrow(OrgNameError);
    expect(() => registry.renameOrg("nope", "X")).toThrow(OrgNotFoundError);
  });

  it("an invite carries its org, and redeeming it puts the new duo in that org", () => {
    const registry = fresh();
    const org = registry.createOrg("Team B");
    const { invite, code } = registry.createInvite("Kim", new Date(Date.now() + 60_000).toISOString(), null, org.id);
    expect(invite.orgId).toBe(org.id);
    expect(registry.createInvite("Sam", new Date(Date.now() + 60_000).toISOString()).invite.orgId).toBe(DEFAULT_ORG_ID);
    expect(() => registry.createInvite("Eve", new Date().toISOString(), null, "nope")).toThrow(OrgNotFoundError);

    const redeemed = registry.findRedeemableInvite(code);
    const tenant = registry.addTenant(redeemed.id, "Kim", "pw");
    expect(tenant.orgId).toBe(org.id);
    expect(registry.orgOf(tenant.id)?.id).toBe(org.id);
    expect(registry.listOrgMembers(org.id).map((member) => member.duoId)).toEqual([tenant.id]);
    expect(registry.listOrgMembers(DEFAULT_ORG_ID)).toEqual([]);
    expect(() => registry.listOrgMembers("nope")).toThrow(OrgNotFoundError);
  });

  it("lists the declared root duo as a member of its org", () => {
    const registry = fresh();
    registry.declareRootDuo("Shin");
    expect(registry.listOrgMembers(DEFAULT_ORG_ID)).toEqual([expect.objectContaining({ duoId: ROOT_DUO_ID, name: "Shin", isRoot: true })]);
  });

  it("the root duo's membership is in the registry file: a fresh load lists it without any server call", () => {
    const path = join(tempDir(), "hosted", "registry.json");
    new HostedRegistry(path, MASTER).declareRootDuo("Shin");
    const reloaded = new HostedRegistry(path, MASTER);
    expect(reloaded.listOrgMembers(DEFAULT_ORG_ID)).toEqual([expect.objectContaining({ duoId: ROOT_DUO_ID, name: "Shin", isRoot: true })]);
    expect(reloaded.listOrgs()).toEqual([expect.objectContaining({ id: DEFAULT_ORG_ID, memberCount: 1 })]);
    // Declaring the same name again is not a write.
    const before = readFileSync(path, "utf8");
    reloaded.declareRootDuo("Shin");
    expect(readFileSync(path, "utf8")).toBe(before);
    // A registry that never served a root duo has no root member.
    expect(new HostedRegistry(join(tempDir(), "other", "registry.json"), MASTER).listOrgMembers(DEFAULT_ORG_ID)).toEqual([]);
  });

  it("a write that fails leaves memory as it was, for orgs, invites and duos", () => {
    // A regular file where the registry's directory must be, so every write throws for real.
    const blocker = join(tempDir(), "blocked");
    const registry = new HostedRegistry(join(blocker, "registry.json"), MASTER);
    writeFileSync(blocker, "not a directory");
    const expires = new Date(Date.now() + 60_000).toISOString();

    expect(() => registry.createOrg("Team B")).toThrow();
    expect(registry.orgs().map((org) => org.name)).toEqual(["Default"]);
    expect(() => registry.renameOrg(DEFAULT_ORG_ID, "Renamed")).toThrow();
    expect(registry.org(DEFAULT_ORG_ID)?.name).toBe("Default");
    expect(() => registry.createInvite("Kim", expires)).toThrow();
    expect(registry.invites()).toEqual([]);
    expect(() => registry.addTenant("no-invite", "Kim", "pw")).toThrow();
    expect(registry.tenants()).toEqual([]);
    expect(() => registry.declareRootDuo("Shin")).toThrow();
    expect(registry.listOrgMembers(DEFAULT_ORG_ID)).toEqual([]);

    // Once the disk is fine again, the same calls work: nothing half-applied is in the way.
    rmSync(blocker);
    expect(registry.createOrg("Team B").name).toBe("Team B");
    expect(registry.orgs().map((org) => org.name)).toEqual(["Default", "Team B"]);
  });

  it("org ids are lowercase letters and digits only, and created ids conform", () => {
    for (const bad of ["a.b", "a-b", "Acme", "", "acme eu", "a:b"]) {
      expect(() => assertOrgId(bad), bad).toThrow(/lowercase letters and digits/);
    }
    expect(() => assertOrgId(undefined)).toThrow();
    for (const good of ["default", "a2b3c4d5"]) {
      expect(() => assertOrgId(good)).not.toThrow();
    }
    const registry = fresh();
    for (let i = 0; i < 20; i += 1) {
      expect(registry.createOrg(`Org ${i}`).id).toMatch(ORG_ID_PATTERN);
    }
  });

  it("an org name is NFKC-normalized, refuses control and invisible characters, and stays unique ignoring case", () => {
    const registry = fresh();
    expect(normalizeOrgName("\uFF34eam\u3000\uFF22")).toBe("Team B");
    expect(normalizeOrgName("\uFB01nance")).toBe("finance");
    for (const bad of ["Te\u200Bam", "Team\u200D", "Te\uFEFFam", "Te\u202Eam", "Te\nam", "Te\tam", "Team\u0000", "Te\u2028am", "\u200B"]) {
      expect(() => normalizeOrgName(bad), JSON.stringify(bad)).toThrow(OrgNameError);
    }
    expect(() => normalizeOrgName("x".repeat(81))).toThrow(OrgNameError);
    expect(() => normalizeOrgName(42)).toThrow(OrgNameError);

    expect(registry.createOrg("\uFF34eam B").name).toBe("Team B");
    expect(() => registry.createOrg("TEAM b")).toThrow(OrgNameTakenError);
    expect(() => registry.createOrg("\uFF54\uFF45\uFF41\uFF4D B")).toThrow(OrgNameTakenError);
    expect(() => registry.createOrg("Te\u200Bam C")).toThrow(OrgNameError);
  });
});

describe("hosted org routes", () => {
  it("the super admin creates an org, invites into it, and the new member lands there", async () => {
    const { base } = await start(settings());
    const org = await json<Org>(await call(base, "POST", "/hosted/orgs", ADMIN, { name: "Team B" }), 201);
    expect(org).toMatchObject({ name: "Team B", memberCount: 0 });

    const minted = await json<{ orgId: string; link: string }>(
      await call(base, "POST", "/hosted/invites", ADMIN, { name: "Kim", orgId: org.id }),
      201,
    );
    expect(minted.orgId).toBe(org.id);

    const kim = await joinInto(base, org.id, "kim");
    expect(kim.orgId).toBe(org.id);
    const sam = await joinInto(base, undefined, "sam");
    expect(sam.orgId).toBe(DEFAULT_ORG_ID);

    const members = await json<Array<{ duoId: string; name: string }>>(await call(base, "GET", `/hosted/orgs/${org.id}/members`, ADMIN), 200);
    expect(members.map((member) => member.duoId)).toEqual([kim.tenantId]);
    const listed = await json<Org[]>(await call(base, "GET", "/hosted/orgs", ADMIN), 200);
    expect(listed.map((entry) => [entry.id, entry.memberCount])).toEqual([[DEFAULT_ORG_ID, 1], [org.id, 1]]);
    // A member's login says which org they are in.
    const login = await json<Session>(await call(base, "POST", "/hosted/login", undefined, { credential: "sub-kim|kim@x.com|kim" }), 200);
    expect(login.orgId).toBe(org.id);
  });

  it("renames an org, and reports bad input and unknown orgs", async () => {
    const { base } = await start(settings());
    const org = await json<Org>(await call(base, "POST", "/hosted/orgs", ADMIN, { name: "Team B" }), 201);
    expect(await json<Org>(await call(base, "POST", `/hosted/orgs/${org.id}/rename`, ADMIN, { name: "Platform" }), 200)).toMatchObject({ id: org.id, name: "Platform" });
    expect((await call(base, "POST", "/hosted/orgs", ADMIN, { name: "platform" })).status).toBe(409);
    expect((await call(base, "POST", "/hosted/orgs", ADMIN, { name: "" })).status).toBe(400);
    expect((await call(base, "POST", "/hosted/orgs", ADMIN, {})).status).toBe(400);
    expect((await call(base, "POST", "/hosted/orgs/nope/rename", ADMIN, { name: "X" })).status).toBe(404);
    expect((await call(base, "GET", "/hosted/orgs/nope/members", ADMIN)).status).toBe(404);
    expect((await call(base, "POST", "/hosted/invites", ADMIN, { name: "Kim", orgId: "nope" })).status).toBe(404);
    expect((await call(base, "POST", "/hosted/invites", ADMIN, { name: "Kim", orgId: 5 })).status).toBe(400);
  });

  it("lists the root duo in the default org", async () => {
    const { base } = await start(settings(), rootDeps());
    const members = await json<Array<{ duoId: string; isRoot: boolean }>>(await call(base, "GET", `/hosted/orgs/${DEFAULT_ORG_ID}/members`, ADMIN), 200);
    expect(members).toEqual([expect.objectContaining({ duoId: ROOT_DUO_ID, isRoot: true })]);
  });

  describe("authorization", () => {
    const routes: Array<[method: "GET" | "POST", path: string, body?: unknown]> = [
      ["GET", "/hosted/orgs"],
      ["POST", "/hosted/orgs", { name: "Sneaky" }],
      ["POST", `/hosted/orgs/${DEFAULT_ORG_ID}/rename`, { name: "Sneaky" }],
      ["GET", `/hosted/orgs/${DEFAULT_ORG_ID}/members`],
      ["POST", "/hosted/invites", { name: "Eve", orgId: DEFAULT_ORG_ID }],
    ];

    it("no credential is a 401, and a signed-in non-admin is a 403 on every org route", async () => {
      const { base } = await start(settings());
      const member = await joinInto(base, undefined, "sam");
      for (const [method, path, body] of routes) {
        expect((await call(base, method, path, undefined, body)).status, `${method} ${path} anonymous`).toBe(401);
        expect((await call(base, method, path, member.token, body)).status, `${method} ${path} member`).toBe(403);
        expect((await call(base, method, path, "not-a-token", body)).status, `${method} ${path} garbage`).toBe(403);
      }
      const orgs = await json<Org[]>(await call(base, "GET", "/hosted/orgs", ADMIN), 200);
      expect(orgs.map((org) => org.name)).toEqual(["Default"]);
    });

    it("a super admin's own device (an email in DUO_HOSTED_ADMIN_EMAILS) may use them", async () => {
      const { base } = await start(settings(), rootDeps());
      const admin = await json<Session>(await call(base, "POST", "/hosted/login", undefined, { credential: "sub-shin|shin@x.com|Shin" }), 200);
      expect(admin.isAdmin).toBe(true);
      const org = await json<Org>(await call(base, "POST", "/hosted/orgs", admin.token, { name: "Team B" }), 201);
      expect((await call(base, "GET", `/hosted/orgs/${org.id}/members`, admin.token)).status).toBe(200);
      expect((await call(base, "POST", "/hosted/invites", admin.token, { name: "Kim", orgId: org.id })).status).toBe(201);
    });

    it("admin is read live from the env: removing an email revokes admin on the next request, with no restart", async () => {
      const env: NodeJS.ProcessEnv = {
        DUO_HOSTED_MASTER_KEY: MASTER,
        DUO_HOSTED_ADMIN_TOKEN: ADMIN,
        DUO_HOSTED_ADMIN_EMAILS: "shin@x.com, Ann@X.com",
        DUO_HOSTED_ROOT: join(tempDir(), "hosted"),
        DUO_HOSTED_GOOGLE_CLIENT_ID: "cid",
      };
      const { base } = await start(hostedSettingsFrom(env));
      const { code } = await json<{ code: string }>(await call(base, "POST", "/hosted/invites", ADMIN, { name: "Ann" }), 201);
      const ann = await json<Session>(await call(base, "POST", "/hosted/signup", undefined, { invite: code, credential: "sub-ann|ann@x.com|Ann" }), 201);
      expect(ann.isAdmin).toBe(true);
      expect((await call(base, "GET", "/hosted/orgs", ann.token)).status).toBe(200);

      env.DUO_HOSTED_ADMIN_EMAILS = "shin@x.com";
      expect((await call(base, "GET", "/hosted/orgs", ann.token)).status).toBe(403);
      expect((await call(base, "GET", "/hosted/orgs", ADMIN)).status).toBe(200);

      env.DUO_HOSTED_ADMIN_EMAILS = "shin@x.com,ann@x.com";
      expect((await call(base, "GET", "/hosted/orgs", ann.token)).status).toBe(200);
    });

    it("a member whose email is added to the list gains admin on a restart with the new settings", async () => {
      const hostedSettings = settings();
      const first = await start(hostedSettings);
      const { code } = await json<{ code: string }>(await call(first.base, "POST", "/hosted/invites", ADMIN, { name: "Ann" }), 201);
      const ann = await json<Session>(await call(first.base, "POST", "/hosted/signup", undefined, { invite: code, credential: "sub-ann|ann@x.com|Ann" }), 201);
      expect(ann.isAdmin).toBe(false);
      expect((await call(first.base, "GET", "/hosted/orgs", ann.token)).status).toBe(403);
      await running.pop()!.close();

      const second = await start({ ...hostedSettings, adminEmails: ["shin@x.com", "ann@x.com"] });
      expect((await call(second.base, "GET", "/hosted/orgs", ann.token)).status).toBe(200);
    });

    it("a login refreshes the stored email from the verified identity, so a reissued address stops carrying admin", async () => {
      const hostedSettings = settings({ adminEmails: ["shin@x.com", "ann@x.com"] });
      const { base } = await start(hostedSettings);
      const { code } = await json<{ code: string }>(await call(base, "POST", "/hosted/invites", ADMIN, { name: "Ann" }), 201);
      const ann = await json<Session>(await call(base, "POST", "/hosted/signup", undefined, { invite: code, credential: "sub-ann|ann@x.com|Ann" }), 201);
      expect(ann.isAdmin).toBe(true);
      expect((await call(base, "GET", "/hosted/orgs", ann.token)).status).toBe(200);

      // The same Google account (subject) now signs in under a different address, which is not an admin address.
      const relogin = await json<Session>(await call(base, "POST", "/hosted/login", undefined, { credential: "sub-ann|ann@elsewhere.com|Ann" }), 200);
      expect(relogin.isAdmin).toBe(false);
      const stored = JSON.parse(readFileSync(join(hostedSettings.hostedRoot, "registry.json"), "utf8")) as { tenants: Array<{ email: string }> };
      expect(stored.tenants.map((tenant) => tenant.email)).toEqual(["ann@elsewhere.com"]);
      // The email is what admin is judged on, so the earlier device loses it as well.
      expect((await call(base, "GET", "/hosted/orgs", ann.token)).status).toBe(403);
      expect((await call(base, "GET", "/hosted/orgs", relogin.token)).status).toBe(403);
    });

    it("a login refreshes the root claim's email too", async () => {
      const { base } = await start(settings(), rootDeps());
      const admin = await json<Session>(await call(base, "POST", "/hosted/login", undefined, { credential: "sub-shin|shin@x.com|Shin" }), 200);
      expect((await call(base, "GET", "/hosted/orgs", admin.token)).status).toBe(200);
      expect((await call(base, "POST", "/hosted/login", undefined, { credential: "sub-shin|shin@moved.com|Shin" })).status).toBe(404);
      expect((await call(base, "GET", "/hosted/orgs", admin.token)).status).toBe(403);
    });
  });
});

describe("duo hosted org … (CLI parity)", () => {
  it("creates, lists, renames, and invites into an org through the running daemon", async () => {
    const { base } = await start(settings());
    const env = { DUO_HOSTED_MASTER_KEY: MASTER, DUO_HOSTED_ADMIN_TOKEN: ADMIN, PORT: new URL(base).port };

    const org = await runHostedOrgCreate("Team B", env);
    expect(org.name).toBe("Team B");
    await runHostedOrgRename(org.id, "Platform", env);
    expect((await runHostedOrgList(env)).map((entry) => entry.name)).toEqual(["Default", "Platform"]);

    const invite = await runHostedInvite("Kim", 24, env, org.id);
    expect(invite.orgId).toBe(org.id);
    const kim = await json<Session>(
      await call(base, "POST", "/hosted/signup", undefined, { invite: invite.code, credential: "sub-kim|kim@x.com|Kim" }),
      201,
    );
    expect(kim.orgId).toBe(org.id);
    expect((await runHostedOrgMembers(org.id, env)).map((member) => member.name)).toEqual(["Kim"]);

    // With no --org the invite goes to the default org, and an unknown org is an error.
    expect((await runHostedInvite("Sam", 24, env)).orgId).toBe(DEFAULT_ORG_ID);
    await expect(runHostedInvite("Eve", 24, env, "nope")).rejects.toThrow(/no org "nope"/);
    await expect(runHostedOrgCreate("platform", env)).rejects.toThrow(/already an org/);
  });
});
