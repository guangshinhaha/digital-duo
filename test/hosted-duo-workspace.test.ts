import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { createFakeSynapse, FAKE_ADMIN_TOKEN, FAKE_SYNAPSE_URL, type FakeSynapse } from "./helpers/fake-synapse.js";
import { FakeWorkspaceTransport } from "./helpers/fake-workspace-transport.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { extractQaPairs, writeQaPairs } from "../src/derivation/qa-pairs.js";
import { putRule } from "../src/derivation/rules.js";
import { writeTopicsFile } from "../src/derivation/topics.js";
import { DuoWorkspaceConnections } from "../src/hosted/duo-workspace.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import {
  createHostedServer,
  hostedSettingsFrom,
  tenantDeps,
  type HostedServer,
  type HostedServerExtras,
  type HostedSettings,
  tenantPaths,
} from "../src/hosted/server.js";
import { embedRecords } from "../src/ingest/embeddings.js";
import { createRecord } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { PUBLIC_PASSED_ON_MESSAGE } from "../src/permissions/public-answer.js";
import type { InferenceProvider } from "../src/provider/types.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";
import { grantAutonomy } from "../src/trust/grants.js";
import type { WorkspaceSettings } from "../src/workspace/settings.js";
import type { WorkspaceTransport } from "../src/workspace/transport.js";
import { WorkspaceConfigError } from "../src/workspace/settings.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const MASTER = "master-key-for-tests";
const running: HostedServer[] = [];
const managers: DuoWorkspaceConnections[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});

/** Fast reconnects, so a test can watch a duo come back without waiting a second. */
const FAST_CONFIG_ENV = { DUO_WORKSPACE_RECONNECT_INITIAL_MS: "20", DUO_WORKSPACE_RECONNECT_MAX_MS: "60" } as NodeJS.ProcessEnv;

/** What each transport the factory built was asked to connect as; the fake homeserver end of every duo's connection. */
class Transports {
  readonly created: { settings: WorkspaceSettings; transport: FakeWorkspaceTransport }[] = [];
  /** Per duo Matrix user id: what to build. Default: a fake that connects at once. */
  readonly behaviors = new Map<string, (settings: WorkspaceSettings) => WorkspaceTransport | Promise<WorkspaceTransport>>();

  readonly factory = (settings: WorkspaceSettings): WorkspaceTransport | Promise<WorkspaceTransport> => {
    const custom = this.behaviors.get(settings.userId);
    if (custom) {
      return custom(settings);
    }
    return this.make(settings);
  };

  make(settings: WorkspaceSettings, transport = new FakeWorkspaceTransport()): FakeWorkspaceTransport {
    this.created.push({ settings, transport });
    return transport;
  }

  forUser(userId: string): FakeWorkspaceTransport[] {
    return this.created.filter((entry) => entry.settings.userId === userId).map((entry) => entry.transport);
  }

  latest(userId: string): FakeWorkspaceTransport {
    const all = this.forUser(userId);
    return all[all.length - 1]!;
  }
}

interface Started {
  hosted: HostedServer;
  base: string;
  logs: string[];
  settings: HostedSettings;
}

async function start(
  options: {
    fake: FakeSynapse;
    transports: Transports;
    env?: NodeJS.ProcessEnv;
    settings?: Partial<HostedSettings>;
    inference?: InferenceProvider;
    extras?: HostedServerExtras;
  },
): Promise<Started> {
  const logs: string[] = [];
  const settings: HostedSettings = {
    hostedRoot: join(tempDir(), "hosted"),
    masterKey: MASTER,
    adminToken: ADMIN,
    publicUrl: "https://daemon.example",
    webUrl: "https://web.example",
    googleClientId: undefined,
    adminEmails: [],
    synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: "https://matrix.example.com" },
    workspaceConnections: { startStaggerMs: 0 },
    ...options.settings,
  };
  const hosted = await createHostedServer(
    {
      config: loadConfig({ ...FAST_CONFIG_ENV, ...options.env }),
      env: { DUO_CORS_ORIGINS: "https://web.example" },
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: options.inference,
      trustProxy: false,
    },
    settings,
    undefined,
    undefined,
    {
      synapseFetch: options.fake.fetch,
      log: (line) => logs.push(line),
      provisionRetryMs: 3_600_000,
      workspaceTransportFactory: options.transports.factory,
      ...options.extras,
    },
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}`, logs, settings };
}

const admin = { authorization: `Bearer ${ADMIN}` };

async function joinDuo(base: string, name: string): Promise<{ tenantId: string; token: string }> {
  const invite = (await (
    await fetch(`${base}/hosted/invites`, { method: "POST", headers: { "content-type": "application/json", ...admin }, body: JSON.stringify({ name }) })
  ).json()) as { code: string };
  const response = await fetch(`${base}/hosted/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: invite.code, name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { tenantId: string; token: string };
}

