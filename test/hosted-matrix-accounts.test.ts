import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  duoUserIdOrThrow,
  MatrixProvisioner,
  orgIdOfUserId,
  personUserIdFor,
  reconcileMatrixAccounts,
  SERVICE_ACCOUNT_LOCALPART,
} from "../src/hosted/matrix-accounts.js";
import { DEFAULT_ORG_ID, ROOT_DUO_ID } from "../src/hosted/orgs.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import { SynapseAdmin } from "../src/hosted/synapse-admin.js";
import { duoOwnerUserIdOf, isDuoUserId } from "../src/workspace/directory.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SERVER_NAME, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { useTempDir } from "./helpers/temp-dir.js";

const tempDir = useTempDir();
const MASTER = "master-key-for-tests";

function setup(options: { serverName?: string | null; fake?: FakeSynapse } = {}) {
  const registry = new HostedRegistry(join(tempDir(), "registry.json"), MASTER);
  const fake = options.fake ?? createFakeSynapse();
  const logs: string[] = [];
  const admin = new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch });
  const provisioner = new MatrixProvisioner({
    registry,
    admin,
    serverName: options.serverName === null ? undefined : (options.serverName ?? FAKE_SERVER_NAME),
    log: (line) => logs.push(line),
  });
  return { registry, fake, logs, provisioner, path: join(tempDir(), "registry.json") };
}

function addDuo(registry: HostedRegistry, name: string, orgId = DEFAULT_ORG_ID, id = registry.newTenantId()): string {
  const { invite } = registry.createInvite(name, new Date(Date.now() + 3_600_000).toISOString(), null, orgId);
  return registry.addTenant(invite.id, name, "passphrase", id).id;
}

describe("account naming (docs/deploy/hosted-workspace.md §4)", () => {
  it("puts the org in the localpart and the duo's id is exactly duoUserIdFor of the person's", () => {
    const person = personUserIdFor("k7m2x9pq", "c4rt8h2wvn", "duo");
    expect(person).toBe("@k7m2x9pq.c4rt8h2wvn:duo");
    expect(duoUserIdOrThrow(person)).toBe("@duo-k7m2x9pq.c4rt8h2wvn:duo");
    // The directory reads the same ids without a mapping table.
    expect(isDuoUserId("@duo-k7m2x9pq.c4rt8h2wvn:duo")).toBe(true);
    expect(duoOwnerUserIdOf("@duo-k7m2x9pq.c4rt8h2wvn:duo")).toBe(person);
    expect(isDuoUserId(person)).toBe(false);
  });

  it("reads an account's org back from its id the way the Synapse module does", () => {
    expect(orgIdOfUserId("@k7m2x9pq.c4rt8h2wvn:duo")).toBe("k7m2x9pq");
    expect(orgIdOfUserId("@duo-k7m2x9pq.c4rt8h2wvn:duo")).toBe("k7m2x9pq");
    expect(orgIdOfUserId(`@${SERVICE_ACCOUNT_LOCALPART}:duo`)).toBeNull();
    expect(orgIdOfUserId("not a user id")).toBeNull();
  });

  it("refuses ids that would break the first-dot split, and a server name that is not a hostname", () => {
    expect(() => personUserIdFor("bad.org", "abc", "duo")).toThrow(/lowercase letters and digits/);
    expect(() => personUserIdFor("org", "a.b", "duo")).toThrow(/handle/);
    expect(() => personUserIdFor("org", "abc", "duo/evil")).toThrow(/server name/);
    expect(() => duoUserIdOrThrow("not-shaped")).toThrow(/not @localpart:server shaped/);
  });
});

