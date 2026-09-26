import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { IdentityError, type IdentityVerifier } from "../src/hosted/google.js";
import { runHostedInvite, runHostedOrgCreate, runHostedOrgList, runHostedOrgMembers, runHostedOrgRename } from "../src/hosted/invite.js";
import { DEFAULT_ORG_ID, OrgNameError, OrgNameTakenError, OrgNotFoundError, ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { createHostedServer, type HostedServer, type HostedSettings } from "../src/hosted/server.js";
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

    it("admin is read live from the env: a member whose email is later removed loses it", async () => {
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