function duoUserOf(hosted: HostedServer, duoId: string): string {
  return hosted.registry.matrixAccounts(duoId)!.duoUserId;
}

/** Someone else, a person (not a duo), asking in a direct room with the duo. */
function question(duoUserId: string, body: string, eventId: string, roomId = "!dm:duo.test") {
  const asker = "@default.someone:duo.test";
  return { eventId, roomId, senderId: asker, body, originServerTs: Date.now(), joinedMemberIds: [duoUserId, asker] };
}

async function connected(hosted: HostedServer, duoId: string): Promise<void> {
  await expect.poll(() => hosted.workspace!.states().find((state) => state.duoId === duoId)?.phase, { timeout: 8_000 }).toBe("connected");
}

async function answersOf(transport: FakeWorkspaceTransport, count = 1): Promise<string[]> {
  await expect.poll(() => transport.sentAnswers.length, { timeout: 8_000 }).toBeGreaterThanOrEqual(count);
  return transport.sentAnswers.map((sent) => sent.content.body);
}

/** Gives one duo's store a corpus with one publicly-answerable fact, granted for direct answering. */
async function seedFact(storePath: string, passphrase: string, duoDir: string, fact: { topicId: string; ask: string; answer: string; scope: string }): Promise<void> {
  const questionRecord = createRecord({ source: "test", sourceRef: null, kind: "question_to_me", author: "other", text: fact.ask, timestamp: "2026-01-01T00:00:01.000Z", threadId: `t-${fact.topicId}`, audience: "channel" });
  const answerRecord = createRecord({ source: "test", sourceRef: null, kind: "my_answer", author: "me", text: `OFFICIAL (OPEN)\n${fact.answer}`, timestamp: "2026-01-01T00:00:02.000Z", threadId: `t-${fact.topicId}`, audience: "channel" });
  writeRecords(storePath, passphrase, [questionRecord, answerRecord]);
  await embedRecords(storePath, passphrase, createFakeEmbeddingProvider());
  const { pairs } = await extractQaPairs([questionRecord, answerRecord]);
  writeQaPairs(storePath, passphrase, pairs.map((pair) => ({ ...pair, topicId: fact.topicId })));
  withDatabase(storePath, passphrase, true, (db) => {
    putRule(
      db,
      {
        id: fact.topicId,
        topicId: fact.topicId,
        text: fact.answer,
        status: "confirmed",
        supportCount: 3,
        consistency: 0.95,
        createdAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
        reviewStatus: "approved",
        origin: "derived",
        supersededByRuleId: null,
        correctionDraftId: null,
        correctionQuestion: null,
      },
      pairs.map((pair) => pair.id),
    );
  });
  writeTopicsFile(duoDir, [{ id: fact.topicId, label: fact.scope, createdAt: new Date().toISOString() }]);
  grantAutonomy(storePath, passphrase, duoDir, { scopeText: fact.scope, tier: "T0", topicId: fact.topicId });
}

/** Answers with whichever fact marker the prompt it was given contains, so an answer can only carry what that duo's own corpus put in front of it. */
const markerProvider: InferenceProvider = {
  name: "fake",
  async complete(prompt: string) {
    // The draft's own confidence check: the corpus-agreement half is what the pipeline actually weighs.
    if (prompt.includes("On a scale of 0 to 100")) {
      return "95";
    }
    const marker = /(ALPHA|BRAVO)-FACT/.exec(prompt);
    return marker ? `${marker[1]}-FACT is the answer` : "I do not know";
  },
};