describe("MatrixProvisioner — accounts for a person and their duo", () => {
  it("creates both accounts (no password, display names set), stores the duo's token encrypted, and records where", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam Tan");
    const outcome = await provisioner.provision(id);

    expect(outcome.status).toBe("provisioned");
    expect(outcome.accounts).toMatchObject({ personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` });
    expect(fake.users.get(`@default.${id}:duo.test`)).toEqual({ displayname: "Sam Tan", admin: false, hasPassword: false });
    expect(fake.users.get(`@duo-default.${id}:duo.test`)).toEqual({ displayname: "Sam Tan's duo", admin: false, hasPassword: false });
    // Only the duo gets a token, and it does not expire (§5).
    expect(fake.minted).toHaveLength(1);
    expect(fake.minted[0]).toMatchObject({ userId: `@duo-default.${id}:duo.test`, validUntilMs: null });
    expect(registry.duoMatrixToken(id)).toBe(fake.minted[0]!.token);
    expect(registry.matrixPending(id)).toBeUndefined();
  });

  it("names accounts after the duo's own org, so two orgs can each have the same person", async () => {
    const { registry, provisioner } = setup();
    const other = registry.createOrg("Other Team");
    const a = addDuo(registry, "Sam", DEFAULT_ORG_ID);
    const b = addDuo(registry, "Sam", other.id);
    await provisioner.provisionAll();
    expect(registry.matrixAccounts(a)!.personUserId).toBe(`@default.${a}:duo.test`);
    expect(registry.matrixAccounts(b)!.personUserId).toBe(`@${other.id}.${b}:duo.test`);
    expect(orgIdOfUserId(registry.matrixAccounts(b)!.duoUserId)).toBe(other.id);
    expect(reconcileMatrixAccounts(registry)).toEqual([]);
  });

  it("is a no-op when run again: no calls, no second token", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    await provisioner.provision(id);
    const calls = fake.requests.length;
    const token = registry.duoMatrixToken(id);
    const again = await provisioner.provision(id);
    expect(again.status).toBe("already");
    expect(fake.requests).toHaveLength(calls);
    expect(registry.duoMatrixToken(id)).toBe(token);
    expect(fake.minted).toHaveLength(1);
  });

  it("reuses accounts that already exist on Synapse instead of failing or duplicating", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    await fake.fetch(`${FAKE_SYNAPSE_URL}/_synapse/admin/v2/users/${encodeURIComponent(`@default.${id}:duo.test`)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${FAKE_ADMIN_TOKEN}` },
      body: JSON.stringify({ displayname: "Old name" }),
    });
    expect((await provisioner.provision(id)).status).toBe("provisioned");
    expect(fake.users.size).toBe(2);
    expect(fake.users.get(`@default.${id}:duo.test`)!.displayname).toBe("Sam");
  });

  it("gives the pre-hosted root duo accounts too, with the handle root, in its org", async () => {
    const { registry, fake, provisioner } = setup();
    registry.declareRootDuo("Shin");
    const outcome = await provisioner.provision(ROOT_DUO_ID);
    expect(outcome.accounts).toMatchObject({ personUserId: "@default.root:duo.test", duoUserId: "@duo-default.root:duo.test" });
    expect(fake.users.get("@duo-default.root:duo.test")!.displayname).toBe("Shin's duo");
    expect(registry.matrixAccounts(ROOT_DUO_ID)!.duoUserId).toBe("@duo-default.root:duo.test");
    expect(registry.duoMatrixToken(ROOT_DUO_ID)).toBe(fake.minted[0]!.token);
    // The root duo's record survives a restart.
    const reopened = new HostedRegistry(join(tempDir(), "registry.json"), MASTER);
    expect(reopened.duoMatrixToken(ROOT_DUO_ID)).toBe(fake.minted[0]!.token);
  });

  it("the backfill provisions every existing duo and skips the ones already done", async () => {
    const { registry, fake, provisioner } = setup();
    registry.declareRootDuo("Shin");
    const ids = [addDuo(registry, "A"), addDuo(registry, "B"), addDuo(registry, "C")];
    await provisioner.provision(ids[0]!);
    const summary = await provisioner.provisionAll();
    expect(summary).toMatchObject({ provisioned: 3, already: 1, pending: 0 });
    expect(fake.users.size).toBe(8);
    expect(provisioner.pendingDuoIds()).toEqual([]);
    expect((await provisioner.provisionAll()).provisioned).toBe(0);
  });

  it("reads the server name from the admin token's own user id when none is configured", async () => {
    const { registry, provisioner } = setup({ serverName: null, fake: createFakeSynapse({ serverName: "chat.example" }) });
    const id = addDuo(registry, "Sam");
    expect((await provisioner.provision(id)).accounts!.personUserId).toBe(`@default.${id}:chat.example`);
  });

  it("two overlapping runs for one duo share one attempt and one token", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    const [a, b] = await Promise.all([provisioner.provision(id), provisioner.provision(id)]);
    expect(a).toBe(b);
    expect(fake.minted).toHaveLength(1);
  });

  it("throws (a bug, not an outage) for a duo the registry does not know", async () => {
    const { provisioner } = setup();
    await expect(provisioner.provision("nosuchduo")).rejects.toThrow(/No hosted duo/);
  });
});

describe("MatrixProvisioner — Synapse is down", () => {
  it("marks the duo pending, does not throw, and finishes the job on the next run", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    fake.down = true;
    const outcome = await provisioner.provision(id);
    expect(outcome.status).toBe("pending");
    expect(outcome.error).toMatch(/could not be reached/);
    expect(registry.matrixAccounts(id)).toBeUndefined();
    expect(registry.matrixPending(id)).toMatchObject({ attempts: 1, lastError: outcome.error });
    expect(provisioner.pendingDuoIds()).toEqual([id]);

    await provisioner.provision(id);
    expect(registry.matrixPending(id)).toMatchObject({ attempts: 2 });

    fake.down = false;
    const done = await provisioner.provisionAll();
    expect(done).toMatchObject({ provisioned: 1, pending: 0 });
    expect(registry.matrixPending(id)).toBeUndefined();
    expect(registry.matrixAccounts(id)).toBeDefined();
    expect(provisioner.pendingDuoIds()).toEqual([]);
  });

  it("a failure after the person account exists leaves no half-recorded state and is repaired by retry", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    // whoami is skipped (server name configured): PUT person ok, PUT duo fails.
    let puts = 0;
    const realFetch = fake.fetch;
    const flaky = new MatrixProvisioner({
      registry,
      admin: new SynapseAdmin({
        baseUrl: FAKE_SYNAPSE_URL,
        adminToken: FAKE_ADMIN_TOKEN,
        fetch: async (input, init) => {
          if (init?.method === "PUT" && ++puts === 2) {
            return new Response(JSON.stringify({ errcode: "M_UNKNOWN" }), { status: 502 });
          }
          return realFetch(input, init);
        },
      }),
      serverName: FAKE_SERVER_NAME,
      log: () => {},
    });
    expect((await flaky.provision(id)).status).toBe("pending");
    expect(registry.matrixAccounts(id)).toBeUndefined();
    expect(fake.minted).toHaveLength(0);
    expect((await provisioner.provision(id)).status).toBe("provisioned");
    expect(fake.users.size).toBe(2);
    expect(fake.minted).toHaveLength(1);
  });

  it("a wrong admin token is reported as pending with the reason, not thrown", async () => {
    const fake = createFakeSynapse({ adminToken: "some-other-token" });
    const { registry, provisioner } = setup({ fake });
    const id = addDuo(registry, "Sam");
    const outcome = await provisioner.provision(id);
    expect(outcome).toMatchObject({ status: "pending", error: expect.stringContaining("HTTP 401 M_UNKNOWN_TOKEN") });
  });
});

describe("the tokens never leak", () => {
  it("the duo token is in the registry file only as ciphertext, and only the master key reads it back", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    await provisioner.provision(id);
    const token = fake.minted[0]!.token;
    const file = readFileSync(join(tempDir(), "registry.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).not.toContain(FAKE_ADMIN_TOKEN);
    expect(file).toContain("duoTokenCipher");
    expect(new HostedRegistry(join(tempDir(), "registry.json"), MASTER).duoMatrixToken(id)).toBe(token);
    expect(() => new HostedRegistry(join(tempDir(), "registry.json"), "the-wrong-master-key").duoMatrixToken(id)).toThrow();
  });

  it("no outcome, log line, pending record or error contains a minted token or the admin token", async () => {
    const { registry, fake, logs, provisioner } = setup();
    const good = addDuo(registry, "Sam");
    const summaryOk = await provisioner.provisionAll();
    fake.failNext(1, 500, "M_UNKNOWN");
    const bad = addDuo(registry, "Kim");
    const summaryBad = await provisioner.provisionAll();
    const everything = JSON.stringify([summaryOk, summaryBad, logs, registry.matrixPending(bad), registry.matrixAccounts(good)?.provisionedAt]);
    expect(fake.minted.length).toBeGreaterThan(0);
    for (const secret of [FAKE_ADMIN_TOKEN, ...fake.minted.map((entry) => entry.token)]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain("duoTokenCipher");
  });
});

describe("reconcileMatrixAccounts", () => {
  it("passes for consistent accounts and names any id that does not start with its duo's org", async () => {
    const { registry, provisioner, path } = setup();
    const id = addDuo(registry, "Sam");
    await provisioner.provision(id);
    expect(reconcileMatrixAccounts(registry)).toEqual([]);

    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.tenants[0].matrix.personUserId = `@wrongorg.${id}:duo.test`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(tampered));
    const problems = reconcileMatrixAccounts(new HostedRegistry(path, MASTER));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(id);
    expect(problems[0]).toContain("do not match its org");
  });

  it("refuses to silently re-provision when the configured server is not the recorded one", async () => {
    const { registry, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    await provisioner.provision(id);
    const moved = new MatrixProvisioner({
      registry,
      admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: createFakeSynapse({ serverName: "other.test" }).fetch }),
      serverName: "other.test",
      log: () => {},
    });
    const outcome = await moved.provision(id);
    expect(outcome.status).toBe("pending");
    expect(outcome.error).toMatch(/different server/);
  });
});
