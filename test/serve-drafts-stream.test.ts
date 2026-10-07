import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createFakeEmbeddingProvider } from "./fixtures/fake-embedding-provider.js";
import { useTempDir } from "./helpers/temp-dir.js";
import { loadConfig } from "../src/config.js";
import { listDrafts } from "../src/drafting/draft-log.js";
import { createPinnedAnswer } from "../src/trust/pinned-answers.js";
import { createServer, type ServeDeps } from "../src/serve/server.js";
import { createDeviceToken } from "../src/serve/tokens.js";
import { createEncryptedStore } from "../src/store/store.js";

/*
 * duo#304: "your duo's answers appear as they're written" — POST
 * /drafts/stream carries the exact same contract as POST /drafts (body,
 * validation, side effects) but delivers the result as Server-Sent Events
 * instead of one blocking JSON response, so the self-chat composer can
 * render the answer incrementally. These tests read the full SSE body
 * through `app.inject()` (light-my-request buffers a hijacked response's
 * writes the same way it buffers a normal one) rather than trying to
 * observe chunks arriving in real time — that is exercised by the client's
 * own streaming-consumer tests instead.
 */

const tempDir = useTempDir();
const PASSPHRASE = "pw";

function initStore(): string {
  const storePath = join(tempDir(), "data", "duo.db");
  createEncryptedStore(storePath, PASSPHRASE);
  return storePath;
}

function deps(storePath: string, overrides: Partial<ServeDeps> = {}): ServeDeps {
  const config = loadConfig();
  return {
    storePath,
    passphrase: PASSPHRASE,
    duoDir: join(tempDir(), "duo"),
    lifecycleLogPath: join(tempDir(), "lifecycle-runtime", "events.json"),
    embeddingProvider: createFakeEmbeddingProvider(),
    inferenceProvider: undefined,
    confidenceConfig: config.confidence,
    classificationCeiling: config.classificationCeiling,
    ownerName: config.ownerName,
    env: {},
    ...overrides,
  };
}

/** Parses a full SSE body into its `{ event, data }` frames, in order. */
function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) {
        throw new Error(`malformed SSE frame: ${JSON.stringify(frame)}`);
      }
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
    });
}

describe("POST /drafts/stream (duo#304)", () => {
  let app: FastifyInstance;
  let storePath: string;
  let authHeader: { authorization: string };

  beforeEach(() => {
    storePath = initStore();
    app = createServer(deps(storePath));
    const paired = createDeviceToken(storePath, PASSPHRASE, "test-device");
    authHeader = { authorization: `Bearer ${paired.token}` };
  });

  it("requires a token, exactly like POST /drafts", async () => {
    const response = await app.inject({ method: "POST", url: "/drafts/stream", payload: { question: "q" } });
    expect(response.statusCode).toBe(401);
  });

  it("requires a question, with a plain 400 JSON body (headers never hijacked for a bad request)", async () => {
    const response = await app.inject({ method: "POST", url: "/drafts/stream", headers: authHeader, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().error.code).toBe("bad_request");
  });

  it("rejects a malformed recipient with 400, before anything streams", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/drafts/stream",
      headers: authHeader,
      payload: { question: "q", recipient: "not-an-object" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("streams an escalation as a single done event — nothing to reveal word by word", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/drafts/stream",
      headers: authHeader,
      payload: { question: "what is the meaning of life" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    const frames = parseSse(response.payload);
    expect(frames.map((frame) => frame.event)).toEqual(["done"]);
    const done = frames[0]!.data as { kind: string; draftId: string };
    expect(done.kind).toBe("escalation");

    // Same side effect as POST /drafts: exactly one draft-log row written.
    expect(listDrafts(storePath, PASSPHRASE, {})).toHaveLength(1);
  });

  it("streams a draft's text word by word, and the chunks concatenate back to the exact original text", async () => {
    createPinnedAnswer(storePath, PASSPHRASE, "parking", "Visitor parking is on level 2, past the barrier.");
    const response = await app.inject({
      method: "POST",
      url: "/drafts/stream",
      headers: authHeader,
      payload: { question: "where do I park for a visitor, re: parking" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.payload);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1]!.event).toBe("done");
    const chunkFrames = frames.slice(0, -1);
    for (const frame of chunkFrames) {
      expect(frame.event).toBe("chunk");
    }
    const reconstructed = chunkFrames.map((frame) => (frame.data as { text: string }).text).join("");
    expect(reconstructed).toBe("Visitor parking is on level 2, past the barrier.");

    const done = frames[frames.length - 1]!.data as { kind: string; text: string; draftId: string };
    expect(done.kind).toBe("draft");
    expect(done.text).toBe("Visitor parking is on level 2, past the barrier.");

    // Parity with POST /drafts: the done event IS the DraftPipelineResult,
    // and it is backed by exactly one draft-log row (same as /drafts).
    const stored = listDrafts(storePath, PASSPHRASE, {});
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(done.draftId);
    expect(stored[0]!.draftText).toBe("Visitor parking is on level 2, past the barrier.");
  });

  it("matches POST /drafts' own result for the same question (same pipeline, only the transport differs)", async () => {
    createPinnedAnswer(storePath, PASSPHRASE, "parking", "Visitor parking is on level 2.");
    const streamed = await app.inject({
      method: "POST",
      url: "/drafts/stream",
      headers: authHeader,
      payload: { question: "re: parking, where do visitors go" },
    });
    const frames = parseSse(streamed.payload);
    const streamedDone = frames[frames.length - 1]!.data as Record<string, unknown>;

    const blocking = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: authHeader,
      payload: { question: "re: parking, where do visitors go, again" },
    });
    const blockingBody = blocking.json() as Record<string, unknown>;

    // Not the same draftId (two different draft-log rows), but every other
    // field — text, sources, confidence shape, alternatives — matches,
    // because both routes call the identical draftReply pipeline.
    expect(streamedDone.kind).toBe(blockingBody.kind);
    expect(streamedDone.text).toBe(blockingBody.text);
    expect(streamedDone.sources).toEqual(blockingBody.sources);
    expect(streamedDone.alternatives).toEqual(blockingBody.alternatives);
  });
});
