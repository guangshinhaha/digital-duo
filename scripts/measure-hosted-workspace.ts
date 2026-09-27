/**
 * Resource check for #236: N hosted duos, each with its own real matrix-js-sdk client syncing against one
 * small fake homeserver, in ONE process. Not part of the test suite (it takes a while and its numbers
 * depend on the machine); the method and the numbers are recorded in docs/deploy/hosted-workspace.md §8.
 *
 *   npx tsx scripts/measure-hosted-workspace.ts <duos> [idleSeconds]
 *   MEASURE_RECORDS=<n> ...   seed each duo's store with n records first (default 0: an empty store)
 *
 * With no records the store is empty and the cost of opening it is the fixed key derivation (scrypt) alone;
 * a real duo's store also has to be decrypted, read and re-encrypted in proportion to its size on every
 * open, so seed a corpus the size of your largest duo before reading anything off the connect numbers.
 * The output reports how long one open of each store takes (`storeOpenMs`), apart from client construction.
 *
 * Run it once per N, each in a fresh process, so one run's heap does not leak into the next.
 *
 * What is real: the daemon's own DuoWorkspaceConnections (registry, per-duo encrypted store and read state,
 * the dial cap and stagger), the real matrix-transport adapter, and the real matrix-js-sdk client with its
 * own sync loop, request timeouts and in-memory store. What is fake: the homeserver, which answers the
 * handful of client-server calls a syncing client makes, holds each /sync open for the client's requested
 * timeout as Synapse does, and has one empty room per duo. It is far lighter than Synapse, so it
 * measures the DAEMON's side of N sync loops, and says nothing about Synapse's own load.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DuoWorkspaceConnections } from "../src/hosted/duo-workspace.js";
import { HostedRegistry } from "../src/hosted/registry.js";
import type { EmbeddingProvider } from "../src/provider/types.js";
import { sdkLoggerFor } from "../src/hosted/duo-workspace.js";
import { createRecord } from "../src/ingest/record.js";
import { writeRecords } from "../src/ingest/record-store.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const duoCount = Number(process.argv[2] ?? "5");
const idleSeconds = Number(process.argv[3] ?? "30");
const recordsPerDuo = Number(process.env.MEASURE_RECORDS ?? "0");
const embeddingProvider: EmbeddingProvider = { name: "fake", model: "fake", async embed() { return [0]; } };

interface Stats {
  requests: number;
  syncs: number;
  openSyncs: number;
  peakOpenSyncs: number;
  unknown: Set<string>;
}
const stats: Stats = { requests: 0, syncs: 0, openSyncs: 0, peakOpenSyncs: 0, unknown: new Set() };

/** A homeserver that speaks just enough of the client-server API for a syncing client. */
function fakeHomeserver(): Promise<{ url: string; close: () => Promise<void> }> {
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    stats.requests += 1;
    const url = new URL(request.url ?? "/", "http://fake");
    const send = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    request.resume();
    if (url.pathname.endsWith("/versions")) {
      return send({ versions: ["v1.1", "v1.5", "v1.9"], unstable_features: {} });
    }
    if (url.pathname.endsWith("/sync")) {
      stats.syncs += 1;
      const timeout = Number(url.searchParams.get("timeout") ?? "0");
      const since = url.searchParams.get("since");
      const body = { next_batch: `s${stats.syncs}`, rooms: { join: {}, invite: {}, leave: {} }, presence: { events: [] }, account_data: { events: [] }, to_device: { events: [] }, device_lists: { changed: [] } };
      if (!since || timeout === 0) {
        return send(body);
      }
      stats.openSyncs += 1;
      stats.peakOpenSyncs = Math.max(stats.peakOpenSyncs, stats.openSyncs);
      const timer = setTimeout(() => {
        timers.delete(timer);
        stats.openSyncs -= 1;
        send(body);
      }, timeout);
      timers.add(timer);
      response.on("close", () => {
        if (timers.delete(timer)) {
          clearTimeout(timer);
          stats.openSyncs -= 1;
        }
      });
      return;
    }
    if (url.pathname.includes("/filter")) {
      return send({ filter_id: "f1" });
    }
    if (url.pathname.includes("/presence/")) {
      return send({});
    }
    if (url.pathname.includes("/pushrules")) {
      return send({ global: {} });
    }
    if (url.pathname.endsWith("/capabilities")) {
      return send({ capabilities: {} });
    }
    stats.unknown.add(`${request.method} ${url.pathname}`);
    send({});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const timer of timers) {
              clearTimeout(timer);
            }
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function handles(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function snapshot() {
  const usage = process.memoryUsage();
  return { rssMb: mb(usage.rss), heapUsedMb: mb(usage.heapUsed), externalMb: mb(usage.external) };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "duo-measure-"));
  const homeserver = await fakeHomeserver();
  const registry = new HostedRegistry(join(dir, "registry.json"), "measurement-master-key");
  const config = loadConfig({});
  const log: string[] = [];

  const setupStarted = Date.now();
  const ids: string[] = [];
  for (let index = 0; index < duoCount; index += 1) {
    const { invite } = registry.createInvite(`Duo ${index}`, new Date(Date.now() + 3_600_000).toISOString());
    const tenant = registry.addTenant(invite.id, `Duo ${index}`, `pw-${index}`);
    mkdirSync(join(dir, tenant.id), { recursive: true });
    createEncryptedStore(join(dir, tenant.id, "duo.db"), `pw-${index}`);
    if (recordsPerDuo > 0) {
      // Messages of a realistic length, in question/answer pairs, so the store has the size of a used one.
      const records = Array.from({ length: recordsPerDuo }, (_, n) =>
        createRecord({
          source: "measure",
          sourceRef: null,
          kind: n % 2 === 0 ? "question_to_me" : "my_answer",
          author: n % 2 === 0 ? "other" : "me",
          text: `Record ${n} of duo ${index}: ${"the quick brown fox jumps over the lazy dog ".repeat(8)}`,
          timestamp: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
          threadId: `t-${Math.floor(n / 2)}`,
          audience: "channel",
        }),
      );
      writeRecords(join(dir, tenant.id, "duo.db"), `pw-${index}`, records);
    }
    ids.push(tenant.id);
  }
  const setupMs = Date.now() - setupStarted;
  // One open of each store, on its own: what the daemon pays per duo on every read-state check or answer, apart from building a client.
  const openMs = ids
    .map((id, index) => {
      const opened = Date.now();
      withDatabase(join(dir, id, "duo.db"), `pw-${index}`, false, () => {});
      return Date.now() - opened;
    })
    .sort((a, b) => a - b);

  // Baseline: everything imported and the homeserver up, no connections. The SDK is loaded now so its module cost is in the baseline, not the per-duo number.
  const { createMatrixTransport } = await import("../src/workspace/matrix-transport.js");
  // What the daemon's default factory passes: the production SDK logger at its default (silent) level.
  const silent = sdkLoggerFor("silent", () => {});
  global.gc?.();
  const baseline = snapshot();
  const baselineHandles = handles();

  const manager = new DuoWorkspaceConnections({
    registry,
    config,
    // The daemon only accepts https or a *.railway.internal host, so it is configured with the private-network name, and the factory (the one thing swapped) dials the loopback fake instead.
    homeserverUrl: "http://synapse.railway.internal:8008",
    transportFactory: (settings) => createMatrixTransport({ ...settings, homeserverUrl: homeserver.url }, { sdkLogger: silent }),
    maxConcurrentDials: Number(process.env.MEASURE_MAX_DIALS ?? "5"),
    startStaggerMs: Number(process.env.MEASURE_STAGGER_MS ?? "500"),
    log: (line) => log.push(line),
  });
  const started = Date.now();
  for (const [index, id] of ids.entries()) {
    registry.setMatrixAccounts(id, { personUserId: `@default.${id}:duo.test`, duoUserId: `@duo-default.${id}:duo.test` }, `syt_measure_${index}`);
    manager.attach(id, {
      storePath: join(dir, id, "duo.db"),
      passphrase: `pw-${index}`,
      duoDir: join(dir, id, "duo"),
      embeddingProvider,
      inferenceProvider: undefined,
      confidenceConfig: config.confidence,
      classificationCeiling: config.classificationCeiling,
      ownerName: `Duo ${index}`,
    });
  }
  const cpuAtStart = process.cpuUsage();
  const lagSamples: number[] = [];
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagSamples.push(Math.max(0, now - lastTick - 100));
    lastTick = now;
  }, 100);

  const deadline = Date.now() + 120_000;
  while (manager.states().some((state) => state.phase !== "connected") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const connectMs = Date.now() - started;
  const connectLagMaxMs = Math.max(0, ...lagSamples);
  const connected = manager.states().filter((state) => state.phase === "connected").length;
  const cpuConnect = process.cpuUsage(cpuAtStart);

  // Steady state: connected, long polls open, presence timers armed.
  global.gc?.();
  const idleStart = process.cpuUsage();
  const idleWallStart = Date.now();
  lagSamples.length = 0;
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
  const idleCpu = process.cpuUsage(idleStart);
  const idleWall = Date.now() - idleWallStart;
  global.gc?.();
  const steady = snapshot();
  const steadyHandles = handles();
  clearInterval(lagTimer);

  const result = {
    duos: duoCount,
    recordsPerDuo,
    connected,
    setupMs,
    storeOpenMs: { median: openMs[Math.floor(openMs.length / 2)] ?? 0, max: openMs[openMs.length - 1] ?? 0 },
    connectAllMs: connectMs,
    baseline,
    steady,
    // Compare `steady` with the run at 0 duos, not with `baseline`: the baseline still carries the garbage from creating the stores.
    connectCpuSeconds: Math.round(((cpuConnect.user + cpuConnect.system) / 1e6) * 100) / 100,
    idleCpuPercentOfOneCore: Math.round(((idleCpu.user + idleCpu.system) / 1000 / idleWall) * 1000) / 10,
    // How long the event loop was held past its 100 ms tick: while the duos connect (each one decrypts its store once, synchronously), and then while idle.
    eventLoopLagMaxMs: { whileConnecting: connectLagMaxMs, whileIdle: Math.max(0, ...lagSamples) },
    baselineHandles,
    steadyHandles,
    homeserver: { requests: stats.requests, peakOpenSyncs: stats.peakOpenSyncs, unknownCalls: [...stats.unknown] },
    logLines: log.length,
    sampleLog: log.slice(0, 3),
  };
  console.log(JSON.stringify(result, null, 2));

  const stopStarted = Date.now();
  await manager.stop();
  const stopMs = Date.now() - stopStarted;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await homeserver.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(JSON.stringify({ stopAllMs: stopMs, handlesAfterStopAndHomeserverClosed: handles() }));
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

void main();