describe("each hosted duo connects to the workspace as itself and answers there (#236)", () => {
  it("connects with the duo's own token from the registry, to the private URL, and answers a passed-on question that lands in that owner's Escalations", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    // The env carries a personal-hardware trio and Synapse's admin token: neither may be what a duo connects with.
    const { hosted, base } = await start({
      fake,
      transports,
      env: { DUO_WORKSPACE_HOMESERVER: "https://elsewhere.example", DUO_WORKSPACE_ACCESS_TOKEN: "syt_env_token_not_for_hosted", DUO_WORKSPACE_USER_ID: "@duo-env:elsewhere.example" },
    });
    const sam = await joinDuo(base, "Sam");
    await connected(hosted, sam.tenantId);

    const duoUserId = duoUserOf(hosted, sam.tenantId);
    expect(duoUserId).toBe(`@duo-default.${sam.tenantId}:duo.test`);
    expect(transports.created).toHaveLength(1);
    const { settings } = transports.created[0]!;
    expect(settings.userId).toBe(duoUserId);
    expect(settings.homeserverUrl).toBe(FAKE_SYNAPSE_URL);
    expect(settings.accessToken).toBe(hosted.registry.duoMatrixToken(sam.tenantId));
    expect(settings.accessToken).not.toBe("syt_env_token_not_for_hosted");
    expect(settings.accessToken).not.toBe(FAKE_ADMIN_TOKEN);

    // Someone messages the duo. Its corpus is empty, so it passes the question on: the asker gets that, and
    // the question waits in the owner's Escalations (pending drafts), reachable with the owner's own device token.
    const transport = transports.latest(duoUserId);
    transport.deliver(question(duoUserId, "when is the audit?", "$q1"));
    const [answer] = await answersOf(transport);
    expect(answer).toContain(PUBLIC_PASSED_ON_MESSAGE);
    expect(transport.sentAnswers[0]!.roomId).toBe("!dm:duo.test");

    const pending = (await (await fetch(`${base}/t/${sam.tenantId}/drafts?outcome=pending`, { headers: { authorization: `Bearer ${sam.token}` } })).json()) as Array<{ question: string; escalated: boolean }>;
    expect(pending.map((draft) => draft.question)).toContain("when is the audit?");
    expect(pending.find((draft) => draft.question === "when is the audit?")!.escalated).toBe(true);
  });

  it("two duos side by side answer only from their own corpus", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base, settings } = await start({ fake, transports, inference: markerProvider });
    const alice = await joinDuo(base, "Alice");
    const bob = await joinDuo(base, "Bob");
    await connected(hosted, alice.tenantId);
    await connected(hosted, bob.tenantId);
    for (const [tenant, fact] of [
      [alice, { topicId: "topic-leave", ask: "how much vacation leave do I get", answer: "ALPHA-FACT five days of vacation leave per quarter", scope: "vacation leave" }],
      [bob, { topicId: "topic-printer", ask: "which printer is broken on the floor", answer: "BRAVO-FACT the third floor printer", scope: "printer hardware" }],
    ] as const) {
      const paths = tenantPaths(settings.hostedRoot, tenant.tenantId);
      await seedFact(paths.storePath, hosted.registry.passphraseFor(hosted.registry.tenants().find((candidate) => candidate.id === tenant.tenantId)!), paths.duoDir, fact);
    }

    const aliceUser = duoUserOf(hosted, alice.tenantId);
    const bobUser = duoUserOf(hosted, bob.tenantId);
    const aliceTransport = transports.latest(aliceUser);
    const bobTransport = transports.latest(bobUser);

    aliceTransport.deliver(question(aliceUser, "how much vacation leave do I get", "$a1"));
    bobTransport.deliver(question(bobUser, "which printer is broken on the floor", "$b1"));
    const [aliceAnswer] = await answersOf(aliceTransport);
    const [bobAnswer] = await answersOf(bobTransport);
    expect(aliceAnswer).toContain("ALPHA-FACT");
    expect(aliceAnswer).not.toContain("BRAVO-FACT");
    expect(bobAnswer).toContain("BRAVO-FACT");
    expect(bobAnswer).not.toContain("ALPHA-FACT");

    // The same question put to the other duo finds nothing of the first's corpus in it.
    bobTransport.deliver(question(bobUser, "how much vacation leave do I get", "$b2"));
    const bobSecond = (await answersOf(bobTransport, 2))[1]!;
    expect(bobSecond).toContain(PUBLIC_PASSED_ON_MESSAGE);
    expect(bobSecond).not.toContain("ALPHA-FACT");
    aliceTransport.deliver(question(aliceUser, "which printer is broken on the floor", "$a2"));
    const aliceSecond = (await answersOf(aliceTransport, 2))[1]!;
    expect(aliceSecond).not.toContain("BRAVO-FACT");
    // Nothing a duo said went out on the other's connection.
    expect(aliceTransport.sentAnswers.every((sent) => !sent.content.body.includes("BRAVO"))).toBe(true);
    expect(bobTransport.sentAnswers.every((sent) => !sent.content.body.includes("ALPHA"))).toBe(true);
  });

  it("the root duo connects too, as its own account, and answers from its own store", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const storePath = join(tempDir(), "root", "data", "duo.db");
    createEncryptedStore(storePath, "rootpw");
    const config = loadConfig({ ...FAST_CONFIG_ENV });
    const settings: HostedSettings = {
      hostedRoot: join(tempDir(), "hosted"),
      masterKey: MASTER,
      adminToken: ADMIN,
      publicUrl: undefined,
      webUrl: undefined,
      googleClientId: undefined,
      adminEmails: [],
      synapse: { adminUrl: FAKE_SYNAPSE_URL, adminToken: FAKE_ADMIN_TOKEN, serverName: "duo.test", publicUrl: undefined },
      workspaceConnections: { startStaggerMs: 0 },
    };
    const hosted = await createHostedServer(
      { config, env: {}, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false },
      settings,
      {
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
      },
      undefined,
      { synapseFetch: fake.fetch, log: () => {}, provisionRetryMs: 3_600_000, workspaceTransportFactory: transports.factory },
    );
    running.push(hosted);
    await expect.poll(() => hosted.workspace!.states().find((state) => state.duoId === "root")?.phase, { timeout: 8_000 }).toBe("connected");
    const rootUser = hosted.registry.matrixAccounts("root")!.duoUserId;
    expect(rootUser).toBe("@duo-default.root:duo.test");
    transports.latest(rootUser).deliver(question(rootUser, "anything?", "$r1"));
    expect((await answersOf(transports.latest(rootUser)))[0]).toContain(PUBLIC_PASSED_ON_MESSAGE);
  });

  it("held invitations reach the owner's own consent routes, on that duo only", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base } = await start({ fake, transports });
    const sam = await joinDuo(base, "Sam");
    const kim = await joinDuo(base, "Kim");
    await connected(hosted, sam.tenantId);
    await connected(hosted, kim.tenantId);
    const samUser = duoUserOf(hosted, sam.tenantId);
    transports.latest(samUser).deliverInvite({ roomId: "!room:duo.test", inviterId: "@default.someone:duo.test", name: "Lunch", joinedMemberCount: 2 });

    const held = async (tenant: { tenantId: string; token: string }) =>
      ((await (await fetch(`${base}/t/${tenant.tenantId}/workspace/invites`, { headers: { authorization: `Bearer ${tenant.token}` } })).json()) as { invites: Array<{ roomId: string }> }).invites;
    await expect.poll(async () => (await held(sam)).length).toBe(1);
    expect((await held(sam))[0]!.roomId).toBe("!room:duo.test");
    expect(await held(kim)).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("a duo provisioned later, after Synapse was down at sign-up, starts its connection then", async () => {
    const fake = createFakeSynapse();
    fake.down = true;
    const transports = new Transports();
    const { hosted, base } = await start({ fake, transports, extras: { provisionRetryMs: 25 } });
    const sam = await joinDuo(base, "Sam");
    expect(hosted.registry.matrixAccounts(sam.tenantId)).toBeUndefined();
    expect(transports.created).toHaveLength(0);
    expect(hosted.workspace!.states().find((state) => state.duoId === sam.tenantId)?.phase).toBe("none");

    fake.down = false;
    await connected(hosted, sam.tenantId);
    expect(transports.created).toHaveLength(1);
    expect(transports.created[0]!.settings.userId).toBe(duoUserOf(hosted, sam.tenantId));
  });

  it("duos that already have accounts connect at boot", async () => {
    const fake = createFakeSynapse();
    const first = new Transports();
    const one = await start({ fake, transports: first });
    const sam = await joinDuo(one.base, "Sam");
    await connected(one.hosted, sam.tenantId);
    await running.pop()!.close();

    const second = new Transports();
    const two = await start({ fake, transports: second, settings: { hostedRoot: one.settings.hostedRoot } });
    await connected(two.hosted, sam.tenantId);
    expect(second.created).toHaveLength(1);
    expect(second.created[0]!.settings.accessToken).toBe(two.hosted.registry.duoMatrixToken(sam.tenantId));
  });

  it("a re-minted token restarts the duo's connection with the new one, and stops the old", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base } = await start({ fake, transports });
    const sam = await joinDuo(base, "Sam");
    await connected(hosted, sam.tenantId);
    const accounts = hosted.registry.matrixAccounts(sam.tenantId)!;
    const oldToken = transports.created[0]!.settings.accessToken;

    hosted.registry.setMatrixAccounts(sam.tenantId, { personUserId: accounts.personUserId, duoUserId: accounts.duoUserId }, "syt_the_new_token");
    await expect.poll(() => transports.created.length, { timeout: 8_000 }).toBe(2);
    expect(transports.created[1]!.settings.accessToken).toBe("syt_the_new_token");
    expect(oldToken).not.toBe("syt_the_new_token");
    await expect.poll(() => transports.created[0]!.transport.stopCalls).toBeGreaterThanOrEqual(1);
    await connected(hosted, sam.tenantId);
  });

  it("closing stops every duo's connection and leaves no timer behind", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const baseline = timeouts();
    const { hosted, base } = await start({ fake, transports });
    const sam = await joinDuo(base, "Sam");
    const kim = await joinDuo(base, "Kim");
    await connected(hosted, sam.tenantId);
    await connected(hosted, kim.tenantId);
    await running.pop()!.close();

    for (const entry of transports.created) {
      expect(entry.transport.stopCalls).toBeGreaterThanOrEqual(1);
    }
    // Presence intervals, reconnect timers, the dial gate: all cleared. (Give the loop a turn to reap stopped timers.)
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timeouts()).toBeLessThanOrEqual(baseline);
    // And a registry write after close starts nothing.
    const before = transports.created.length;
    hosted.registry.createOrg("After Close");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transports.created).toHaveLength(before);
  });

  it("DUO_HOSTED_WORKSPACE_CONNECT=0 keeps accounts but opens no connection", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base } = await start({ fake, transports, settings: { workspaceConnections: { enabled: false } } });
    const sam = await joinDuo(base, "Sam");
    expect(hosted.workspace).toBeUndefined();
    await expect.poll(() => hosted.registry.matrixAccounts(sam.tenantId)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transports.created).toHaveLength(0);
    // The consent routes answer as they do with no workspace, and nothing else changes.
    expect((await fetch(`${base}/t/${sam.tenantId}/workspace/invites`, { headers: { authorization: `Bearer ${sam.token}` } })).status).toBe(200);
  });

  it("without the Synapse variables nothing connects", async () => {
    const transports = new Transports();
    const { hosted, base } = await start({ fake: createFakeSynapse(), transports, settings: { synapse: undefined } });
    await joinDuo(base, "Sam");
    expect(hosted.workspace).toBeUndefined();
    expect(transports.created).toHaveLength(0);
  });
});

