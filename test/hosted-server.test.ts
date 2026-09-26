import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { createHostedServer, HostedConfigError, hostedSettingsFrom, type HostedServer, type HostedSettings } from "../src/hosted/server.js";
import type { ServeDeps } from "../src/serve/server.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

const tempDir = useTempDir();
const ADMIN = "admin-token-for-tests";
const running: HostedServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function settings(): HostedSettings {
  return {
    hostedRoot: join(tempDir(), "hosted"),
    masterKey: "master-key-for-tests",
    adminToken: ADMIN,
    publicUrl: "https://daemon.example",
    webUrl: "https://web.example",
  };
}

async function start(root?: ServeDeps): Promise<{ hosted: HostedServer; base: string }> {
  const config = loadConfig({});
  const hosted = await createHostedServer(
    { config, env: { DUO_CORS_ORIGINS: "https://web.example" }, embeddingProvider: createFakeEmbeddingProvider(), inferenceProvider: undefined, trustProxy: false },
    settings(),
    root,
  );
  running.push(hosted);
  await new Promise<void>((resolve) => hosted.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = hosted.server.address() as AddressInfo;
  return { hosted, base: `http://127.0.0.1:${port}` };
}

async function invite(base: string, name = "Sam"): Promise<{ code: string; link: string | null }> {
  const response = await fetch(`${base}/hosted/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { code: string; link: string | null };
}

async function signup(base: string, code: string, name: string): Promise<Response> {
  return fetch(`${base}/hosted/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://web.example" },
    body: JSON.stringify({ invite: code, name }),
  });
}

describe("hosted mode — many duos, one process, invite-only", () => {
  it("refuses to start without a master key and an admin token", () => {
    expect(() => hostedSettingsFrom({})).toThrow(HostedConfigError);
    expect(() => hostedSettingsFrom({ DUO_HOSTED_MASTER_KEY: "x".repeat(20) })).toThrow(/DUO_HOSTED_ADMIN_TOKEN/);
  });

  it("only the admin can mint invites, and the link carries the daemon origin and code", async () => {
    const { base } = await start();
    const denied = await fetch(`${base}/hosted/invites`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
    const { code, link } = await invite(base);
    expect(link).toBe(`https://web.example/#join?host=${encodeURIComponent("https://daemon.example")}&invite=${code}`);
  });

  it("an invite creates one isolated duo, once; CORS lets the web app call sign-up", async () => {
    const { base } = await start();
    const { code } = await invite(base);
    const response = await signup(base, code, "Sam");
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://web.example");
    const body = (await response.json()) as { tenantId: string; basePath: string; token: string; ownerName: string };
    expect(body.basePath).toBe(`/t/${body.tenantId}`);
    expect(body.ownerName).toBe("Sam");

    const drafts = await fetch(`${base}${body.basePath}/drafts`, { headers: { authorization: `Bearer ${body.token}` } });
    expect(drafts.status).toBe(200);

    const reused = await signup(base, code, "Eve");
    expect(reused.status).toBe(403);
    expect(((await reused.json()) as { error: { code: string } }).error.code).toBe("invite_invalid");
  });

  it("one duo's token never opens another duo, or the root duo", async () => {
    const storePath = join(tempDir(), "root", "data", "duo.db");
    createEncryptedStore(storePath, "rootpw");
    const rootDevice = createDeviceToken(storePath, "rootpw", "laptop");
    const config = loadConfig({});
    const { base } = await start({
      storePath,
      passphrase: "rootpw",
      duoDir: join(tempDir(), "root", "duo"),
      lifecycleLogPath: join(tempDir(), "root", "lifecycle.json"),
      embeddingProvider: createFakeEmbeddingProvider(),
      inferenceProvider: undefined,
      confidenceConfig: config.confidence,
      classificationCeiling: config.classificationCeiling,
      ownerName: "Root",
      env: {},
    });
    const sam = (await (await signup(base, (await invite(base, "Sam")).code, "Sam")).json()) as { basePath: string; token: string };
    const kim = (await (await signup(base, (await invite(base, "Kim")).code, "Kim")).json()) as { basePath: string; token: string };

    const status = async (path: string, token: string) =>
      (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })).status;
    expect(await status(`${sam.basePath}/drafts`, sam.token)).toBe(200);
    expect(await status(`${sam.basePath}/drafts`, kim.token)).toBe(401);
    expect(await status(`${kim.basePath}/drafts`, sam.token)).toBe(401);
    expect(await status("/drafts", sam.token)).toBe(401);
    expect(await status(`${sam.basePath}/drafts`, rootDevice.token)).toBe(401);
    expect(await status("/drafts", rootDevice.token)).toBe(200);
  });

  it("an unknown duo id is a 404, and with no root duo so is the bare origin", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/t/nosuchduo/health`)).status).toBe(404);
    expect((await fetch(`${base}/drafts`)).status).toBe(404);
  });

  it("a duo's WebSocket works under its prefix", async () => {
    const { base } = await start();
    const sam = (await (await signup(base, (await invite(base)).code, "Sam")).json()) as { basePath: string; token: string };
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}${sam.basePath}/ws`);
      socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: sam.token })));
      socket.on("message", (data) => {
        socket.close();
        resolve(String(data));
      });
      socket.on("error", reject);
    });
    expect(JSON.parse(message)).toEqual({ type: "ready" });
  });

  it("duos survive a restart, and the registry holds no plaintext secret", async () => {
    const first = await start();
    const sam = (await (await signup(first.base, (await invite(first.base)).code, "Sam")).json()) as { basePath: string; token: string };
    await running.pop()!.close();

    const second = await start();
    const drafts = await fetch(`${second.base}${sam.basePath}/drafts`, { headers: { authorization: `Bearer ${sam.token}` } });
    expect(drafts.status).toBe(200);
    const registry = readFileSync(join(settings().hostedRoot, "registry.json"), "utf8");
    expect(registry).not.toContain(sam.token);
    expect(registry).toContain("passphraseCipher");
  });
});
