import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { DuoConfig } from "../config.js";
import { createLlmEditClassifier, recordDraftOutcomeAndClassify } from "../corrections/classify.js";
import { listCorrectionCandidates, type CorrectionCandidateStatus } from "../corrections/queue.js";
import { buildInterruptionPortrait } from "../derivation/portrait.js";
import { approveRule, describeRuleWithEvidence, listRulesForReview, promoteRule, rejectRule } from "../derivation/rule-review.js";
import { getDraft, listDrafts, DRAFT_OUTCOMES, SETTABLE_DRAFT_OUTCOMES, type DraftOutcome, type SettableDraftOutcome } from "../drafting/draft-log.js";
import { draftReply } from "../drafting/pipeline.js";
import { queueStandingOrderCandidate } from "../drafting/standing-order-candidates.js";
import { listAvailableDuos } from "../duo/registry.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { listAuditEntries } from "../permissions/audit.js";
import { listGrid } from "../trust/grid.js";
import { registerAuth } from "./auth.js";
import { CORS_ALLOWED_HEADERS, resolveCorsOrigins } from "./cors.js";

/**
 * Everything a route needs, resolved once at boot (`client-tech-design.md`
 * §1.1) rather than re-read per request. `createServer` takes this as an
 * argument and touches no process-level state itself, so tests construct
 * it against a temp store the same way the existing command tests do.
 */
