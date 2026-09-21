import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { listActionAttempts } from "../actions/attempt-log.js";
import { confirmAndExecuteT4Request, describePendingT4Requests } from "../actions/t4-guard.js";
import type { DuoConfig } from "../config.js";
import { createLlmEditClassifier } from "../corrections/classify.js";
import { listCorrectionCandidates, type CorrectionCandidateStatus } from "../corrections/queue.js";
import { approveCandidate, getReviewCandidate, rejectCandidate } from "../corrections/review.js";
import { buildInterruptionPortrait } from "../derivation/portrait.js";
import { assembleEscalationDigest, escalationUrgencyRate, listEscalationDigests } from "../escalation/digest.js";
import { approveRule, describeRuleWithEvidence, listRulesForReview, promoteRule, rejectRule } from "../derivation/rule-review.js";
import { getDraft, listDrafts, DRAFT_OUTCOMES, SETTABLE_DRAFT_OUTCOMES, type DraftOutcome, type SettableDraftOutcome } from "../drafting/draft-log.js";
import { describeChannels, recordOutcomeAndDeliver, type ChannelAdapter } from "../drafting/delivery.js";
import { muteChannel, muteThread, readMutedPolicy, unmuteChannel, unmuteThread } from "../drafting/channel-mutes.js";
import { draftReply } from "../drafting/pipeline.js";
import { queueStandingOrderCandidate } from "../drafting/standing-order-candidates.js";
import { listAvailableDuos } from "../duo/registry.js";
import { describeDuoKnowledge } from "../duo/knowledge-summary.js";
import { hybridSearch } from "../ingest/embeddings.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { listAuditEntries } from "../permissions/audit.js";
import { hasRefusalsDecision, readRefusalsFile } from "../trust/refusals.js";
import { loadDirectory, resolveAsker } from "../permissions/directory.js";
import { answerPublicly, type AskerContext, type PublicAnswerOutcome } from "../permissions/public-answer.js";
import { answerSharedDuo } from "../shared-duo/answer.js";
import { loadSharedDuoConfig } from "../shared-duo/config.js";
import { loadSharedDuo } from "../shared-duo/loader.js";
import { listGrid } from "../trust/grid.js";
import { MISSING_TOKEN_MESSAGE, registerAuth, type AuthCache, type Principal } from "./auth.js";
import { CORS_ALLOWED_HEADERS, resolveCorsOrigins } from "./cors.js";
import { getDeviceToken, listDeviceTokens, revokeDeviceToken } from "./tokens.js";
import { registerDraftReadySocket, type DraftReadyHub } from "./ws.js";

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
  /** Whose duo this is — flows into `answerPublicly` exactly as `runAnswerPublicly` passes `config.ownerName`, for the public attribution line every asker-visible text carries (#159). */
  readonly ownerName: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Adapters the daemon can deliver sent drafts through (#170), matched to
   * a draft's `provenance.channelKind`. Optional — a daemon with none
   * (today: no channel transport ships in this repo) records an honest
   * delivery failure for a channel-origin draft rather than pretending it
   * was delivered.
   */
  readonly channelAdapters?: readonly ChannelAdapter[];
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * #159 (KTD5) + #160: the full asker context an ask is logged under. An
 * ask principal resolves against `duo/directory.json` — the resolved
 * entry's canonical id when the link's name matches one
 * (case-insensitively), the raw name otherwise — and carries the verified
 * ask link's id (`principal.tokenId`) plus the lookup outcome (`resolved`:
 * true on a match, false on no match or an unreadable directory — an
 * attempted-and-failed lookup, not "no lookup ran"). A device principal
 * logs as the fixed "owner" with no link and no lookup (`resolved: null`).
 * Context feeds the logs only: `answerPublicly` applies a uniform
 * clearance ceiling and `answerSharedDuo` does no per-asker permissioning,
 * so the answer is identical either way (R9). A malformed directory falls
 * back to the raw name rather than failing the ask — identity resolution
 * never turns a 200 into a 500.
 */