describe("isolation and failure", () => {
  it("one duo's connection failing, or hanging, does not touch another's; each retries on its own and every line names its duo", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base, logs } = await start({ fake, transports });
    // Sign the duos up while their connections succeed at once, then break one and hang another on the way back in.
    const good = await joinDuo(base, "Good");
    const flaky = await joinDuo(base, "Flaky");
    const hung = await joinDuo(base, "Hung");
    await connected(hosted, good.tenantId);
    await connected(hosted, flaky.tenantId);
    await connected(hosted, hung.tenantId);

    const flakyUser = duoUserOf(hosted, flaky.tenantId);
    const hungUser = duoUserOf(hosted, hung.tenantId);
    const flakyToken = hosted.registry.duoMatrixToken(flaky.tenantId)!;
    let flakyBuilds = 0;
    transports.behaviors.set(flakyUser, (settings) => {
      const transport = transports.make(settings);
      flakyBuilds += 1;
      transport.failNextNConnects(flakyBuilds <= 3 ? 1 : 0);
      return transport;
    });
    transports.behaviors.set(hungUser, () => new Promise<WorkspaceTransport>(() => {}));
    transports.latest(flakyUser).dropConnection();
    transports.latest(hungUser).dropConnection();

    // The healthy duo is untouched and still answers while the others are down.
    const goodUser = duoUserOf(hosted, good.tenantId);
    transports.latest(goodUser).deliver(question(goodUser, "still there?", "$g1"));
    expect((await answersOf(transports.latest(goodUser)))[0]).toContain(PUBLIC_PASSED_ON_MESSAGE);
    expect(hosted.workspace!.states().find((state) => state.duoId === good.tenantId)!.phase).toBe("connected");

    // The flaky duo fails three dials, then connects on its own; the hung one stays connecting and holds nothing up.
    await expect.poll(() => hosted.workspace!.states().find((state) => state.duoId === flaky.tenantId)!.attempts, { timeout: 8_000 }).toBeGreaterThanOrEqual(1);
    await connected(hosted, flaky.tenantId);
    expect(hosted.workspace!.states().find((state) => state.duoId === hung.tenantId)!.phase).toBe("connecting");
    expect((await fetch(`${base}/t/${good.tenantId}/health`)).status).toBe(200);

    const failures = logs.filter((line) => line.includes("workspace connection failed"));
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const line of failures) {
      expect(line).toContain(`duo ${flaky.tenantId}`);
    }
    // Every line the connections wrote names a duo.
    for (const line of logs.filter((candidate) => candidate.includes("workspace"))) {
      expect(line).toMatch(/duo [a-z0-9]+/);
    }
    expect(logs.join("\n")).not.toContain(flakyToken);
  });

  it("a duo whose store cannot be opened fails alone, by name, and the others connect", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base, settings } = await start({ fake, transports });
    const bad = await joinDuo(base, "Bad");
    const fine = await joinDuo(base, "Fine");
    await connected(hosted, bad.tenantId);
    await connected(hosted, fine.tenantId);
    await running.pop()!.close();

    // Corrupt the bad duo's store, then boot again: it cannot be read, the other connects regardless.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tenantPaths(settings.hostedRoot, bad.tenantId).storePath, "not a store");
    const again = new Transports();
    const restarted = await start({ fake, transports: again, settings: { hostedRoot: settings.hostedRoot } });
    await connected(restarted.hosted, fine.tenantId);
    await expect.poll(() => restarted.hosted.workspace!.states().find((state) => state.duoId === bad.tenantId)?.phase, { timeout: 8_000 }).toBe("failed");
    expect(restarted.logs.some((line) => line.includes(`duo ${bad.tenantId}`))).toBe(true);
  });

  it("a Synapse that is down does not block boot, a sign-up, or the duos that need it", async () => {
    const fake = createFakeSynapse();
    const first = new Transports();
    const one = await start({ fake, transports: first });
    const sam = await joinDuo(one.base, "Sam");
    await connected(one.hosted, sam.tenantId);
    await running.pop()!.close();

    // Boot again with Synapse unreachable and its sync never answering: the listener and a sign-up come up on time.
    fake.down = true;
    const second = new Transports();
    second.behaviors.set(duoUserOf(one.hosted, sam.tenantId), () => new Promise<WorkspaceTransport>(() => {}));
    const started = Date.now();
    const two = await start({ fake, transports: second, settings: { hostedRoot: one.settings.hostedRoot }, extras: { signupProvisionWaitMs: 40 } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await fetch(`${two.base}/hosted/health`)).status).toBe(200);
    expect((await fetch(`${two.base}/t/${sam.tenantId}/health`)).status).toBe(200);
    const kim = await joinDuo(two.base, "Kim");
    expect(kim.tenantId).toBeDefined();
    expect(two.hosted.workspace!.states().find((state) => state.duoId === sam.tenantId)!.phase).not.toBe("connected");
  });

  it("a duo's token that Synapse refuses stops that duo, by name, and is retried only when the token changes", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base, logs } = await start({ fake, transports });
    const sam = await joinDuo(base, "Sam");
    await connected(hosted, sam.tenantId);
    const samUser = duoUserOf(hosted, sam.tenantId);

    const { WorkspaceTokenRevokedError } = await import("../src/workspace/transport.js");
    transports.behaviors.set(samUser, (settings) => {
      const transport = transports.make(settings);
      transport.rejectNextConnectWith(new WorkspaceTokenRevokedError("M_UNKNOWN_TOKEN"));
      return transport;
    });
    transports.latest(samUser).dropConnection();
    await expect.poll(() => hosted.workspace!.states().find((state) => state.duoId === sam.tenantId)!.phase, { timeout: 8_000 }).toBe("revoked");
    expect(logs.some((line) => line.includes(`duo ${sam.tenantId}`) && line.includes("re-minted"))).toBe(true);
    const dials = transports.created.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(transports.created).toHaveLength(dials);

    // A fresh token is the fix: the connection comes back with it.
    transports.behaviors.delete(samUser);
    const accounts = hosted.registry.matrixAccounts(sam.tenantId)!;
    hosted.registry.setMatrixAccounts(sam.tenantId, { personUserId: accounts.personUserId, duoUserId: accounts.duoUserId }, "syt_fresh_token");
    await connected(hosted, sam.tenantId);
    expect(transports.latest(samUser).connectCalls).toBe(1);
  });
});

