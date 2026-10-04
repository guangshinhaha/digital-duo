import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertServerName,
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

  it("refuses a server name with a port, as the org wall's module does (it cannot read @x:host:port)", () => {
    expect(() => personUserIdFor("org", "abc", "duo.example:8448")).toThrow(/port is not supported/);
    expect(() => assertServerName("duo:8448")).toThrow(/bare hostname/);
    expect(assertServerName("duo.example.com")).toBe("duo.example.com");
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

describe("MatrixProvisioner — re-syncing display names on the already path (#272)", () => {
  it("an account recorded before display names were cached is named on the next sweep, and a further sweep costs no call", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam Tan");
    // Accounts recorded with no cached display name, as a pre-#272 build (or Synapse itself) would have left them.
    registry.setMatrixAccounts(id, { personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` }, "syt_old");

    const outcome = await provisioner.provision(id);
    expect(outcome.status).toBe("already");
    expect(outcome.accounts!.displayName).toBe("Sam Tan");
    expect(fake.users.get(`@default.${id}:duo.test`)).toMatchObject({ displayname: "Sam Tan" });
    expect(fake.users.get(`@duo-default.${id}:duo.test`)).toMatchObject({ displayname: "Sam Tan's duo" });
    expect(registry.matrixAccounts(id)!.displayName).toBe("Sam Tan");

    // Named right now: the next sweep makes no call at all for it.
    const calls = fake.requests.length;
    expect((await provisioner.provision(id)).status).toBe("already");
    expect(fake.requests).toHaveLength(calls);
  });

  it("a recorded name that has drifted from the registry is corrected", async () => {
    const { registry, fake, provisioner, path } = setup();
    const id = addDuo(registry, "Sam Tan");
    await provisioner.provision(id);
    expect(registry.matrixAccounts(id)!.displayName).toBe("Sam Tan");

    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.tenants[0].matrix.displayName = "Stale Name";
    writeFileSync(path, JSON.stringify(tampered));
    const reopened = new HostedRegistry(path, MASTER);
    const sweeper = new MatrixProvisioner({ registry: reopened, admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: fake.fetch }), serverName: FAKE_SERVER_NAME, log: () => {} });

    expect((await sweeper.provision(id)).status).toBe("already");
    expect(fake.users.get(`@default.${id}:duo.test`)!.displayname).toBe("Sam Tan");
    expect(reopened.matrixAccounts(id)!.displayName).toBe("Sam Tan");
  });

  it("a Synapse problem during the resync is logged and left for the next sweep, and never turns `already` into `pending` or `failed`", async () => {
    const { registry, fake, provisioner, logs } = setup();
    const id = addDuo(registry, "Sam Tan");
    registry.setMatrixAccounts(id, { personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` }, "syt_old");
    fake.down = true;

    const outcome = await provisioner.provision(id);
    expect(outcome.status).toBe("already");
    expect(registry.matrixAccounts(id)!.displayName).toBeUndefined();
    expect(logs.some((line) => line.includes("could not re-sync the Matrix display name"))).toBe(true);

    fake.down = false;
    expect((await provisioner.provision(id)).status).toBe("already");
    expect(registry.matrixAccounts(id)!.displayName).toBe("Sam Tan");
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
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/different server/);
  });

  it("a mismatch needs an operator: it is reported and logged, but writes no pending mark and is never retried", async () => {
    const { registry, provisioner, path, logs } = setup();
    const id = addDuo(registry, "Sam");
    await provisioner.provision(id);
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.tenants[0].matrix.personUserId = `@wrongorg.${id}:duo.test`;
    writeFileSync(path, JSON.stringify(tampered));
    const reopened = new HostedRegistry(path, MASTER);
    const sweeper = new MatrixProvisioner({ registry: reopened, admin: new SynapseAdmin({ baseUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, fetch: createFakeSynapse().fetch }), serverName: FAKE_SERVER_NAME, log: (line) => logs.push(line) });

    const summary = await sweeper.provisionAll();
    expect(summary).toMatchObject({ provisioned: 0, already: 0, pending: 0, failed: 1 });
    expect(summary.outcomes[0]).toMatchObject({ duoId: id, status: "failed", error: expect.stringContaining("do not match its org") });
    expect(reopened.matrixPending(id)).toBeUndefined();
    expect(logs.some((line) => line.includes("needs an operator"))).toBe(true);
    // Running again does not add attempts, and the retry sweep has nothing to do for it.
    await sweeper.provisionAll();
    expect(reopened.matrixPending(id)).toBeUndefined();
    expect(sweeper.pendingDuoIds()).toEqual([]);
    expect((await sweeper.retryPending()).outcomes).toEqual([]);
  });
});

