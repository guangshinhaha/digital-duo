import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerFactory } from "fastify";
import { listActionAttempts } from "../actions/attempt-log.js";
import { confirmAndExecuteT4Request, describePendingT4Requests } from "../actions/t4-guard.js";
import { endDuoAndRecord, readLifecycle } from "../continuity/lifecycle.js";
import { listTransfers } from "../continuity/transfer.js";
import type { DuoConfig } from "../config.js";
import { createLlmEditClassifier } from "../corrections/classify.js";
import type { CorrectionCandidateStatus } from "../corrections/queue.js";
import { approveCandidate, getReviewCandidate, listReviewCandidates, rejectCandidate } from "../corrections/review.js";
import { buildInterruptionPortrait } from "../derivation/portrait.js";
import { assembleEscalationDigest, escalationUrgencyRate, listEscalationDigests } from "../escalation/digest.js";
import { approveRule, describeRuleWithEvidence, listRulesForReview, promoteRule, rejectRule } from "../derivation/rule-review.js";
import {
  getDraft,
  listDrafts,
  undoLatestShape,
  DISMISS_REASONS,
  DRAFT_OUTCOMES,
  SETTABLE_DRAFT_OUTCOMES,
  SHAPE_INSTRUCTIONS,
  type DismissReason,
  type DraftOutcome,
  type DraftRecipient,
  type SettableDraftOutcome,
  type ShapeInstruction,
} from "../drafting/draft-log.js";
import { shapeDraft } from "../drafting/shape.js";
import { describeChannels, recordOutcomeAndDeliver, type ChannelAdapter } from "../drafting/delivery.js";
import { settleScheduledSend } from "../drafting/scheduled-sends.js";
import { muteChannel, muteThread, readMutedPolicy, unmuteChannel, unmuteThread } from "../drafting/channel-mutes.js";
import { readVoiceText } from "../drafting/context.js";
import { checkOwnerText } from "../drafting/fact-check.js";
import { draftReply } from "../drafting/pipeline.js";
import { REWRITE_INSTRUCTIONS, RewriteUnavailableError, rewriteOwnerText, type RewriteInstruction } from "../drafting/rewrite.js";
import { queueStandingOrderCandidate } from "../drafting/standing-order-candidates.js";
import { listAvailableDuos } from "../duo/registry.js";
import { describeDuoKnowledge } from "../duo/knowledge-summary.js";
import { hybridSearch } from "../ingest/embeddings.js";
import { importPastedTranscript } from "../ingest/paste-import.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { listAuditEntries } from "../permissions/audit.js";
import { hasRefusalsDecision, readRefusalsFile } from "../trust/refusals.js";
import { resolveAskerRef } from "../permissions/directory.js";
import { answerPublicly, PUBLIC_ANSWER_FAILED_MESSAGE, type AskerContext, type PublicAnswerOutcome } from "../permissions/public-answer.js";
import { notifyDraftWaiting } from "../push/notify.js";
import type { PushSender } from "../push/sender.js";
import { answerSharedDuo } from "../shared-duo/answer.js";
import { loadSharedDuoConfig } from "../shared-duo/config.js";
import { loadSharedDuo } from "../shared-duo/loader.js";
import { listGrid } from "../trust/grid.js";
import type { WorkspaceService } from "../workspace/service.js";
import { MISSING_TOKEN_MESSAGE, registerAuth, type AuthCache, type Principal } from "./auth.js";
import type { SessionOutcome } from "../hosted/workspace-session.js";
import { CORS_ALLOWED_HEADERS, resolveCorsOrigins } from "./cors.js";
import type { EmbedJob } from "./embed-job.js";
import { jobsFor } from "./jobs.js";
import { registerMcpRoutes, type ConnectorAccess } from "./mcp.js";
import { registerOrgRoutes, type OrgAdminAccess } from "./org-routes.js";
import { registerOwnerRoutes } from "./owner-routes.js";
import { ScheduledSendRunner } from "./scheduled-send-runner.js";
import { registerScheduledSendRoutes } from "./scheduled-send-routes.js";
import { registerAutonomyRoutes } from "./autonomy-routes.js";
import { getDeviceToken, listDeviceTokens, revokeDeviceToken } from "./tokens.js";
import { registerDraftReadySocket, type DraftReadyHub } from "./ws.js";

