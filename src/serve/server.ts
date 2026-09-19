import Fastify, { type FastifyInstance } from "fastify";
import type { DuoConfig } from "../config.js";
import { createLlmEditClassifier, recordDraftOutcomeAndClassify } from "../corrections/classify.js";
import { listCorrectionCandidates, type CorrectionCandidateStatus } from "../corrections/queue.js";
import { buildInterruptionPortrait } from "../derivation/portrait.js";
import { approveRule, describeRuleWithEvidence, listRulesForReview, promoteRule, rejectRule } from "../derivation/rule-review.js";
import { getDraft, listDrafts, DRAFT_OUTCOMES, type DraftOutcome } from "../drafting/draft-log.js";
import { draftReply } from "../drafting/pipeline.js";
import { queueStandingOrderCandidate } from "../drafting/standing-order-candidates.js";
import { listAvailableDuos } from "../duo/registry.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { listAuditEntries } from "../permissions/audit.js";
import { listGrid } from "../trust/grid.js";
import { registerAuth } from "./auth.js";

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
      return 409;
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
    const drafts = listDrafts(deps.storePath, deps.passphrase, {
      outcome: outcome as DraftOutcome | "pending" | undefined,
      before,
      limit: limit !== undefined ? Number.parseInt(limit, 10) : undefined,
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
    if (!DRAFT_OUTCOMES.includes(outcome as DraftOutcome)) {
      reply.code(400).send(errorBody("bad_request", `outcome must be one of: ${DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    try {
      const classifier = deps.inferenceProvider ? createLlmEditClassifier(deps.inferenceProvider) : undefined;
      const result = await recordDraftOutcomeAndClassify(deps.storePath, deps.passphrase, request.params.id, outcome as DraftOutcome, sentText, classifier);
      return result ?? {};
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>("/drafts/:id/answer", async (request, reply) => {
    if (!request.body.answer) {
      reply.code(400).send(errorBody("bad_request", "answer is required"));
      return;
    }
    try {
      const candidateId = queueStandingOrderCandidate(deps.storePath, deps.passphrase, request.params.id, request.body.answer);
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
  registerAuth(app, deps.storePath, deps.passphrase);
  registerRoutes(app, deps);
  return app;
}