function askerContextFor(principal: Principal, duoDir: string): AskerContext {
  if (principal.kind === "device") {
    return { ref: "owner", resolved: null, askLinkId: null };
  }
  try {
    const resolution = resolveAsker(principal.name, loadDirectory(duoDir));
    return {
      ref: resolution.resolved ? resolution.identity.id : principal.name,
      resolved: resolution.resolved,
      askLinkId: principal.tokenId,
    };
  } catch {
    // A directory that cannot be read at all — malformed JSON throws a
    // raw SyntaxError from loadDirectory, a wrong shape an
    // InvalidDirectoryError — logs every ask under the raw name rather
    // than failing the ask. The directory is owner-maintained; an
    // unresolvable roster degrades the logs' fidelity, never the answers.
    // The lookup *ran* and failed, so `resolved: false` — not the null
    // that would claim no lookup ever happened.
    return { ref: principal.name, resolved: false, askLinkId: principal.tokenId };
  }
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
 * Validates the body of POST /channels/policy/mute and /unmute (#172): a
 * required non-empty `channel`, an optional non-empty `threadId` scoping
 * below it, and no "/" in either — the separator is what scopes a thread
 * within a channel in the one mute store, so it cannot also be data.
 */
function readMuteTarget(body: { channel?: unknown; threadId?: unknown }): { channel: string; threadId?: string } {
  const { channel, threadId } = body;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new BadRequestError("channel is required and must be a non-empty string");
  }
  if (channel.includes("/")) {
    throw new BadRequestError(`channel must not contain "/" — it scopes a thread within a channel — got ${JSON.stringify(channel)}`);
  }
  if (threadId === undefined) {
    return { channel };
  }
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new BadRequestError("threadId, when present, must be a non-empty string");
  }
  if (threadId.includes("/")) {
    throw new BadRequestError(`threadId must not contain "/" — it scopes a thread within a channel — got ${JSON.stringify(threadId)}`);
  }
  return { channel, threadId };
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
    // #173: the review layer's own not-found — it searched both source
    // tables and found neither, which is a 404 for a client exactly like
    // the single-table errors above it.
    case "ReviewCandidateNotFoundError":
    // #180: confirming a T4 request that was never staged — the guard's
    // own not-found, same class as the rest of this family.
    case "NoPendingT4RequestError":
      return 404;
    case "CandidateAlreadyReviewedError":
    case "NotAnEscalationError":
    case "DraftIsRefusedError":
    // #180: a second confirmation of an executed T4 request — the guard's
    // exactly-once refusal, a conflict and never a re-execution.
    case "T4RequestAlreadyExecutedError":
    // #173: the standing-order twin of CandidateAlreadyReviewedError —
    // previously an anonymous Error here, which mapped to a 500.
    case "StandingOrderCandidateAlreadyReviewedError":
    // #173: approving a substance candidate that contradicts an active
    // rule is a conflict the caller must resolve (supersedesRuleId), not a
    // server error.
    case "CandidateConflictError":
      return 409;
    case "BlankEditError":
    // #172: a channel/thread mute key containing the "/" separator — the
    // entry would be ambiguous in the one mute store, so it is refused.
    case "InvalidMuteKeyError":
      return 400;
    default:
      return 500;
  }
}

