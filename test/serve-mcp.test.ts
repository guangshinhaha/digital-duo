import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { listRecords } from "../src/ingest/record-store.js";
import type { EmbeddingProvider } from "../src/provider/types.js";
import { CONNECTOR_SOURCE } from "../src/serve/mcp.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createConnectorToken, createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore, withDatabase } from "../src/store/store.js";

const tempDir = useTempDir();
const PASSPHRASE = "pw";
const running: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

async function startDuo(name: string, embeddingProvider: EmbeddingProvider = createFakeEmbeddingProvider()) {
  const storePath = join(tempDir(), name, "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  const config = loadConfig({});
  const deps: ServeDeps = {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), name, "duo"),
    lifecycleLogPath: join(tempDir(), name, "lifecycle-runtime", "events.json"),
    embeddingProvider,
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: "Owner",
    env: {},
  };
  const app = createServer(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  running.push(app);
  const address = app.server.address();
  const base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  return { app, base, storePath };
}

/** Calls save_to_duo the way claude.ai does: an MCP client over Streamable HTTP against the connector URL. */
async function saveThroughConnector(url: string, text: string): Promise<string> {
  const client = new Client({ name: "test-claude", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const result = await client.callTool({ name: "save_to_duo", arguments: { text } });
    return (result.content as { type: string; text: string }[])[0].text;
  } finally {
    await client.close();
  }
}

/** Calls save_notes_to_duo the same way: one MCP call carrying several notes. */
async function saveNotesThroughConnector(url: string, notes: string[]): Promise<string> {
  const client = new Client({ name: "test-claude", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const result = await client.callTool({ name: "save_notes_to_duo", arguments: { notes } });
    return (result.content as { type: string; text: string }[])[0].text;
  } finally {
    await client.close();
  }
}

function connectorRecords(storePath: string) {
  return listRecords(storePath, PASSPHRASE).filter((record) => record.source === CONNECTOR_SOURCE);
}

function embeddedIds(storePath: string): string[] {
  return withDatabase(storePath, PASSPHRASE, false, (db) =>
    (db.prepare(`SELECT record_id FROM record_embeddings`).all() as { record_id: string }[]).map((row) => row.record_id),
  );
}

describe("MCP connector (#227)", () => {
  it("saves text from a Claude chat into the duo, embedded", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    const reply = await saveThroughConnector(`${base}/mcp/${token}`, "The budget deadline moved to Friday.");

    expect(reply).toMatch(/^Saved to your duo/);
    const saved = connectorRecords(storePath);
    expect(saved.map((record) => record.text)).toEqual(["The budget deadline moved to Friday."]);
    expect(saved[0]).toMatchObject({ author: "me", audience: "private" });
    expect(embeddedIds(storePath)).toContain(saved[0].id);
  });

  it("refuses a wrong connector URL and writes nothing", async () => {
    const { base, storePath } = await startDuo("owner");
    createConnectorToken(storePath, PASSPHRASE);

    await expect(saveThroughConnector(`${base}/mcp/not-the-secret`, "anything")).rejects.toThrow();
    expect(connectorRecords(storePath)).toEqual([]);
  });

  it("does not accept a device token in place of the connector secret", async () => {
    const { base, storePath } = await startDuo("owner");
    const device = createDeviceToken(storePath, PASSPHRASE, "laptop");

    await expect(saveThroughConnector(`${base}/mcp/${device.token}`, "anything")).rejects.toThrow();
    expect(connectorRecords(storePath)).toEqual([]);
  });

  it("writes only to the duo whose secret it carries", async () => {
    const a = await startDuo("a");
    const b = await startDuo("b");
    const { token } = createConnectorToken(a.storePath, PASSPHRASE);

    await saveThroughConnector(`${a.base}/mcp/${token}`, "Saved to A only.");
    await expect(saveThroughConnector(`${b.base}/mcp/${token}`, "Aimed at B.")).rejects.toThrow();

    expect(connectorRecords(a.storePath)).toHaveLength(1);
    expect(connectorRecords(b.storePath)).toEqual([]);
  });

  it("stops accepting the old URL once a new one is minted", async () => {
    const { base, storePath } = await startDuo("owner");
    const old = createConnectorToken(storePath, PASSPHRASE);
    const replacement = createConnectorToken(storePath, PASSPHRASE);

    await expect(saveThroughConnector(`${base}/mcp/${old.token}`, "via the leaked URL")).rejects.toThrow();
    await saveThroughConnector(`${base}/mcp/${replacement.token}`, "via the new URL");

    expect(connectorRecords(storePath).map((record) => record.text)).toEqual(["via the new URL"]);
  });

  it("reports an earlier save of the same text instead of adding a copy", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    await saveThroughConnector(`${base}/mcp/${token}`, "Same note.");
    const reply = await saveThroughConnector(`${base}/mcp/${token}`, "Same note.");

    expect(reply).toMatch(/^Already in your duo/);
    expect(connectorRecords(storePath)).toHaveLength(1);
  });

  it("refuses text above the classification ceiling and stores nothing", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    const reply = await saveThroughConnector(`${base}/mcp/${token}`, "SECRET: the launch codes");

    expect(reply).toMatch(/^Not saved/);
    expect(connectorRecords(storePath)).toEqual([]);
  });

  it("keeps the save when embedding fails, and says it is not searchable by meaning yet", async () => {
    const down: EmbeddingProvider = {
      name: "down",
      model: "down",
      async embed() {
        throw new Error("Ollama unreachable");
      },
    };
    const { base, storePath } = await startDuo("owner", down);
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    const reply = await saveThroughConnector(`${base}/mcp/${token}`, "Kept even when embedding is down.");

    expect(reply).toMatch(/not searchable by meaning yet/);
    expect(connectorRecords(storePath)).toHaveLength(1);
  });

  it("saves several notes in one call, all embedded, and reports the counts", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    const reply = await saveNotesThroughConnector(`${base}/mcp/${token}`, ["The budget deadline moved.", "The printer on the floor is broken.", "Leave approvals go to Sam."]);

    expect(reply).toBe("Done: 3 saved, 0 already in your duo, 0 refused as above your classification ceiling.");
    const saved = connectorRecords(storePath);
    expect(saved).toHaveLength(3);
    for (const record of saved) {
      expect(embeddedIds(storePath)).toContain(record.id);
    }
  });

  it("sorts a mixed batch: new notes saved, repeats and above-ceiling notes reported, none double-counted", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);
    await saveThroughConnector(`${base}/mcp/${token}`, "Saved before.");

    const reply = await saveNotesThroughConnector(`${base}/mcp/${token}`, [
      "Saved before.",
      "A brand new note.",
      "A brand new note.",
      "SECRET: launch codes",
    ]);

    expect(reply).toBe("Done: 1 saved, 2 already in your duo, 1 refused as above your classification ceiling.");
    expect(connectorRecords(storePath).map((record) => record.text).sort()).toEqual(["A brand new note.", "Saved before."]);
  });

  it("refuses more notes than one call allows and writes nothing", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    const tooMany = Array.from({ length: 51 }, (_, index) => `note ${index}`);
    const reply = await saveNotesThroughConnector(`${base}/mcp/${token}`, tooMany);
    expect(reply).toMatch(/expected array to have <=50 items/);
    expect(connectorRecords(storePath)).toEqual([]);
  });

  it("keeps a saved batch when embedding fails, and says so", async () => {
    const down: EmbeddingProvider = {
      name: "down",
      model: "down",
      async embed() {
        throw new Error("Ollama unreachable");
      },
    };
    const { base, storePath } = await startDuo("owner", down);
    const { token } = createConnectorToken(storePath, PASSPHRASE);

    const reply = await saveNotesThroughConnector(`${base}/mcp/${token}`, ["One.", "Two."]);

    expect(reply).toMatch(/^Done: 2 saved/);
    expect(reply).toMatch(/not searchable by meaning yet/);
    expect(connectorRecords(storePath)).toHaveLength(2);
  });

  it("refuses a batch sent to a wrong connector URL and writes nothing", async () => {
    const { base, storePath } = await startDuo("owner");
    createConnectorToken(storePath, PASSPHRASE);

    await expect(saveNotesThroughConnector(`${base}/mcp/not-the-secret`, ["anything"])).rejects.toThrow();
    expect(connectorRecords(storePath)).toEqual([]);
  });

  it("stays save-only over a secret URL: the duo's other tools are refused, and nothing is read", async () => {
    const { base, storePath } = await startDuo("owner");
    const { token } = createConnectorToken(storePath, PASSPHRASE);
    await saveThroughConnector(`${base}/mcp/${token}`, "A note the secret URL can add but not read back.");

    const client = new Client({ name: "test-claude", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
    try {
      const search = await client.callTool({ name: "search_my_duo", arguments: { query: "note" } });
      expect(search.isError).toBe(true);
      expect((search.content as { text: string }[])[0].text).toMatch(/Read \(duo:read\) permission/);
      const embed = await client.callTool({ name: "embed_my_duo", arguments: {} });
      expect(embed.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("mints the connector from the app: POST /connector returns the path once, GET reports it live", async () => {
    const { app, storePath } = await startDuo("owner");
    const device = createDeviceToken(storePath, PASSPHRASE, "laptop");
    const auth = { authorization: `Bearer ${device.token}` };

    const before = (await app.inject({ method: "GET", url: "/connector", headers: auth })).json();
    expect(before.connector).toBeNull();
    expect(before.historyPrompt).toContain("save_notes_to_duo");
    expect(before.historyPrompt).toContain('above "official open"');
    const minted = await app.inject({ method: "POST", url: "/connector", headers: auth });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().path).toMatch(/^\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect((await app.inject({ method: "GET", url: "/connector", headers: auth })).json().connector.id).toBe(minted.json().id);
    expect((await app.inject({ method: "POST", url: "/connector" })).statusCode).toBe(401);
  });
});