describe("the token never leaves the daemon", () => {
  it("is in no log line, route answer, duo env or registry file, and a duo's own error text is scrubbed of it", async () => {
    const fake = createFakeSynapse();
    const transports = new Transports();
    const { hosted, base, logs, settings } = await start({ fake, transports });
    const sam = await joinDuo(base, "Sam");
    await connected(hosted, sam.tenantId);
    const samUser = duoUserOf(hosted, sam.tenantId);
    const token = hosted.registry.duoMatrixToken(sam.tenantId)!;
    // A transport that throws with the token in its message, as a careless client library might.
    transports.behaviors.set(samUser, (settings_) => {
      throw new Error(`request to ${settings_.homeserverUrl} with Bearer ${settings_.accessToken} failed`);
    });
    transports.latest(samUser).dropConnection();
    await expect.poll(() => logs.filter((line) => line.includes("workspace connection failed")).length, { timeout: 8_000 }).toBeGreaterThanOrEqual(1);
    transports.behaviors.delete(samUser);

    const bodies = logs.slice();
    for (const path of ["/hosted/duos", "/hosted/orgs", "/hosted/invites", "/hosted/health"]) {
      bodies.push(await (await fetch(`${base}${path}`, { headers: admin })).text());
    }
    bodies.push(await (await fetch(`${base}/hosted/matrix/provision`, { method: "POST", headers: admin })).text());
    for (const path of ["/health", "/workspace/invites", "/workspace/rooms", "/drafts"]) {
      bodies.push(await (await fetch(`${base}/t/${sam.tenantId}${path}`, { headers: { authorization: `Bearer ${sam.token}` } })).text());
    }
    const { readFileSync } = await import("node:fs");
    // The registry file holds the token only as ciphertext (checked separately: it is the one place the cipher belongs).
    const registryFile = readFileSync(join(settings.hostedRoot, "registry.json"), "utf8");
    expect(registryFile).not.toContain(token);
    const deps = tenantDeps({ config: loadConfig({}), env: { DUO_WORKSPACE_ADMIN_TOKEN: FAKE_ADMIN_TOKEN, DUO_HOSTED_MASTER_KEY: MASTER }, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false }, settings, hosted.registry.tenants()[0]!, "pw");
    bodies.push(JSON.stringify(deps.env));

    const cipher = hosted.registry.tenants()[0]!.matrix!.duoTokenCipher;
    for (const body of bodies) {
      expect(body).not.toContain(token);
      expect(body).not.toContain(cipher);
      expect(body).not.toContain(FAKE_ADMIN_TOKEN);
    }
    expect(logs.some((line) => line.includes("[redacted]"))).toBe(true);
  });
});