/**
 * Everything a route needs, resolved once at boot (`client-tech-design.md`
 * §1.1) rather than re-read per request. `createServer` takes this as an
 * argument and touches no process-level state itself, so tests construct
 * it against a temp store the same way the existing command tests do.
 */
/**
 * #233: what a hosted duo's app calls to give its owner's signed-in app a Matrix session. Bound to
 * one duo by whoever builds the deps (hosted mode), so the route never names an account: the duo is
 * the one this app's device-token auth just verified the caller against.
 */
export interface WorkspaceSessionAccess {
  /** The owner's own person session (a token that is kept and handed out again until it nears expiry). */
  session(): Promise<SessionOutcome>;
  /** The client was told `M_UNKNOWN_TOKEN`: drop the cached token so the next `session()` mints a new one. */
  renew(): Promise<void>;
  /** A device of this duo was revoked, or the duo was ended: end the session the daemon holds. Best effort, never throws. */
  end(): void;
}

export interface ServeDeps {
  readonly storePath: string;
  readonly passphrase: string;
  readonly duoDir: string;
  /**
   * Where lifecycle events are audited (`config.lifecycleLogPath`) — its
   * own directory, deliberately outside both the store's data directory and
   * `duoDir`, because #181's end route deletes those two and the "ended"
   * event must outlive what it records the deletion of.
   */
  readonly lifecycleLogPath: string;
  readonly embeddingProvider: EmbeddingProvider;
  readonly inferenceProvider: InferenceProvider | undefined;
  readonly confidenceConfig: DuoConfig["confidence"];
  /**
   * The classification ceiling exactly as config carries it (the raw
   * string) — the paste-import path (#176) parses it inside the module
   * function, the same call `duo import paste` makes, rather than the
   * route re-deriving a parsed value.
   */
  readonly classificationCeiling: DuoConfig["classificationCeiling"];
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
  /**
   * #192: the outbound workspace connection's service, when the daemon was
   * started with a workspace configured. The consent routes below are this
   * service's owner surface — held invitations, allowed rooms, withdrawal —
   * and are absent (undefined) exactly when there is no workspace, where the
   * GETs read as empty state and the POSTs refuse: there is no connection to
   * join or leave through.
   */
  readonly workspace?: WorkspaceService;
  /**
   * Trust `X-Forwarded-For` from the front (Railway's edge, org mode §3).
   * Without it every request's `request.ip` is the proxy's, so the per-IP
   * auth-failure limiter would lock every client out after ten bad tokens
   * from anyone. Only set behind a front that overwrites the header.
   */
  readonly trustProxy?: boolean;
  /**
   * #240: sign-in connectors for claude.ai, supplied by hosted mode. When
   * set, the connector routes report and manage those connections and the
   * secret connector URLs are refused; when absent the secret URL is the
   * connector (#227).
   */
  readonly connectorAccess?: ConnectorAccess;
  /** #233: set by hosted mode when a workspace is configured; absent, `/workspace/session` answers 404 `workspace_not_configured`. */
  readonly workspaceSession?: WorkspaceSessionAccess;
  /** #254: set by hosted mode, bound to this duo; absent (a personal duo), the `/org*` routes do not exist. */
  readonly orgAdmin?: OrgAdminAccess;
  /**
   * digital-duo#251: how a push notification actually reaches a device.
   * Optional — omitted, `notifyDraftWaiting`'s own default (`webPushSender`,
   * the real `web-push`-backed one) is used, the same optionality
   * `channelAdapters` above already has. Injected here, rather than only
   * as `notifyDraftWaiting`'s own parameter, so every call site in this
   * file shares one sender per daemon process instead of each reaching for
   * the real one individually.
   */
  readonly pushSender?: PushSender;
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
  // The resolve-or-degrade core is directory.ts's resolveAskerRef — the
  // same one the workspace's sender mapping uses (#186), so link asks and
  // workspace asks log identically. The verified ask link's id rides along
  // either way; only the ref/resolved pair comes from the directory.
  const { ref, resolved } = resolveAskerRef(principal.name, principal.name, duoDir);
  return { ref, resolved, askLinkId: principal.tokenId };
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

/** A JSON body's alternative index (guangshinhaha/duo#257/#258): a real non-negative integer, never a string or a fraction coerced into one. */
function isAlternativeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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

/** Longest recipient id or name POST /drafts accepts — a Matrix id or an email fits with room to spare; anything longer is not an identity. */
const MAX_RECIPIENT_FIELD_LENGTH = 256;

/**
 * Validates POST /drafts' optional `recipient` (guangshinhaha/duo#262):
 * omitted or null means "no particular person"; otherwise an object with a
 * non-empty string `id` (the key adaptation groups sends by) and an
 * optional string `name` for display.
 */
function parseDraftRecipient(raw: unknown): DraftRecipient | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("recipient, when present, must be an object: { id, name? }");
  }
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || id.trim().length === 0 || id.length > MAX_RECIPIENT_FIELD_LENGTH) {
    throw new BadRequestError(`recipient.id is required and must be a non-empty string of at most ${MAX_RECIPIENT_FIELD_LENGTH} characters`);
  }
  if (name !== undefined && name !== null && (typeof name !== "string" || name.length > MAX_RECIPIENT_FIELD_LENGTH)) {
    throw new BadRequestError(`recipient.name, when present, must be a string of at most ${MAX_RECIPIENT_FIELD_LENGTH} characters`);
  }
  const trimmedName = typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  return { id: id.trim(), name: trimmedName };
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
    // #192: deciding on an invitation this daemon is not holding, or
    // withdrawing a room no record speaks about — both "nothing to act on"
    // for a client, like the not-found family above.
    case "NoPendingInviteError":
    case "RoomConsentNotFoundError":
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
    // #262: a second outcome recorded against a draft that already has
    // one — refused by recordOutcomeAndDeliver before anything is written
    // or delivered again, the same "already finalized" conflict as the
    // rest of this family.
    case "DraftAlreadySettledError":
    // guangshinhaha/duo#258: shaping a draft that can't take one (passed
    // on, already settled, nothing to undo, changed underneath) — and a
    // daemon with no model to shape with — are the draft's or the daemon's
    // state refusing the request, not a malformed one.
    case "DraftNotShapeableError":
    case "ShapingUnavailableError":
      return 409;
    case "BlankEditError":
    // #259 in guangshinhaha/duo: a dismissReason sent alongside any outcome
    // other than "discarded" — the same "caller sent something that can
    // never be valid" shape as BlankEditError just above.
    case "DismissReasonRequiresDiscardedError":
    // guangshinhaha/duo#257: an alternative index the draft doesn't have.
    case "UnknownAlternativeError":
    // #172: a channel/thread mute key containing the "/" separator — the
    // entry would be ambiguous in the one mute store, so it is refused.
    case "InvalidMuteKeyError":
    // #176: a pasted transcript with no recognisable turn — the paste
    // adapter's own error names the format it expected.
    case "MalformedTranscriptError":
      return 400;
    default:
      return 500;
  }
}

