import type { FastifyInstance, FastifyReply } from "fastify";
import { appendActionAttempt, ensureActionAttemptLogSchema } from "../actions/attempt-log.js";
import { readThreadMessages } from "../drafting/thread-history.js";
import { MalformedExportError, parseClaudeExport } from "../ingest/adapters/claude-export.js";
import { ingestRecords } from "../ingest/two-phase.js";
import { parseClassificationCeiling } from "../permissions/classification.js";
import { withDatabase } from "../store/store.js";
import { listRecentDemotions } from "../trust/demotion.js";
import { grantAutonomy } from "../trust/grants.js";
import { isTrustTier } from "../trust/grid.js";
import { acceptPromotionOffer, declinePromotionOffer, getPendingPromotionOffers } from "../trust/promotion.js";
import { jobsFor } from "./jobs.js";
import { buildHistoryPrompt } from "./mcp.js";
import type { ServeDeps } from "./server.js";
import {
  AskTokenNotFoundError,
  createAskToken,
  createConnectorToken,
  createDeviceToken,
  getConnectorToken,
  listAskTokens,
  revokeAskToken,
} from "./tokens.js";

/** A Claude export's conversations.json is routinely tens of MB — far past Fastify's 1 MiB default. */
const CLAUDE_EXPORT_BODY_LIMIT = 200 * 1024 * 1024;
const DEFAULT_ASK_LINK_HOURS = 72;
/** ECMAScript Dates top out at ±8.64e15 ms — the same overflow guard `duo ask-link new` applies. */
const MAX_DATE_MS = 8.64e15;

function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ error: { code, message } });
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The owner-management surface that used to be terminal-only — importing a
 * Claude export, deriving, ask links, pairing another device, and trust
 * grants/promotions — so an owner with no shell on the daemon's host (every
 * hosted user) can run their duo entirely from the app. Each route calls
 * the same module function its CLI command calls; none adds behaviour.
 *
 * Every route here is owner-only by construction: the auth hook refuses an
 * ask token on every route but `/ask` (serve/auth.ts), so only a paired
 * device's principal ever reaches these handlers.
 */