describe("MatrixProvisioner — one duo's bug does not stop the sweep", () => {
  it("an unexpected error is that duo's outcome; later duos are still provisioned, and only the error's name is logged", async () => {
    const { registry, fake, logs } = setup();
    const first = addDuo(registry, "A");
    const second = addDuo(registry, "B");
    const real = fake.fetch;
    // whoami answers a server part the naming rules reject (a slash), once: a bug-shaped failure, not a Synapse one.
    let poisoned = true;
    const provisioner = new MatrixProvisioner({
      registry,
      admin: new SynapseAdmin({
        baseUrl: FAKE_SYNAPSE_URL,
        adminToken: FAKE_ADMIN_TOKEN,
        fetch: async (input, init) => {
          const url = String(input);
          if (poisoned && url.endsWith("/whoami")) {
            poisoned = false;
            return new Response(JSON.stringify({ user_id: "@workspace-admin:duo/evil" }), { status: 200, headers: { "content-type": "application/json" } });
          }
          return real(input, init);
        },
      }),
      log: (line) => logs.push(line),
    });
    const summary = await provisioner.provisionAll();
    expect(summary).toMatchObject({ provisioned: 1, failed: 1, pending: 0 });
    const outcomes = new Map(summary.outcomes.map((outcome) => [outcome.duoId, outcome]));
    expect(outcomes.get(first)).toMatchObject({ status: "failed", error: expect.stringContaining("Error") });
    expect(outcomes.get(second)!.status).toBe("provisioned");
    expect(logs.some((line) => line.includes(`failed unexpectedly for duo ${first} (Error)`))).toBe(true);
    expect(logs.join("\n")).not.toContain("duo/evil");
    // It is still owed accounts, marked so it backs off, and the next run finishes it.
    expect(registry.matrixPending(first)).toMatchObject({ attempts: 1 });
    expect((await provisioner.provisionAll()).provisioned).toBe(1);
  });

  it("a registry write that fails while storing the token is retried once, and a token that cannot be stored is logged without the token", async () => {
    const { registry, fake, logs, provisioner } = setup();
    const ok = addDuo(registry, "A");
    const lost = addDuo(registry, "B");
    const real = registry.setMatrixAccounts.bind(registry);
    let calls = 0;
    registry.setMatrixAccounts = (duoId, ids, token) => {
      calls += 1;
      if (duoId === ok && calls === 1) {
        throw new Error("disk hiccup");
      }
      if (duoId === lost) {
        throw new Error(`disk full ${token}`);
      }
      return real(duoId, ids, token);
    };
    const summary = await provisioner.provisionAll();
    // The transient failure was retried in place: one token, one duo done.
    expect(registry.matrixAccounts(ok)).toBeDefined();
    expect(fake.minted.filter((entry) => entry.userId.includes(ok))).toHaveLength(1);
    // The persistent one is reported, named in the log, and leaks no token.
    expect(summary).toMatchObject({ provisioned: 1, failed: 1 });
    expect(logs.some((line) => line.includes(`minted a Matrix token for duo ${lost} but could not store it`))).toBe(true);
    for (const entry of fake.minted) {
      expect(JSON.stringify([logs, summary])).not.toContain(entry.token);
    }
  });
});

describe("MatrixProvisioner — retryPending backs off per duo", () => {
  it("skips a duo until base x 2^(attempts-1) has passed since its last attempt, then tries again", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam");
    fake.down = true;
    await provisioner.provision(id); // attempt 1
    const attempts = () => registry.matrixPending(id)!.attempts;
    const last = () => Date.parse(registry.matrixPending(id)!.lastAttemptAt);

    // Default base is 60s: nothing is due 30s later, and no request is made.
    const calls = fake.requests.length;
    expect(provisioner.hasRetryDue(last() + 30_000)).toBe(false);
    expect((await provisioner.retryPending(last() + 30_000)).outcomes).toEqual([]);
    expect(fake.requests).toHaveLength(calls);

    expect((await provisioner.retryPending(last() + 60_000)).pending).toBe(1); // attempt 2
    expect(attempts()).toBe(2);
    // The second failure waits twice as long.
    expect(provisioner.hasRetryDue(last() + 119_000)).toBe(false);
    expect(provisioner.hasRetryDue(last() + 120_000)).toBe(true);
    // And the wait is capped.
    for (let n = 0; n < 12; n += 1) {
      await provisioner.provision(id);
    }
    expect(provisioner.hasRetryDue(last() + 30 * 60_000 - 1)).toBe(false);
    expect(provisioner.hasRetryDue(last() + 30 * 60_000)).toBe(true);
  });
});