/** Registers every route on an already-constructed Fastify instance. Split out so `createServer` can add auth first and routes after, without routes needing to know that ordering exists. */
function registerRoutes(
  app: FastifyInstance,
  deps: ServeDeps,
  draftReady: DraftReadyHub,
  auth: AuthCache,
  embedJob: EmbedJob,
  scheduledSends: ScheduledSendRunner,
): void {
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

  // #192: the consent surface — where this duo is allowed to be reachable,
  // decided by its owner alone. Four thin wrappers over the workspace
  // service's own methods (the service holds every behavior: the held
  // invitation, the join-on-allow, the gate); the routes add nothing but
  // HTTP shapes. Device-token gated by the auth hook like every non-/ask
  // route — consent is the owner's act, never an asker's. A daemon with no
  // workspace configured reads these as empty state and refuses the POSTs:
  // there is no connection to join or leave through.
  app.get("/workspace/invites", async () => ({ invites: deps.workspace?.pendingInvites() ?? [] }));

  app.get("/workspace/rooms", async () => ({ rooms: deps.workspace?.consentedRooms() ?? [] }));

  app.post<{ Params: { roomId: string } }>("/workspace/invites/:roomId/allow", async (request, reply) => {
    const workspace = deps.workspace;
    if (workspace === undefined) {
      reply.code(503).send(errorBody("workspace_not_configured", "Allowing a room invitation needs the workspace connection; this daemon has no workspace configured."));
      return;
    }
    try {
      return await workspace.allowInvite(request.params.roomId);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.post<{ Params: { roomId: string } }>("/workspace/invites/:roomId/refuse", async (request, reply) => {
    const workspace = deps.workspace;
    if (workspace === undefined) {
      reply.code(503).send(errorBody("workspace_not_configured", "Refusing a room invitation needs the workspace connection; this daemon has no workspace configured."));
      return;
    }
    try {
      await workspace.refuseInvite(request.params.roomId);
      // 204, not 200-with-body: a refusal that landed has nothing left to
      // say — no held invitation, no standing record (the executed exit
      // deleted it). What remains is a fresh GET /workspace/invites.
      reply.code(204).send();
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  app.post<{ Params: { roomId: string } }>("/workspace/rooms/:roomId/withdraw", async (request, reply) => {
    const workspace = deps.workspace;
    if (workspace === undefined) {
      reply.code(503).send(errorBody("workspace_not_configured", "Withdrawing room consent needs the workspace connection; this daemon has no workspace configured."));
      return;
    }
    try {
      return await workspace.withdrawRoom(request.params.roomId);
    } catch (error) {
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
      // #233: the Matrix session the daemon minted for this duo's owner must not outlive the device.
      deps.workspaceSession?.end();
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
    // guangshinhaha/duo#261: a draft held for a scheduled send is decided —
    // the owner approved it — so it is not waiting on them any more. It
    // stays `outcome IS NULL` in the log until it fires, so it is left out
    // here and listed under GET /scheduled-sends instead.
    if (outcome === "pending") {
      const held = scheduledSends.heldDraftIds();
      return held.size === 0 ? drafts : drafts.filter((draft) => !held.has(draft.id));
    }
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
  app.post<{ Body: { question: string; threadContext?: string | null; recipient?: unknown } }>("/drafts", async (request, reply) => {
    const { question, threadContext } = request.body;
    if (!question) {
      reply.code(400).send(errorBody("bad_request", "question is required"));
      return;
    }
    // duo#262: optional — who the reply is for, so the draft can be tuned to
    // how the owner writes to them and the eventual send teaches that.
    let recipient: DraftRecipient | undefined;
    try {
      recipient = parseDraftRecipient(request.body.recipient);
    } catch (error) {
      if (!(error instanceof BadRequestError)) {
        throw error;
      }
      reply.code(400).send(errorBody("bad_request", error.message));
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
      undefined, // no clearance ceiling: the owner's own draft
      undefined, // no attachments on this path
      recipient,
      // guangshinhaha/duo#257: the owner chooses between candidates here,
      // so a hedged draft comes with its alternatives.
      { offerAlternatives: true },
    );
    // 201, not 202: this is synchronous (see the comment above) and a
    // draft-log row now exists either way (draftReply always writes
    // exactly one row, draft or escalation) — there is nothing pending.
    // Same-tick draft-ready push (#162): both pipeline outcomes leave a row
    // the owner can act on, so both are announced.
    reply.code(201);
    draftReady.publish(result.draftId);
    // digital-duo#251: every self-asked draft is something the owner
    // decides (Keep/Edit/Dismiss), unlike a public answer that may resolve
    // on its own (see the `answerPublicly` call sites below, which push
    // only its escalations) — so this one always fires. Never awaited,
    // exactly like `draftReady.publish` above: a push failing must not
    // slow or cost the response this route already has.
    void notifyDraftWaiting(deps, result.draftId, deps.pushSender);
    return result;
  });

  // #263: polishes the OWNER'S OWN typed composer text — never a duo-
  // generated draft, which already has `/drafts` for regeneration. Owner-
  // only by the same table-separation the inventory test above pins: an
  // ask token is simply absent from device_tokens, so it never reaches
  // this handler at all.
  app.post<{ Body: { text?: unknown; instruction?: unknown } }>("/compose/rewrite", async (request, reply) => {
    const { text, instruction } = request.body ?? {};
    if (typeof text !== "string" || text.trim().length === 0) {
      reply.code(400).send(errorBody("bad_request", "text is required"));
      return;
    }
    if (typeof instruction !== "string" || !REWRITE_INSTRUCTIONS.includes(instruction as RewriteInstruction)) {
      reply.code(400).send(errorBody("bad_request", `instruction must be one of: ${REWRITE_INSTRUCTIONS.join(", ")}`));
      return;
    }
    try {
      const result = await rewriteOwnerText(text, instruction as RewriteInstruction, readVoiceText(deps.duoDir), deps.inferenceProvider);
      return result;
    } catch (error) {
      if (error instanceof RewriteUnavailableError) {
        reply.code(503).send(errorBody("rewrite_unavailable", error.message));
        return;
      }
      throw error;
    }
  });

  // #264: a quiet, conservative check of the owner's own typed composer
  // text against what the corpus already knows — see fact-check.ts's own
  // doc comment for the full conservatism case. Synchronous like
  // POST /drafts above, for the same reason: with no configured provider
  // this returns instantly (`{ flag: null }`), and with one it is a
  // single completion call, not a sampling loop.
  app.post<{ Body: { text?: unknown; threadContext?: unknown } }>("/compose/fact-check", async (request, reply) => {
    const { text, threadContext } = request.body ?? {};
    if (typeof text !== "string") {
      reply.code(400).send(errorBody("bad_request", "text is required"));
      return;
    }
    const result = await checkOwnerText(
      deps.storePath,
      deps.passphrase,
      deps.duoDir,
      text,
      typeof threadContext === "string" ? threadContext : null,
      deps.embeddingProvider,
      deps.inferenceProvider,
    );
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
        undefined, // no attachments on this path
        // digital-duo#251: someone asked through an ask link while the
        // owner was away — exactly the "a draft is waiting" push exists for.
        (draftId) => void notifyDraftWaiting(deps, draftId, deps.pushSender),
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
      reply.code(500).send(errorBody("internal_error", PUBLIC_ANSWER_FAILED_MESSAGE));
      return;
    }
  });

  app.post<{ Params: { id: string }; Body: { outcome: string; sentText?: string; dismissReason?: string; alternative?: unknown } }>("/drafts/:id/outcome", async (request, reply) => {
    const { outcome, sentText, dismissReason, alternative } = request.body;
    // SETTABLE_DRAFT_OUTCOMES, not the full DRAFT_OUTCOMES: this is the
    // generic outcome-setting route, and escalation_answered must only
    // ever be written by standing-order-candidates.ts's own atomic call —
    // never by a caller here, for any draft, escalated or not.
    if (!SETTABLE_DRAFT_OUTCOMES.includes(outcome as SettableDraftOutcome)) {
      reply.code(400).send(errorBody("bad_request", `outcome must be one of: ${SETTABLE_DRAFT_OUTCOMES.join(", ")}`));
      return;
    }
    // #259 in guangshinhaha/duo: an optional, one-tap reason for a
    // "discarded" draft. Validated here, the same way `outcome` itself is
    // validated here — an unrecognized string is a 400, not a value that
    // reaches storage. Whether it's paired with the right outcome
    // ("discarded") is checked one layer in, by recordOutcomeAndDeliver via
    // recordDraftOutcomeAndClassify, the same place the blank-"edited"
    // check already lives.
    if (dismissReason !== undefined && !DISMISS_REASONS.includes(dismissReason as DismissReason)) {
      reply.code(400).send(errorBody("bad_request", `dismissReason must be one of: ${DISMISS_REASONS.join(", ")}`));
      return;
    }
    // guangshinhaha/duo#257: which of a draft's alternatives was sent or
    // kept. Optional; whether the draft HAS that alternative is the
    // draft log's to say (UnknownAlternativeError, a 400).
    if (alternative !== undefined && !isAlternativeIndex(alternative)) {
      reply.code(400).send(errorBody("bad_request", "alternative must be a non-negative integer"));
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
        dismissReason: dismissReason as DismissReason | undefined,
        alternative,
      });
      // guangshinhaha/duo#261: deciding a held draft here, now, overrides
      // its schedule — release the hold so it never shows as still to come.
      if (scheduledSends.heldDraftIds().has(request.params.id)) {
        settleScheduledSend(deps.storePath, deps.passphrase, request.params.id, "superseded", "decided directly before its scheduled time");
        scheduledSends.rearm();
      }
      return result ?? {};
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  // guangshinhaha/duo#258: regenerate one candidate of a pending draft
  // with a tone/length instruction, over the sources it already cites (no
  // fresh retrieval — see shapeDraft). Synchronous like POST /drafts: one
  // model call. Returns the updated draft, whose `shapes` names the shape
  // just applied; the tap itself is logged as a training signal.
  app.post<{ Params: { id: string }; Body: { instruction?: unknown; alternative?: unknown } | undefined }>("/drafts/:id/shape", async (request, reply) => {
    const { instruction, alternative } = request.body ?? {};
    if (typeof instruction !== "string" || !SHAPE_INSTRUCTIONS.includes(instruction as ShapeInstruction)) {
      reply.code(400).send(errorBody("bad_request", `instruction must be one of: ${SHAPE_INSTRUCTIONS.join(", ")}`));
      return;
    }
    if (alternative !== undefined && !isAlternativeIndex(alternative)) {
      reply.code(400).send(errorBody("bad_request", "alternative must be a non-negative integer"));
      return;
    }
    try {
      const updated = await shapeDraft(
        deps.storePath,
        deps.passphrase,
        deps.duoDir,
        request.params.id,
        instruction as ShapeInstruction,
        alternative ?? 0,
        deps.inferenceProvider,
      );
      // No draft-ready push: that channel announces a draft *arriving*
      // (the client notifies on it), and a reshaped draft is not news.
      return updated;
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  // guangshinhaha/duo#258: the one-tap undo — puts back the text the latest
  // standing shape on that candidate replaced. The shape stays logged,
  // marked undone: taking one back is a signal too.
  app.post<{ Params: { id: string }; Body: { alternative?: unknown } | undefined }>("/drafts/:id/shape/undo", async (request, reply) => {
    const { alternative } = request.body ?? {};
    if (alternative !== undefined && !isAlternativeIndex(alternative)) {
      reply.code(400).send(errorBody("bad_request", "alternative must be a non-negative integer"));
      return;
    }
    try {
      return undoLatestShape(deps.storePath, deps.passphrase, request.params.id, alternative ?? 0);
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

  // #166: /review lists the whole review queue, not just #37's draft-edit
  // half — an answered escalation's standing-order candidate (#34) is a
  // correction candidate too, and this route is the one surface the client
  // reads, so it must be where the owner finds it. Rows keep the wire shape
  // this route has always served — sentText, and a string draftText (empty
  // for an escalation, which had no confident draft to edit) — plus the
  // additive `source` saying which of the two queues a row came from; the
  // client's Review screen diffs draftText against sentText, so a null
  // draft would break it. listReviewCandidates is the same read `duo
  // corrections review` serves the CLI from — one code path, two surfaces.
  app.get<{ Querystring: { status?: string } }>("/review", async (request) => {
    // `?status=` (empty) normalizes to "no filter" — the reading the
    // corrections-only route always gave it, now applied to both halves of
    // the merge rather than only the corrections half. Any other unknown
    // value filters to an empty list from both halves, as before.
    const status = (request.query.status || undefined) as CorrectionCandidateStatus | undefined;
    return listReviewCandidates(deps.storePath, deps.passphrase, status).map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      source: candidate.source,
      draftId: candidate.draftId,
      question: candidate.question,
      draftText: candidate.draftText ?? "",
      sentText: candidate.proposedText,
      status: candidate.status,
      createdAt: candidate.createdAt,
      reviewedAt: candidate.reviewedAt,
    }));
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

  // #181: lifecycle and handover, over HTTP — "instantly killable" is a
  // stated product principle (concept.md §11), and a kill switch reachable
  // only from the machine running the daemon is weaker than the principle
  // reads. GET is the state a client needs to show it (the lifecycle
  // record plus every transfer's state, both the CLI's own reads,
  // verbatim); POST /lifecycle/end is the kill switch itself.
  app.get("/lifecycle", async () => ({ lifecycle: readLifecycle(deps.duoDir), transfers: listTransfers(deps.duoDir) }));

  // The end, with the same two protections the CLI command carries: it
  // only describes what would go until `confirmed` is true (`duo lifecycle
  // end`'s own --yes), and it names who decided it. The deletion and its
  // audit event are one module call (endDuoAndRecord) — the same two
  // steps, in the same order, `duo lifecycle end` runs. After a confirmed
  // end the whole token cache is dropped: every token lived in the store
  // that just got deleted, so the next request from any cached client is
  // a clean 401 from the auth hook rather than a 500 from a missing file.
  app.post<{ Body: { decidedBy?: unknown; confirmed?: unknown } }>("/lifecycle/end", async (request, reply) => {
    const { decidedBy, confirmed } = request.body ?? {};
    if (typeof decidedBy !== "string" || decidedBy.trim().length === 0) {
      reply.code(400).send(errorBody("bad_request", "Ending a duo requires naming who decided it (decidedBy, a non-empty string)."));
      return;
    }
    const result = endDuoAndRecord(deps.storePath, deps.duoDir, deps.lifecycleLogPath, decidedBy, confirmed === true);
    if (result.confirmed) {
      auth.evictAll();
      deps.workspaceSession?.end();
    }
    return result;
  });

  // #176: the pasted-history import, from a client. The body carries the
  // transcript TEXT itself (file upload of arbitrary documents is out of
  // scope by the issue's own line), and it goes down the exact path `duo
  // import paste` runs: the module function owns the parse, the
  // work-relevance gate (and its zero summary), and the two-phase ingest —
  // the route adds no import behaviour of its own, and invents no dedupe
  // rule: a second import of the same text does exactly what the CLI's
  // second import does, because the only dedupe that exists
  // (ingestRecords' alreadyPresent) already lives in the shared module.
  app.post<{ Body: { transcript?: unknown } }>("/corpus/import-paste", async (request, reply) => {
    const body = request.body;
    const transcript = typeof body === "object" && body !== null ? body.transcript : undefined;
    if (typeof transcript !== "string" || transcript.trim().length === 0) {
      reply.code(400).send(errorBody("bad_request", "transcript is required and must be a non-empty string"));
      return;
    }
    try {
      return importPastedTranscript(deps.storePath, deps.passphrase, transcript, deps.classificationCeiling);
    } catch (error) {
      reply.code(statusForError(error as Error)).send(errorBody((error as Error).name, (error as Error).message));
    }
  });

  // #176: embedding, triggered and watched from a client. Embedding a real
  // corpus is minutes of provider round-trips — not a request-response
  // shape — so POST starts the daemon's one embed job and answers 202 with
  // its starting status, and GET reports progress. The job is process-bound
  // runtime state (like the draft-ready hub; no CLI twin — `duo embed`
  // remains the terminal's own direct run) driving the same embedRecords in
  // batches, so the count climbs observably and each step is persisted
  // before the next begins.
  app.post("/corpus/embed", async (request, reply) => {
    if (!embedJob.start(deps.storePath, deps.passphrase, deps.embeddingProvider)) {
      reply.code(409).send(errorBody("embed_already_running", "An embed is already running for this corpus; watch GET /corpus/embed for its progress."));
      return;
    }
    reply.code(202);
    return embedJob.current();
  });

  app.get("/corpus/embed", async () => embedJob.current());

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
/**
 * #233: the signed-in app's Matrix session. The device-token auth hook above has already verified the
 * caller against THIS duo's store (with its 5 second cache, same-tick revoke eviction and per-address
 * failure limiter), so there is no lookup, no scan of other duos, and no way for a request field to name
 * an account: the duo is the app the request was mounted on. Only a device token gets here (an ask link
 * is refused by the hook on every route but `/ask`).
 *
 * Encapsulated in its own scope so the body parser below applies to these two routes alone. The body is
 * ignored by contract, so a client that sends `Content-Type: application/json` with no body (or any body)
 * must not get Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` 400.
 */
function registerWorkspaceSessionRoutes(app: FastifyInstance, deps: ServeDeps): void {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));

    scope.post("/workspace/session", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const access = deps.workspaceSession;
      if (request.principal?.kind !== "device") {
        reply.code(401).send(errorBody("unauthorized", "Sign in to get a workspace session."));
        return;
      }
      if (!access) {
        reply.code(404).send(errorBody("workspace_not_configured", "This server has no workspace to sign in to."));
        return;
      }
      const outcome = await access.session();
      if (outcome.status === "ok") {
        return outcome.session;
      }
      reply.header("retry-after", "60");
      if (outcome.status === "pending") {
        reply.code(503).send(errorBody("workspace_pending", "Your workspace account is still being set up. Try again in a minute."));
      } else {
        reply.code(503).send(errorBody("workspace_unavailable", "The workspace is unreachable right now. Try again in a minute."));
      }
    });

    // The client's answer to Matrix's `M_UNKNOWN_TOKEN` (it signed out, or Synapse dropped the token): forget
    // the token so the next POST mints a new one. 204 whether or not one was cached or the cooldown held it.
    scope.delete("/workspace/session", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (request.principal?.kind !== "device") {
        reply.code(401).send(errorBody("unauthorized", "Sign in to end a workspace session."));
        return;
      }
      if (!deps.workspaceSession) {
        reply.code(404).send(errorBody("workspace_not_configured", "This server has no workspace to sign in to."));
        return;
      }
      await deps.workspaceSession.renew();
      reply.code(204).send();
    });
  });
}

/**
 * `serverFactory` lets hosted mode (src/hosted/) give each duo its own
 * never-listening HTTP server that a front dispatches requests and upgrades
 * into — one isolated app per duo, unchanged, in one process.
 */
export function createServer(deps: ServeDeps, options: { serverFactory?: FastifyServerFactory } = {}): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: deps.trustProxy ?? false, ...(options.serverFactory ? { serverFactory: options.serverFactory } : {}) });
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
    // Not CORS-safelisted, so a browser page cannot read it otherwise: the workspace-session route's 503s carry it (#233).
    exposedHeaders: ["Retry-After"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  const auth = registerAuth(app, deps.storePath, deps.passphrase);
  const draftReady = registerDraftReadySocket(app, deps);
  const embedJob = jobsFor(deps).embed;
  // guangshinhaha/duo#261: held sends fire from the daemon, whether or not
  // any client is connected. One runner per duo app, stopped with it.
  const scheduledSends = new ScheduledSendRunner({
    storePath: deps.storePath,
    passphrase: deps.passphrase,
    channelAdapters: () => deps.channelAdapters,
    classifier: () => (deps.inferenceProvider ? createLlmEditClassifier(deps.inferenceProvider) : undefined),
  });
  scheduledSends.start();
  app.addHook("onClose", async () => scheduledSends.stop());
  registerRoutes(app, deps, draftReady, auth, embedJob, scheduledSends);
  registerOwnerRoutes(app, deps);
  registerScheduledSendRoutes(app, deps, scheduledSends);
  // guangshinhaha/duo#266/#268: earned autonomy and its undo window. The
  // hold rides the same runner as a scheduled send.
  registerAutonomyRoutes(app, deps, scheduledSends);
  registerWorkspaceSessionRoutes(app, deps);
  if (deps.orgAdmin) {
    registerOrgRoutes(app, deps.orgAdmin);
  }
  registerMcpRoutes(app, deps);
  return app;
}