export interface ServeDeps {
  readonly storePath: string;
  readonly passphrase: string;
  readonly duoDir: string;
  readonly embeddingProvider: EmbeddingProvider;
  readonly inferenceProvider: InferenceProvider | undefined;
  readonly confidenceConfig: DuoConfig["confidence"];
  readonly env: NodeJS.ProcessEnv;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Thrown to signal a 400 from inside a route body without duplicating the reply.code(400).send(...) dance at every call site — `registerRoutes` never lets this reach the client uncaught; every parse call site catches it explicitly (below). */
class BadRequestError extends Error {}

/** A positive integer query param, or `undefined` when omitted — throws `BadRequestError` for anything else (non-numeric, negative, NaN), so a malformed `?limit=abc` becomes a clean 400 rather than a NaN flowing into a SQL LIMIT binding and crashing as an unhandled 500 (node:sqlite rejects a NaN parameter with "datatype mismatch"). */
function parsePositiveIntParam(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new BadRequestError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * One shape for every error response (`client-tech-design.md` §1.5): a
 * domain error's own message is already written for a human, so this maps
 * the *class* to a status code and passes the message straight through
 * rather than re-wording it.
 */
function statusForError(error: Error): number {
  switch (error.name) {
    case "CorrectionCandidateNotFoundError":
    case "DraftNotFoundError":
    case "StandingOrderCandidateNotFoundError":
    case "DeviceTokenNotFoundError":
    case "RuleNotFoundError":
      return 404;
    case "CandidateAlreadyReviewedError":
    case "NotAnEscalationError":
    case "DraftIsRefusedError":
      return 409;
    case "BlankEditError":
      return 400;
    default:
      return 500;
  }
}

/** Registers every route on an already-constructed Fastify instance. Split out so `createServer` can add auth first and routes after, without routes needing to know that ordering exists. */
function registerRoutes(app: FastifyInstance, deps: ServeDeps): void {
  app.get("/health", async () => ({ ok: true }));

  app.get("/duos", async () => listAvailableDuos(deps.env));

  app.get<{ Querystring: { outcome?: string; before?: string; limit?: string } }>("/drafts", async (request, reply) => {
    const { outcome, before, limit } = request.query;
    if (outcome !== undefined && outcome !== "pending" && !DRAFT_OUTCOMES.includes(outcome as DraftOutcome)) {
      reply.code(400).send(errorBody("bad_request", `outcome must be "pending" or one of: ${DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    let parsedLimit: number | undefined;
    try {
      parsedLimit = parsePositiveIntParam("limit", limit);
    } catch (error) {
      if (!(error instanceof BadRequestError)) {
        throw error;
      }
      reply.code(400).send(errorBody("bad_request", error.message));
      return;
    }
    const drafts = listDrafts(deps.storePath, deps.passphrase, {
      outcome: outcome as DraftOutcome | "pending" | undefined,
      before,
      limit: parsedLimit,
    });
    return drafts;
  });

  app.get<{ Params: { id: string } }>("/drafts/:id", async (request, reply) => {
    const draft = getDraft(deps.storePath, deps.passphrase, request.params.id);
    if (!draft) {
      reply.code(404).send(errorBody("not_found", `No draft with id "${request.params.id}"`));
      return;
    }
    return draft;
  });

  // Synchronous for v1: self-consistency sampling without a configured
  // inference provider falls back to the deterministic extractive draft,
  // which is fast. With a real provider this can take tens of seconds —
  // client-tech-design.md §1.4 proposed a 202-plus-WebSocket shape for
  // that case, deliberately deferred here (see the PR description) so a
  // synchronous, fully-tested route ships now rather than a half-tested
  // job queue.
  app.post<{ Body: { question: string; threadContext?: string | null } }>("/drafts", async (request, reply) => {
    const { question, threadContext } = request.body;
    if (!question) {
      reply.code(400).send(errorBody("bad_request", "question is required"));
      return;
    }
    const result = await draftReply(
      deps.storePath,
      deps.passphrase,
      deps.duoDir,
      question,
      threadContext ?? null,
      deps.embeddingProvider,
      deps.inferenceProvider,
      deps.confidenceConfig,
    );
    // 201, not 202: this is synchronous (see the comment above) and a
    // draft-log row now exists either way (draftReply always writes
    // exactly one row, draft or escalation) — there is nothing pending.
    reply.code(201);
    return result;
  });

  app.post<{ Params: { id: string }; Body: { outcome: string; sentText?: string } }>("/drafts/:id/outcome", async (request, reply) => {
    const { outcome, sentText } = request.body;
    // SETTABLE_DRAFT_OUTCOMES, not the full DRAFT_OUTCOMES: this is the
    // generic outcome-setting route, and escalation_answered must only
    // ever be written by standing-order-candidates.ts's own atomic call —
    // never by a caller here, for any draft, escalated or not.
    if (!SETTABLE_DRAFT_OUTCOMES.includes(outcome as SettableDraftOutcome)) {
      reply.code(400).send(errorBody("bad_request", `outcome must be one of: ${SETTABLE_DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    // The blank-sentText-on-"edited" check lives in recordDraftOutcomeAndClassify
    // itself (corrections/classify.ts), not here — so duo draft-outcome
    // gets the same guard as this route, rather than each caller
    // duplicating it (an earlier version of this fix did exactly that,
    // and only here, leaving the CLI path unguarded).
    try {
      const classifier = deps.inferenceProvider ? createLlmEditClassifier(deps.inferenceProvider) : undefined;
      const result = await recordDraftOutcomeAndClassify(
        deps.storePath,
        deps.passphrase,
        request.params.id,
        outcome as SettableDraftOutcome,
        sentText,
        classifier,
      );
      return result ?? {};
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>("/drafts/:id/answer", async (request, reply) => {
    const answer = request.body.answer?.trim();
    if (!answer) {
      reply.code(400).send(errorBody("bad_request", "answer is required"));
      return;
    }
    try {
      const candidateId = queueStandingOrderCandidate(deps.storePath, deps.passphrase, request.params.id, answer);
      return { candidateId };
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.get<{ Querystring: { status?: string } }>("/review", async (request) => {
    return listCorrectionCandidates(deps.storePath, deps.passphrase, request.query.status as CorrectionCandidateStatus | undefined);
  });

  app.get("/mirror/portrait", async () => buildInterruptionPortrait(deps.storePath, deps.passphrase, deps.duoDir));

  app.get("/mirror/rules", async () => listRulesForReview(deps.storePath, deps.passphrase));

  app.get<{ Params: { id: string } }>("/mirror/rules/:id", async (request, reply) => {
    try {
      return describeRuleWithEvidence(deps.storePath, deps.passphrase, request.params.id);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  const RULE_ACTIONS = { approve: approveRule, reject: rejectRule, promote: promoteRule } as const;
  app.post<{ Params: { id: string; action: string } }>("/mirror/rules/:id/:action", async (request, reply) => {
    const action = RULE_ACTIONS[request.params.action as keyof typeof RULE_ACTIONS];
    if (!action) {
      reply.code(400).send(errorBody("bad_request", `action must be one of: ${Object.keys(RULE_ACTIONS).join(", ")}`));
      return;
    }
    try {
      return action(deps.storePath, deps.passphrase, deps.duoDir, request.params.id);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.get("/trust/grid", async () => listGrid(deps.storePath, deps.passphrase, deps.duoDir));

  app.get("/audit", async () => listAuditEntries(deps.storePath, deps.passphrase));
}

/**
 * Builds a ready-to-listen Fastify instance. No side effects beyond
 * constructing the instance and registering hooks/routes — binding and
 * listening are `duo serve`'s job (`commands/serve.ts`), not this
 * function's, so tests can `fastify.inject()` against it with no open
 * socket at all.
 */
export function createServer(deps: ServeDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  // CORS registers *before* the auth hook on purpose: a browser preflight is
  // an OPTIONS request the browser will not attach `Authorization` to, so if
  // auth ran first every preflight would 401 and no browser-origin client
  // could ever talk to this daemon. Ordering CORS first also puts the
  // allow-origin header on error responses (401/404), which is what lets a
  // browser read those bodies at all. An empty allowlist (resolveCorsOrigins
  // → false) disables CORS outright: default-deny, never a wildcard.
  const corsOrigins = resolveCorsOrigins(deps.env);
  app.register(cors, {
    origin: corsOrigins,
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  registerAuth(app, deps.storePath, deps.passphrase);
  registerRoutes(app, deps);
  return app;
}