describe("no stampede: a cap and a stagger on first dials", () => {
  /** A duo the manager can attach: real encrypted store (its service reads its read state on start), registered in a real registry with accounts. */
  function seededDuos(count: number): { registry: HostedRegistry; ids: string[]; deps: (id: string) => Parameters<DuoWorkspaceConnections["attach"]>[1] } {
    const registry = new HostedRegistry(join(tempDir(), "registry.json"), MASTER);
    const ids: string[] = [];
    const config = loadConfig({});
    for (let index = 0; index < count; index += 1) {
      const { invite } = registry.createInvite(`Duo ${index}`, new Date(Date.now() + 3_600_000).toISOString());
      const tenant = registry.addTenant(invite.id, `Duo ${index}`, `pw-${index}`);
      createEncryptedStore(join(tempDir(), "duos", tenant.id, "duo.db"), `pw-${index}`);
      ids.push(tenant.id);
    }
    return {
      registry,
      ids,
      deps: (id) => ({
        storePath: join(tempDir(), "duos", id, "duo.db"),
        passphrase: `pw-${ids.indexOf(id)}`,
        duoDir: join(tempDir(), "duos", id, "duo"),
        embeddingProvider: createFakeEmbeddingProvider(),
        inferenceProvider: undefined,
        confidenceConfig: config.confidence,
        classificationCeiling: config.classificationCeiling,
        ownerName: id,
      }),
    };
  }

  it("never has more than the cap in their first dial, and starts them no closer than the stagger", async () => {
    const { registry, ids, deps } = seededDuos(6);
    const started: number[] = [];
    let inFirstDial = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const manager = new DuoWorkspaceConnections({
      registry,
      config: loadConfig({}),
      homeserverUrl: FAKE_SYNAPSE_URL,
      maxConcurrentDials: 2,
      startStaggerMs: 40,
      dialSlotMaxMs: 60_000,
      log: () => {},
      transportFactory: () => {
        started.push(Date.now());
        inFirstDial += 1;
        peak = Math.max(peak, inFirstDial);
        const transport = new FakeWorkspaceTransport();
        // The first dial stays open until the test lets it finish.
        const connect = transport.connect.bind(transport);
        transport.connect = () =>
          new Promise<void>((resolve) => {
            releases.push(() => {
              inFirstDial -= 1;
              void connect().then(resolve);
            });
          });
        return transport;
      },
    });
    managers.push(manager);
    for (const id of ids) {
      manager.attach(id, deps(id));
      registry.setMatrixAccounts(id, { personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` }, `syt_${id}`);
    }
    manager.reconcile();
    await expect.poll(() => started.length, { timeout: 8_000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(started).toHaveLength(2);
    expect(peak).toBe(2);

    // Each dial that finishes lets the next duo begin, until all have.
    while (started.length < 6) {
      await expect.poll(() => releases.length, { timeout: 8_000 }).toBeGreaterThan(0);
      const before = started.length;
      releases.shift()!();
      await expect.poll(() => started.length, { timeout: 8_000 }).toBeGreaterThan(before);
    }
    expect(peak).toBe(2);
    for (let index = 1; index < started.length; index += 1) {
      expect(started[index]! - started[index - 1]!).toBeGreaterThanOrEqual(35);
    }
  });

  it("a first dial that hangs gives its slot back after the hold time, so it cannot stall the rest", async () => {
    const { registry, ids, deps } = seededDuos(3);
    const started: string[] = [];
    const manager = new DuoWorkspaceConnections({
      registry,
      config: loadConfig({}),
      homeserverUrl: FAKE_SYNAPSE_URL,
      maxConcurrentDials: 1,
      startStaggerMs: 0,
      dialSlotMaxMs: 60,
      log: () => {},
      transportFactory: (settings) => {
        started.push(settings.userId);
        const transport = new FakeWorkspaceTransport();
        transport.connect = () => new Promise<void>(() => {});
        return transport;
      },
    });
    managers.push(manager);
    for (const id of ids) {
      registry.setMatrixAccounts(id, { personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` }, `syt_${id}`);
      manager.attach(id, deps(id));
    }
    await expect.poll(() => started.length, { timeout: 8_000 }).toBe(3);
  });

  it("refuses a bad cap or stagger, and a bad timing knob, at construction", () => {
    const registry = new HostedRegistry(join(tempDir(), "registry.json"), MASTER);
    const base = { registry, config: loadConfig({}), homeserverUrl: FAKE_SYNAPSE_URL, log: () => {} };
    expect(() => new DuoWorkspaceConnections({ ...base, maxConcurrentDials: 0 })).toThrow(/at least 1/);
    expect(() => new DuoWorkspaceConnections({ ...base, startStaggerMs: -1 })).toThrow(/0 or more/);
    expect(() => new DuoWorkspaceConnections({ ...base, config: loadConfig({ DUO_WORKSPACE_RECONNECT_INITIAL_MS: "0" }) })).toThrow(WorkspaceConfigError);
    expect(() => new DuoWorkspaceConnections({ ...base, homeserverUrl: "http://plain.example.com" })).toThrow(WorkspaceConfigError);
  });

  it("reads the cap and stagger from the environment, and refuses nonsense", () => {
    const base = { DUO_HOSTED_MASTER_KEY: MASTER, DUO_HOSTED_ADMIN_TOKEN: ADMIN };
    expect(hostedSettingsFrom({ ...base, DUO_HOSTED_WORKSPACE_MAX_DIALS: "3", DUO_HOSTED_WORKSPACE_STAGGER_MS: "250" }).workspaceConnections).toEqual({ enabled: true, maxConcurrentDials: 3, startStaggerMs: 250, sdkLogLevel: undefined });
    expect(hostedSettingsFrom({ ...base, DUO_HOSTED_WORKSPACE_CONNECT: "0" }).workspaceConnections?.enabled).toBe(false);
    expect(hostedSettingsFrom(base).workspaceConnections).toEqual({ enabled: true, maxConcurrentDials: undefined, startStaggerMs: undefined, sdkLogLevel: undefined });
    expect(hostedSettingsFrom({ ...base, DUO_HOSTED_WORKSPACE_SDK_LOG: "warn" }).workspaceConnections?.sdkLogLevel).toBe("warn");
    expect(() => hostedSettingsFrom({ ...base, DUO_HOSTED_WORKSPACE_SDK_LOG: "loud" })).toThrow(WorkspaceConfigError);
    expect(() => hostedSettingsFrom({ ...base, DUO_HOSTED_WORKSPACE_MAX_DIALS: "0" })).toThrow(WorkspaceConfigError);
    expect(() => hostedSettingsFrom({ ...base, DUO_HOSTED_WORKSPACE_STAGGER_MS: "soon" })).toThrow(WorkspaceConfigError);
  });

  it("detaching a duo stops its connection and only its", async () => {
    const { registry, ids, deps } = seededDuos(2);
    const transports = new Transports();
    const manager = new DuoWorkspaceConnections({ registry, config: loadConfig({}), homeserverUrl: FAKE_SYNAPSE_URL, startStaggerMs: 0, log: () => {}, transportFactory: transports.factory });
    managers.push(manager);
    for (const id of ids) {
      registry.setMatrixAccounts(id, { personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` }, `syt_${id}`);
      manager.attach(id, deps(id));
    }
    await expect.poll(() => manager.states().filter((state) => state.phase === "connected").length, { timeout: 8_000 }).toBe(2);
    await manager.detach(ids[0]!);
    expect(transports.latest(`@duo-default.${ids[0]!}:duo.test`).stopCalls).toBe(1);
    expect(transports.latest(`@duo-default.${ids[1]!}:duo.test`).stopCalls).toBe(0);
    expect(manager.serviceFor(ids[0]!)).toBeUndefined();
    expect(manager.serviceFor(ids[1]!)).toBeDefined();
  });
});