describe("MatrixProvisioner — stop()", () => {
  it("lets the duo in flight finish and starts no other", async () => {
    const { registry, fake } = setup();
    const ids = [addDuo(registry, "A"), addDuo(registry, "B"), addDuo(registry, "C")];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const provisioner = new MatrixProvisioner({
      registry,
      admin: new SynapseAdmin({
        baseUrl: FAKE_SYNAPSE_URL,
        adminToken: FAKE_ADMIN_TOKEN,
        fetch: async (input, init) => {
          entered();
          await gate;
          return fake.fetch(input, init);
        },
      }),
      serverName: FAKE_SERVER_NAME,
      log: () => {},
    });
    const sweep = provisioner.provisionAll();
    await started;
    provisioner.stop();
    release();
    const summary = await sweep;
    expect(summary.outcomes.map((outcome) => outcome.duoId)).toEqual([ids[0]]);
    expect(registry.matrixAccounts(ids[0]!)).toBeDefined();
    expect(registry.matrixAccounts(ids[1]!)).toBeUndefined();
    expect((await provisioner.retryPending()).outcomes).toEqual([]);
    await provisioner.whenIdle();
  });
});


describe("MatrixProvisioner.remintToken — a new token for a duo Synapse no longer knows", () => {
  it("mints a fresh never-expiring token, keeps the accounts, stores it encrypted, and logs no token", async () => {
    const { registry, fake, logs, provisioner } = setup();
    const id = addDuo(registry, "Sam Tan");
    await provisioner.provision(id);
    const first = registry.duoMatrixToken(id)!;
    const accounts = registry.matrixAccounts(id)!;

    const outcome = await provisioner.remintToken(id);
    expect(outcome.status).toBe("reminted");
    expect(outcome.accounts).toMatchObject({ personUserId: accounts.personUserId, duoUserId: accounts.duoUserId });
    expect(fake.minted).toHaveLength(2);
    expect(fake.minted[1]).toMatchObject({ userId: accounts.duoUserId, validUntilMs: null });
    const second = registry.duoMatrixToken(id)!;
    expect(second).toBe(fake.minted[1]!.token);
    expect(second).not.toBe(first);
    expect(registry.matrixAccounts(id)!.duoTokenCipher).not.toBe(accounts.duoTokenCipher);
    expect(JSON.stringify(outcome)).not.toContain(second);
    expect(logs.join("\n")).not.toContain(second);
    expect(logs.join("\n")).not.toContain(first);
  });

  it("brings the accounts back after Synapse's database was reset, where a bare mint would 404", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam Tan");
    await provisioner.provision(id);
    fake.users.clear();
    // `provision` is content with recorded accounts; only a re-mint repairs them.
    expect((await provisioner.provision(id)).status).toBe("already");
    expect(fake.users.size).toBe(0);

    expect((await provisioner.remintToken(id)).status).toBe("reminted");
    expect(fake.users.has(registry.matrixAccounts(id)!.duoUserId)).toBe(true);
    expect(fake.users.has(registry.matrixAccounts(id)!.personUserId)).toBe(true);
    expect(fake.minted).toHaveLength(2);
  });

  it("changes nothing and marks nothing when Synapse cannot be reached", async () => {
    const { registry, fake, provisioner } = setup();
    const id = addDuo(registry, "Sam Tan");
    await provisioner.provision(id);
    const cipher = registry.matrixAccounts(id)!.duoTokenCipher;
    fake.down = true;
    const outcome = await provisioner.remintToken(id);
    expect(outcome.status).toBe("pending");
    expect(registry.matrixAccounts(id)!.duoTokenCipher).toBe(cipher);
    expect(registry.matrixPending(id)).toBeUndefined();
  });

  it("provisions a duo that has no accounts, refuses recorded accounts that do not fit, and shares one mint between callers", async () => {
    const { registry, fake, provisioner } = setup();
    const fresh = addDuo(registry, "Fresh");
    expect((await provisioner.remintToken(fresh)).status).toBe("provisioned");

    const both = await Promise.all([provisioner.remintToken(fresh), provisioner.remintToken(fresh)]);
    expect(both.map((outcome) => outcome.status)).toEqual(["reminted", "reminted"]);
    expect(fake.minted).toHaveLength(2);

    const other = addDuo(registry, "Other");
    registry.setMatrixAccounts(other, { personUserId: "@wrongorg.someone:duo.test", duoUserId: "@duo-wrongorg.someone:duo.test" }, "syt_x");
    const before = fake.minted.length;
    expect((await provisioner.remintToken(other)).status).toBe("failed");
    expect(fake.minted).toHaveLength(before);
    await expect(provisioner.remintToken("nosuchduo")).rejects.toThrow(/No hosted duo/);
  });
});