/** Registers every route on an already-constructed Fastify instance. Split out so `createServer` can add auth first and routes after, without routes needing to know that ordering exists. */
function registerRoutes(app: FastifyInstance, deps: ServeDeps, draftReady: DraftReadyHub, auth: AuthCache): void {
  app.get("/health", async () => ({ ok: true }));

  app.get("/duos", async () => listAvailableDuos(deps.env));

  // #171: "what this duo is reachable through" — one row per registered
  // adapter, every display string supplied by the adapter itself, so the
  // client renders strings it never has to recognise. No adapters is the
  // supported empty list: a duo with no channels answers only the owner.
  app.get("/channels", async () => describeChannels(deps.channelAdapters ?? [], deps.duoDir));

  // #172: the drafting policy — which channels, and which threads within
  // them, produce no proactive offers at all — over HTTP. This is the ONE
  // mute store `duo mentions mute/unmute/muted` reads and writes
  // (muted-channels.json), through exactly those same module functions: a
  // mute set here is the mute the CLI reads, and a mute set at the terminal
  // shows here. GET decodes the store by scope; the POSTs validate their
  // target, write through the module, and answer with the updated policy.
  app.get("/channels/policy", async () => readMutedPolicy(deps.duoDir));

  app.post<{ Body: { channel?: unknown; threadId?: unknown } }>("/channels/policy/mute", async (request, reply) => {
    try {
      const { channel, threadId } = readMuteTarget(request.body);
      if (threadId !== undefined) {
        muteThread(deps.duoDir, channel, threadId);
      } else {
        muteChannel(deps.duoDir, channel);
      }
      return readMutedPolicy(deps.duoDir);
    } catch (error) {
      if (error instanceof BadRequestError) {
        reply.code(400).send(errorBody("bad_request", error.message));
        return;
      }
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.post<{ Body: { channel?: unknown; threadId?: unknown } }>("/channels/policy/unmute", async (request, reply) => {
    try {
      const { channel, threadId } = readMuteTarget(request.body);
      if (threadId !== undefined) {
        unmuteThread(deps.duoDir, channel, threadId);
      } else {
        unmuteChannel(deps.duoDir, channel);
      }
      return readMutedPolicy(deps.duoDir);
    } catch (error) {
      if (error instanceof BadRequestError) {
        reply.code(400).send(errorBody("bad_request", error.message));
        return;
      }
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  // #177: "which devices can read my corpus right now" (client-tech-design.md
  // Part 2), answerable from a client instead of only at the Mac's terminal.
  // A thin wrapper over the same read `duo pair list` makes — DeviceToken has
  // no token or hash field, so the list structurally cannot leak a credential.
  app.get("/devices", async () => listDeviceTokens(deps.storePath, deps.passphrase));

  // Same-module revoke as `duo pair revoke`, plus the same-tick teardown only
  // an in-process caller can do: the daemon itself holds this device's cached
  // verification (auth.ts) and live socket (ws.ts), so it drops both now
  // instead of waiting out TOKEN_CACHE_TTL_MS and the WS re-verify pass —
  // strictly tighter than the documented staleness windows an out-of-process
  // CLI revoke rides, never looser.
  //
  // Revoking the last remaining device, or the very device making this call,
  // is deliberate and allowed: pairing stays a physical act at the machine
  // holding the corpus (#177's own out-of-scope line), so `duo pair` at the
  // Mac always re-mints a working token — there is no lockout to refuse. A
  // self-revoking caller really does cut itself off: the eviction covers its
  // own cached verification, so its next request 401s.
  app.post<{ Params: { id: string } }>("/devices/:id/revoke", async (request, reply) => {
    try {
      revokeDeviceToken(deps.storePath, deps.passphrase, request.params.id);
      draftReady.closeDevice(request.params.id);
      auth.evictDevice(request.params.id);
      return getDeviceToken(deps.storePath, deps.passphrase, request.params.id);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

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
    // Same-tick draft-ready push (#162): both pipeline outcomes leave a row
    // the owner can act on, so both are announced.
    reply.code(201);
    draftReady.publish(result.draftId);
    return result;
  });

  // Issue #159: the one route an ask token authorizes. A thin wrapper, not
  // new answering logic — delegation mirrors `runAnswerPublicly`
  // argument-for-argument, so every behavioral question (scoping,
  // conservatism, refusal) is answered by the existing function. The auth
  // hook has already verified the bearer as an ask or device principal;
  // `principal.kind` alone decides the response projection (R8).
  app.post<{ Body: unknown }>("/ask", async (request, reply) => {
    const principal = request.principal;
    if (!principal) {
      // Unreachable in practice — the hook attaches a principal on every
      // authenticated /ask before this handler runs — but the projection
      // below is unsafe without one, so refuse rather than guess.
      reply.code(401).send(errorBody("unauthorized", MISSING_TOKEN_MESSAGE));
      return;
    }

    // `request.body` is undefined or a non-object on a bodyless or
    // malformed POST — default to `{}` so the question check below is the
    // single 400 every bad-body shape gets (unlike POST /drafts above,
    // whose blind destructuring would 500 here).
    const body = request.body;
    const { question, duo } = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as {
      question?: unknown;
      duo?: unknown;
    };
    const trimmed = typeof question === "string" ? question.trim() : "";
    if (trimmed === "") {
      reply.code(400).send(errorBody("bad_request", "question is required and must be a non-empty string"));
      return;
    }
    if (duo !== undefined && duo !== "personal" && duo !== "shared") {
      reply.code(400).send(errorBody("bad_request", "duo must be one of: personal, shared"));
      return;
    }

    try {
      if (duo === "shared") {
        // Mirrors `runSharedAsk`: the persona is loaded fresh on every
        // request, so a hand-edited change takes effect on the very next
        // ask. Unavailability (missing, malformed, or invalid persona) is
        // the asker's only discovery surface — they cannot call GET /duos —
        // so it is an explicit 404 naming the personal fallback, never a
        // silent fallback to personal and never a 500 from a thrown load
        // (R10).
        const { personaPath, usageLogPath } = loadSharedDuoConfig(deps.env);
        let sharedDuo;
        try {
          sharedDuo = loadSharedDuo(personaPath);
        } catch {
          reply.code(404).send(errorBody("shared_duo_unavailable", `The shared duo is not available right now; ask the personal duo instead (omit "duo": "shared").`));
          return;
        }
        const asker = askerContextFor(principal, deps.duoDir);
        const answer = await answerSharedDuo(sharedDuo, trimmed, asker, usageLogPath);
        // The shared path's flat declined/declineReason normalizes into the
        // same three kinds every 200 carries (KTD4): out_of_scope is "I
        // can't cover this, ask the owner" — a pass-on — while
        // not_a_decision_maker is a refusal. The annotation ties these
        // literals to the personal path's `outcome.kind` vocabulary — drift
        // between the two envelopes is a compile error, not a review catch.
        const kind: PublicAnswerOutcome["kind"] = answer.declined
          ? answer.declineReason === "not_a_decision_maker"
            ? "declined_refused"
            : "passed_on"
          : "answered";
        const envelope: Record<string, unknown> = {
          duo: "shared",
          kind,
          text: answer.text,
        };
        if (!answer.declined) {
          envelope.citations = answer.citations;
        } else if (answer.declineReason !== undefined) {
          envelope.declineReason = answer.declineReason;
        }
        // No owner-only projection: the shared outcome has none, so both
        // principal kinds get this same envelope (R8).
        return envelope;
      }

      const outcome = await answerPublicly(
        deps.storePath,
        deps.passphrase,
        deps.duoDir,
        trimmed,
        askerContextFor(principal, deps.duoDir),
        deps.embeddingProvider,
        deps.inferenceProvider,
        deps.confidenceConfig,
        deps.ownerName,
      );
      // The CLI's three-outcome shape (R7), not a new HTTP vocabulary:
      // asker-visible fields for everyone, the owner-facing fields the
      // CLI prints on stderr only for a device principal (R8).
      const envelope: Record<string, unknown> = {
        duo: "personal",
        kind: outcome.kind,
        text: outcome.kind === "answered" ? outcome.text : outcome.message,
      };
      if (outcome.kind === "answered") {
        envelope.sources = outcome.sources;
      }
      if (principal.kind === "device") {
        envelope.draftId = outcome.draftId;
        envelope.logEntryId = outcome.logEntryId;
        if (outcome.kind === "answered") {
          envelope.topicId = outcome.topicId;
          envelope.confidence = outcome.confidence;
          envelope.evidenceAgeDays = outcome.evidenceAgeDays;
        } else if (outcome.kind === "passed_on") {
          if (outcome.topicId !== undefined) {
            envelope.topicId = outcome.topicId;
          }
          if (outcome.ownerNotice !== undefined) {
            envelope.ownerNotice = outcome.ownerNotice;
          }
        }
      }
      return envelope;
    } catch (error) {
      // The asker-visible surface must never echo an internal error —
      // provider details or filesystem paths are owner information (the
      // POST /drafts no-catch precedent passes Fastify's default error
      // body through, which is wrong for this audience).
      // The daemon runs Fastify with logger:false, so request.log.error
      // would be a no-op (U2 step 6: the real error reaches the owner
      // server-side via console.error, matching the CLI's reportError
      // stderr convention).
      console.error("POST /ask: answering failed:", error);
      reply.code(500).send(errorBody("internal_error", "Something went wrong answering that."));
      return;
    }
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
    // The blank-sentText-on-"edited" check lives in recordOutcomeAndDeliver
    // (via corrections/classify.ts), not here — so duo draft-outcome gets
    // the same guard as this route, rather than each caller duplicating it
    // (an earlier version of this fix did exactly that, and only here,
    // leaving the CLI path unguarded). Delivery through the draft's origin
    // channel (#170) rides the same seam, also not here: this route adds no
    // behaviour of its own beyond validating the request.
    try {
      const classifier = deps.inferenceProvider ? createLlmEditClassifier(deps.inferenceProvider) : undefined;
      const result = await recordOutcomeAndDeliver(deps.storePath, deps.passphrase, request.params.id, outcome as SettableDraftOutcome, sentText, {
        classifier,
        channelAdapters: deps.channelAdapters,
      });
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

  // #173: thin wrappers over the same module functions `duo corrections
  // approve`/`reject` call — approveCandidate/rejectCandidate own all the
  // behaviour (voice.md/rules writes, conflict gate, finality); the route's
  // only job is passing the id through and returning the updated candidate.
  app.post<{ Params: { id: string }; Body: { supersedesRuleId?: string } | undefined }>("/review/:id/approve", async (request, reply) => {
    try {
      const result = approveCandidate(deps.storePath, deps.passphrase, deps.duoDir, request.params.id, {
        supersedesRuleId: request.body?.supersedesRuleId,
      });
      const candidate = getReviewCandidate(deps.storePath, deps.passphrase, request.params.id);
      return { candidate, result };
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.post<{ Params: { id: string } }>("/review/:id/reject", async (request, reply) => {
    try {
      rejectCandidate(deps.storePath, deps.passphrase, request.params.id);
      const candidate = getReviewCandidate(deps.storePath, deps.passphrase, request.params.id);
      return { candidate };
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.get("/mirror/portrait", async () => buildInterruptionPortrait(deps.storePath, deps.passphrase, deps.duoDir));

  // #175: what this duo knows, in one read. A pure composition — every
  // number comes from a module function that already existed or a fact the
  // store already keeps; the route adds no behaviour of its own, it just
  // says which providers the daemon was wired with.
  app.get("/knowledge", async () =>
    describeDuoKnowledge(
      deps.storePath,
      deps.passphrase,
      deps.duoDir,
      {
        inference: deps.inferenceProvider?.name ?? null,
        embedding: { name: deps.embeddingProvider.name, model: deps.embeddingProvider.model },
      },
      deps.env,
    ),
  );

  app.get("/mirror/rules", async () => listRulesForReview(deps.storePath, deps.passphrase));

  app.get<{ Params: { id: string } }>("/mirror/rules/:id", async (request, reply) => {
    try {
      return describeRuleWithEvidence(deps.storePath, deps.passphrase, request.params.id);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  // #182: `duo mirror refusals list`'s own read — pure duo/refusals.md file
  // state, the same two module functions the CLI command calls, so a
  // refusal recorded at the terminal shows here and this is the same one
  // file every refusal check already reads. `decided: false` (no file at
  // all) is a 200 — "never asked" is onboarding state to show, not an
  // error. add/confirm-none stay terminal-only: they are authoring acts,
  // the same class as rule authoring (AR-18).
  app.get("/mirror/refusals", async () => ({ decided: hasRefusalsDecision(deps.duoDir), refusals: readRefusalsFile(deps.duoDir) }));

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

  // #180: the T4 confirmation moment, over HTTP — the owner is not sitting
  // at the daemon's terminal when their duo reaches an irreversible step
  // (concept.md §6: "never autonomous"), so the staged requests are listed
  // and confirmed from a paired device. Three thin reads/writes over the
  // same module functions the CLI commands call; the two-step
  // create-then-confirm sequence itself is untouched — confirming is this
  // route and only this route, and staging stays a module call no HTTP
  // route exposes.
  app.get("/actions/t4/pending", async () => describePendingT4Requests(deps.storePath, deps.passphrase));

  // The confirmation itself: the same `confirmAndExecuteT4Request` call
  // `duo actions t4 confirm` makes (same no-op execute placeholder — there
  // is genuinely nothing to execute yet — same exactly-once), plus the one
  // thing only an authenticated caller can supply: the device giving it,
  // recorded in the attempt log entry. #160's `tokenId` carries exactly
  // that — on a device principal it is the paired device's id.
  app.post<{ Params: { id: string } }>("/actions/t4/:id/confirm", async (request, reply) => {
    try {
      return confirmAndExecuteT4Request(deps.storePath, deps.passphrase, request.params.id, () => {}, request.principal?.tokenId);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  // Every attempt, refused or resolved — `duo actions attempts`' own read,
  // verbatim, so the owner can audit the guard's refusals from a client.
  app.get("/actions/attempts", async () => listActionAttempts(deps.storePath, deps.passphrase));

  // #174: the corpus, from a client — `duo search`'s own hybridSearch,
  // verbatim (results/ranked order, usedEmbeddings, fallback warning). The
  // route's only job is validating the query string; ranking, paging and
  // the embeddings-down fallback all live in the module, where the CLI
  // reaches them too.
  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>("/search", async (request, reply) => {
    const q = request.query.q;
    if (typeof q !== "string" || q.trim().length === 0) {
      reply.code(400).send(errorBody("bad_request", "q is required and must not be blank"));
      return;
    }
    let limit = 10;
    if (request.query.limit !== undefined) {
      limit = Number.parseInt(request.query.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        reply.code(400).send(errorBody("bad_request", "limit must be an integer between 1 and 100"));
        return;
      }
    }
    let cursor = 0;
    if (request.query.cursor !== undefined) {
      cursor = Number.parseInt(request.query.cursor, 10);
      if (!Number.isInteger(cursor) || cursor < 0) {
        reply.code(400).send(errorBody("bad_request", "cursor must be a non-negative integer"));
        return;
      }
    }
    return hybridSearch(deps.storePath, deps.passphrase, q, deps.embeddingProvider, limit, cursor);
  });

  // #178: `duo escalations digest|history|rate` over HTTP — how the owner
  // sees what their duo keeps having to ask about, thin over the same
  // module functions those commands call. digest is a POST because
  // assembling *is* the send: it writes the append-only escalation_digests
  // row and marks its items digested, exactly as `duo escalations digest`
  // does at the terminal. history validates limit/cursor with /search's
  // own vocabulary and bounds; the paging itself lives in
  // listEscalationDigests, where the CLI reads all rows by default.
  app.post("/escalations/digest", async () => assembleEscalationDigest(deps.storePath, deps.passphrase));

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/escalations/history", async (request, reply) => {
    let limit = 10;
    if (request.query.limit !== undefined) {
      limit = Number.parseInt(request.query.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        reply.code(400).send(errorBody("bad_request", "limit must be an integer between 1 and 100"));
        return;
      }
    }
    let cursor = 0;
    if (request.query.cursor !== undefined) {
      cursor = Number.parseInt(request.query.cursor, 10);
      if (!Number.isInteger(cursor) || cursor < 0) {
        reply.code(400).send(errorBody("bad_request", "cursor must be a non-negative integer"));
        return;
      }
    }
    return listEscalationDigests(deps.storePath, deps.passphrase, { limit, cursor });
  });

  app.get("/escalations/rate", async () => escalationUrgencyRate(deps.storePath, deps.passphrase));

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
  const auth = registerAuth(app, deps.storePath, deps.passphrase);
  const draftReady = registerDraftReadySocket(app, deps);
  registerRoutes(app, deps, draftReady, auth);
  return app;
}