export function registerOwnerRoutes(app: FastifyInstance, deps: ServeDeps): void {
  const deriveJob = jobsFor(deps).derive;

  app.post<{ Body: { export?: unknown } }>(
    "/corpus/import-claude",
    { bodyLimit: CLAUDE_EXPORT_BODY_LIMIT },
    async (request, reply) => {
      const raw = request.body?.export;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        sendError(reply, 400, "bad_request", "export is required: the text of a Claude export's conversations.json");
        return;
      }
      try {
        const { records, conversationCount, workRelevantConversationCount } = parseClaudeExport(raw);
        const outcome = ingestRecords(deps.storePath, deps.passphrase, records, {
          ceiling: parseClassificationCeiling(deps.classificationCeiling),
        });
        return {
          conversationCount,
          workRelevantConversationCount,
          written: outcome.written,
          skipped: outcome.alreadyPresent,
          discardedAboveCeiling: outcome.discardedAboveCeiling,
        };
      } catch (error) {
        if (error instanceof MalformedExportError) {
          sendError(reply, 400, "malformed_export", error.message);
          return;
        }
        throw error;
      }
    },
  );

  app.post("/corpus/derive", async (_request, reply) => {
    const started = deriveJob.start({
      storePath: deps.storePath,
      passphrase: deps.passphrase,
      duoDir: deps.duoDir,
      embeddingProvider: deps.embeddingProvider,
      inferenceProvider: deps.inferenceProvider,
    });
    if (!started) {
      sendError(reply, 409, "derive_already_running", "A derive is already running; watch GET /corpus/derive for its progress.");
      return;
    }
    reply.code(202);
    return deriveJob.current();
  });

  app.get("/corpus/derive", async () => deriveJob.current());

  app.get("/ask-links", async () => {
    const now = Date.now();
    return listAskTokens(deps.storePath, deps.passphrase).map((link) => ({
      ...link,
      valid: link.revokedAt === null && Date.parse(link.expiresAt) > now,
    }));
  });

  app.post<{ Body: { name?: unknown; expiresInHours?: unknown } }>("/ask-links", async (request, reply) => {
    const name = nonBlankString(request.body?.name);
    if (!name) {
      sendError(reply, 400, "bad_request", "name is required: who the link is for");
      return;
    }
    const hours = request.body?.expiresInHours ?? DEFAULT_ASK_LINK_HOURS;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours <= 0 || Date.now() + hours * 3_600_000 > MAX_DATE_MS) {
      sendError(reply, 400, "bad_request", "expiresInHours must be a positive whole number of hours");
      return;
    }
    const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
    reply.code(201);
    return createAskToken(deps.storePath, deps.passphrase, name, expiresAt);
  });

  app.post<{ Params: { id: string } }>("/ask-links/:id/revoke", async (request, reply) => {
    try {
      revokeAskToken(deps.storePath, deps.passphrase, request.params.id);
      reply.code(204).send();
    } catch (error) {
      if (error instanceof AskTokenNotFoundError) {
        sendError(reply, 404, error.name, error.message);
        return;
      }
      throw error;
    }
  });

  app.post<{ Body: { name?: unknown } }>("/devices", async (request, reply) => {
    const name = nonBlankString(request.body?.name);
    if (!name) {
      sendError(reply, 400, "bad_request", "name is required: what to call the new device");
      return;
    }
    reply.code(201);
    return createDeviceToken(deps.storePath, deps.passphrase, name);
  });

  // #227: the claude.ai connector. Where hosted mode supplies sign-in access
  // (#240), Claude connects by signing in: GET reports the one plain URL to
  // paste and the connected Claudes, POST /connector is refused (there is no
  // secret to mint) and a connection is revoked by id. Otherwise POST mints
  // this duo's connector secret (revoking any earlier one) and returns its
  // path once; the client joins it to the daemon base it already talks to,
  // which under hosted mode carries the duo's /t/<id> prefix. Either way GET
  // also returns the prompt the owner pastes into claude.ai to feed their
  // past chats.
  app.post("/connector", async (_request, reply) => {
    if (deps.connectorAccess) {
      sendError(reply, 409, "connector_uses_sign_in", "This duo connects Claude by signing in; there is no secret URL to generate.");
      return;
    }
    const minted = createConnectorToken(deps.storePath, deps.passphrase);
    reply.code(201);
    return { id: minted.id, createdAt: minted.createdAt, path: `/mcp/${minted.token}` };
  });

  app.get("/connector", async () => {
    const historyPrompt = buildHistoryPrompt(deps.classificationCeiling);
    if (deps.connectorAccess) {
      return { mode: "signin", connector: null, url: deps.connectorAccess.url, connections: deps.connectorAccess.connections(), historyPrompt };
    }
    return { mode: "secret", connector: getConnectorToken(deps.storePath, deps.passphrase) ?? null, historyPrompt };
  });

  app.post<{ Params: { id: string } }>("/connector/connections/:id/revoke", async (request, reply) => {
    if (!deps.connectorAccess?.revoke(request.params.id)) {
      sendError(reply, 404, "connection_not_found", `No connected Claude with id "${request.params.id}".`);
      return;
    }
    return { ok: true };
  });

  app.get("/trust/promotions", async () => getPendingPromotionOffers(deps.storePath, deps.passphrase, deps.duoDir));

  // digital-duo#246: the client's notice card ("I got that wrong, so I've
  // gone back to asking you first.") has nothing to render without this —
  // recent real demotions (a cell that actually dropped, never the
  // at-floor no-op), oldest first, each carrying the id a client can use
  // to dedupe or mark seen. Read-only: there is no write route, since a
  // seen-marker is this device's own concern (owner-routes.ts's doc
  // comment on why this file exists at all — nothing here adds
  // behaviour beyond what the CLI's own command already does, and there
  // is no `duo trust` command that marks a notice seen either).
  app.get<{ Querystring: { since?: string } }>("/trust/notices", async (request) =>
    listRecentDemotions(deps.storePath, deps.passphrase, deps.duoDir, request.query.since),
  );

  // digital-duo#248: a bridged chat's surrounding messages, so the client
  // can fill in around the questions it already has from GET /drafts. No
  // adapter for this channel, or one that cannot read its own history, or
  // a thread it simply cannot read — every one of those is the same
  // "nothing available" empty array; the route never distinguishes them,
  // because the client's fallback (today's questions-only view) is the
  // same for all three.
  app.get<{ Params: { channelKind: string; threadId: string } }>(
    "/threads/:channelKind/:threadId/messages",
    async (request) =>
      readThreadMessages(deps.storePath, deps.passphrase, deps.channelAdapters ?? [], request.params.channelKind, request.params.threadId),
  );

  app.post<{ Params: { topicId: string; tier: string }; Body: { decision?: unknown } }>(
    "/trust/promotions/:topicId/:tier",
    async (request, reply) => {
      const { topicId, tier } = request.params;
      const decision = request.body?.decision;
      if (!isTrustTier(tier)) {
        sendError(reply, 400, "bad_request", `"${tier}" is not a valid trust tier — expected one of T0, T1, T2, T3.`);
        return;
      }
      if (decision !== "accept" && decision !== "decline") {
        sendError(reply, 400, "bad_request", 'decision must be "accept" or "decline"');
        return;
      }
      return decision === "accept"
        ? acceptPromotionOffer(deps.storePath, deps.passphrase, topicId, tier)
        : declinePromotionOffer(deps.storePath, deps.passphrase, topicId, tier);
    },
  );

  app.post<{ Body: { scopeText?: unknown; tier?: unknown; topicId?: unknown } }>("/trust/grant", async (request, reply) => {
    const scopeText = nonBlankString(request.body?.scopeText);
    const tier = request.body?.tier;
    const topicId = request.body?.topicId;
    if (!scopeText) {
      sendError(reply, 400, "bad_request", "scopeText is required: the grant, in plain words");
      return;
    }
    if (topicId !== undefined && typeof topicId !== "string") {
      sendError(reply, 400, "bad_request", "topicId, when present, must be a string");
      return;
    }
    // #60 AC3, same as `duo trust grant`: an attempt to grant T4 is refused
    // and — unlike a plain typo — recorded in the action attempt log.
    if (typeof tier === "string" && tier.toUpperCase() === "T4") {
      withDatabase(deps.storePath, deps.passphrase, true, (db) => {
        ensureActionAttemptLogSchema(db);
        appendActionAttempt(db, {
          actionId: "trust_grant",
          topicId: topicId ?? null,
          tier: "T4",
          outcome: "refused_t4_bypass",
          detail: { scopeText, requestedTier: tier },
        });
      });
      sendError(reply, 400, "t4_never_autonomous", "T4 actions are never autonomous; this grant is refused and was logged.");
      return;
    }
    if (typeof tier !== "string" || !isTrustTier(tier)) {
      sendError(reply, 400, "bad_request", "tier must be one of T0, T1, T2, T3");
      return;
    }
    return grantAutonomy(deps.storePath, deps.passphrase, deps.duoDir, { scopeText, tier, topicId });
  });
}
