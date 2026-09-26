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

export type SaveOutcome =
  | { readonly status: "saved"; readonly embedded: boolean; readonly embedError?: string }
  | { readonly status: "already_saved" }
  | { readonly status: "above_ceiling" };

/** What one batch of notes came to. Every note lands in exactly one of saved, alreadySaved or aboveCeiling. */
export interface SaveBatchOutcome {
  readonly saved: number;
  readonly alreadySaved: number;
  readonly aboveCeiling: number;
  /** False when the saved notes were stored but embedding failed; `embedError` says why. */
  readonly embedded: boolean;
  readonly embedError?: string;
}

/** The most notes one save_notes_to_duo call takes; a backlog is fed in several calls, not one giant one. */
export const MAX_NOTES_PER_SAVE = 50;
/** A single note's length cap: a note is a summary, not a transcript. */
const MAX_NOTE_CHARS = 20_000;

function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Issue #227: "save this to my duo" from a Claude chat, one or many notes at
 * a time. Each note becomes a single record through the same two-phase ingest
 * an import uses, so the classification ceiling applies exactly as it does
 * there. It skips the work-relevance filter an import applies: the owner
 * chose to save this, so there is no bulk export to sift.
 *
 * A record's id hashes its timestamp, so the ingest's own duplicate check
 * never matches a second save of the same text made later. The text's hash
 * rides in `sourceRef` instead, and an earlier connector record carrying it
 * (or an identical note earlier in the same batch) means "already saved".
 *
 * The new records are embedded before answering, so a successful save is
 * searchable by meaning straight away. An embedding failure does not undo
 * the save: the records stay stored, and the next embed run picks them up.
 */
export async function saveNotesToDuo(deps: ServeDeps, notes: readonly string[], now: Date = new Date()): Promise<SaveBatchOutcome> {
  const unique = new Map<string, string>();
  for (const note of notes) {
    const trimmed = note.trim();
    if (trimmed.length > 0) {
      unique.set(textHash(trimmed), trimmed);
    }
  }
  const submitted = notes.filter((note) => note.trim().length > 0).length;

  const known = withDatabase(deps.storePath, deps.passphrase, false, (db) => {
    ensureRecordsSchema(db);
    const find = db.prepare(`SELECT 1 FROM records WHERE source = ? AND source_ref = ?`);
    return new Set([...unique.keys()].filter((hash) => find.get(CONNECTOR_SOURCE, hash) !== undefined));
  });
  const fresh = [...unique].filter(([hash]) => !known.has(hash));
  const alreadySaved = submitted - fresh.length;
  if (fresh.length === 0) {
    return { saved: 0, alreadySaved, aboveCeiling: 0, embedded: true };
  }

  const records = fresh.map(([hash, text]) =>
    createRecord({
      source: CONNECTOR_SOURCE,
      sourceRef: hash,
      kind: "my_thinking",
      author: "me",
      text,
      timestamp: now.toISOString(),
      threadId: null,
      audience: "private",
    }),
  );
  const outcome = ingestRecords(deps.storePath, deps.passphrase, records, {
    ceiling: parseClassificationCeiling(deps.classificationCeiling),
  });
  const saved = outcome.written;
  if (saved === 0) {
    return { saved, alreadySaved, aboveCeiling: outcome.discardedAboveCeiling, embedded: true };
  }

  try {
    await embedRecords(deps.storePath, deps.passphrase, deps.embeddingProvider, { limit: saved });
    return { saved, alreadySaved, aboveCeiling: outcome.discardedAboveCeiling, embedded: true };
  } catch (error) {
    return {
      saved,
      alreadySaved,
      aboveCeiling: outcome.discardedAboveCeiling,
      embedded: false,
      embedError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One note, as save_to_duo takes it. */
export async function saveToDuo(deps: ServeDeps, text: string, now: Date = new Date()): Promise<SaveOutcome> {
  const batch = await saveNotesToDuo(deps, [text], now);
  if (batch.saved > 0) {
    return batch.embedded ? { status: "saved", embedded: true } : { status: "saved", embedded: false, embedError: batch.embedError };
  }
  return batch.aboveCeiling > 0 ? { status: "above_ceiling" } : { status: "already_saved" };
}

/** What Claude reads back and relays to the owner: plain words, one per outcome. */
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

/** The batch counterpart: the counts Claude reports back when it has fed a backlog. */
export function describeBatchOutcome(outcome: SaveBatchOutcome): string {
  const parts = [
    `${outcome.saved} saved`,
    `${outcome.alreadySaved} already in your duo`,
    `${outcome.aboveCeiling} refused as above your classification ceiling`,
  ];
  const line = `Done: ${parts.join(", ")}.`;
  return outcome.embedded ? line : `${line} The saved notes are not searchable by meaning yet: embedding failed (${outcome.embedError}). The next embed run will pick them up.`;
}

/**
 * The prompt an owner pastes into claude.ai after adding the connector, to
 * have Claude feed their past chats into the duo. It lives here, beside the
 * tool it names and knowing the duo's own ceiling, rather than in the app,
 * so the wording cannot drift from the tools. A re-run adds reworded
 * near-duplicates (only identical text is recognised), hence the date range
 * Claude reports back: the next run continues from there.
 */
export function buildHistoryPrompt(classificationCeiling: string): string {
  const ceiling = classificationCeiling.replace(/_/g, " ");
  return [
    "Use my past chats to feed my Digital Duo, my private work memory.",
    "",
    "1. Search my past chats from the last 3 months (or the range I name) for work: decisions I made, how I answer recurring questions, and project context.",
    "2. For each topic, write one note in my own voice that stands on its own, without the rest of the chat.",
    `3. Save the notes with the save_notes_to_duo tool, up to ${MAX_NOTES_PER_SAVE} per call, calling it again for more.`,
    `4. Leave out anything personal, and anything sensitive or classified. My duo refuses material marked above "${ceiling}", but it can only see a marking, so use your own judgement too.`,
    "5. When you finish, tell me how many were saved and the date range you covered, so I can continue from there next time.",
  ].join("\n");
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
  server.registerTool(
    "save_notes_to_duo",
    {
      title: "Save several notes to my duo",
      description: `Save several notes into the user's Digital Duo in one call: use this when feeding it a backlog (for example notes drawn from their past chats) instead of calling save_to_duo repeatedly. Up to ${MAX_NOTES_PER_SAVE} notes per call; call again for more. Each note must stand on its own. Reports how many were saved, already there, or refused.`,
      inputSchema: {
        notes: z
          .array(z.string().trim().min(1).max(MAX_NOTE_CHARS))
          .min(1)
          .max(MAX_NOTES_PER_SAVE)
          .describe("The notes to save, each self-contained"),
      },
    },
    async ({ notes }) => ({ content: [{ type: "text", text: describeBatchOutcome(await saveNotesToDuo(deps, notes)) }] }),
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
