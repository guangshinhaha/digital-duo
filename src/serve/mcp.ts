import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { embedRecords } from "../ingest/embeddings.js";
import { createRecord } from "../ingest/record.js";
import { ensureRecordsSchema } from "../ingest/record-store.js";
import { ingestRecords } from "../ingest/two-phase.js";
import { parseClassificationCeiling } from "../permissions/classification.js";
import { withDatabase } from "../store/store.js";
import type { ServeDeps } from "./server.js";
import { verifyConnectorToken } from "./tokens.js";

/** The record source every connector save carries — how the duplicate check below finds an earlier save of the same text. */
export const CONNECTOR_SOURCE = "connector";
/** How many pending records one save embeds inline before answering; the rest wait for the next embed run. */
const INLINE_EMBED_LIMIT = 20;

export type SaveOutcome =
  | { readonly status: "saved"; readonly embedded: boolean; readonly embedError?: string }
  | { readonly status: "already_saved" }
  | { readonly status: "above_ceiling" };

function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Issue #227: one "save this to my duo" from a Claude chat. The text becomes
 * a single record through the same two-phase ingest an import uses, so the
 * classification ceiling applies exactly as it does there. It skips the
 * work-relevance filter an import applies: the owner chose to save this, so
 * there is no bulk export to sift.
 *
 * A record's id hashes its timestamp, so the ingest's own duplicate check
 * never matches a second save of the same text made later. The text's hash
 * rides in `sourceRef` instead, and an earlier connector record carrying it
 * means "already saved".
 *
 * The new record is embedded before answering, so a successful save is
 * searchable by meaning straight away. An embedding failure does not undo
 * the save: the record stays stored, and the next embed run picks it up.
 */
export async function saveToDuo(deps: ServeDeps, text: string, now: Date = new Date()): Promise<SaveOutcome> {
  const trimmed = text.trim();
  const sourceRef = textHash(trimmed);
  const alreadySaved = withDatabase(deps.storePath, deps.passphrase, false, (db) => {
    ensureRecordsSchema(db);
    return db.prepare(`SELECT 1 FROM records WHERE source = ? AND source_ref = ?`).get(CONNECTOR_SOURCE, sourceRef) !== undefined;
  });
  if (alreadySaved) {
    return { status: "already_saved" };
  }

  const record = createRecord({
    source: CONNECTOR_SOURCE,
    sourceRef,
    kind: "my_thinking",
    author: "me",
    text: trimmed,
    timestamp: now.toISOString(),
    threadId: null,
    audience: "private",
  });
  const outcome = ingestRecords(deps.storePath, deps.passphrase, [record], {
    ceiling: parseClassificationCeiling(deps.classificationCeiling),
  });
  if (outcome.discardedAboveCeiling > 0) {
    return { status: "above_ceiling" };
  }

  try {
    await embedRecords(deps.storePath, deps.passphrase, deps.embeddingProvider, { limit: INLINE_EMBED_LIMIT });
    return { status: "saved", embedded: true };
  } catch (error) {
    return { status: "saved", embedded: false, embedError: error instanceof Error ? error.message : String(error) };
  }
}

/** What Claude reads back and relays to the owner — plain words, one per outcome. */
export function describeSaveOutcome(outcome: SaveOutcome): string {
  switch (outcome.status) {
    case "saved":
      return outcome.embedded
        ? "Saved to your duo. It is searchable now."
        : `Saved to your duo, but not searchable by meaning yet: embedding failed (${outcome.embedError}). The next embed run will pick it up.`;
    case "already_saved":
      return "Already in your duo: this exact text was saved before, so nothing new was added.";
    case "above_ceiling":
      return "Not saved: this text is classified above your duo's classification ceiling, so it was refused and nothing was stored.";
  }
}

function buildMcpServer(deps: ServeDeps): McpServer {
  const server = new McpServer({ name: "digital-duo", version: "1.0.0" });
  server.registerTool(
    "save_to_duo",
    {
      title: "Save to my duo",
      description:
        "Save text into the user's Digital Duo, their private work memory, when they ask to save, remember or send something to their duo. Pass the text to keep, written so it stands on its own without the rest of the chat.",
      inputSchema: { text: z.string().trim().min(1).describe("The text to save, self-contained") },
    },
    async ({ text }) => ({ content: [{ type: "text", text: describeSaveOutcome(await saveToDuo(deps, text)) }] }),
  );
  return server;
}

/**
 * Issue #227: the MCP endpoint claude.ai's custom connector calls. The
 * secret in the path is the credential (claude.ai's connector form takes a
 * URL, not a header), so the bearer hook skips `/mcp/` and this route checks
 * the secret itself. Under hosted mode the front rewrites `/t/<duo>/mcp/…`
 * to `/mcp/…` inside that duo's own app, so a secret only ever reaches the
 * duo that minted it.
 *
 * Stateless Streamable HTTP: a fresh server and transport per request, no
 * session to track. GET (a standalone event stream) and DELETE (ending a
 * session) are answered 405, which the transport spec allows.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: ServeDeps): void {
  app.post<{ Params: { secret: string } }>("/mcp/:secret", async (request, reply) => {
    if (!verifyConnectorToken(deps.storePath, deps.passphrase, request.params.secret)) {
      reply.code(401).send({ jsonrpc: "2.0", error: { code: -32001, message: "This connector URL is not valid. Copy a new one from your duo." }, id: null });
      return;
    }
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const methodNotAllowed = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null };
  app.get("/mcp/:secret", async (_request, reply) => reply.code(405).header("Allow", "POST").send(methodNotAllowed));
  app.delete("/mcp/:secret", async (_request, reply) => reply.code(405).header("Allow", "POST").send(methodNotAllowed));
}
