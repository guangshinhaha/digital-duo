import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createLlmEditClassifier } from "../corrections/classify.js";
import { listReviewCandidates } from "../corrections/review.js";
import { listRulesForReview } from "../derivation/rule-review.js";
import { recordOutcomeAndDeliver } from "../drafting/delivery.js";
import { DRAFT_OUTCOMES, getDraft, listDrafts, type DraftOutcome } from "../drafting/draft-log.js";
import { draftReply } from "../drafting/pipeline.js";
import { queueStandingOrderCandidate } from "../drafting/standing-order-candidates.js";
import { describeDuoKnowledge } from "../duo/knowledge-summary.js";
import { hybridSearch } from "../ingest/embeddings.js";
import { answerPublicly } from "../permissions/public-answer.js";
import { listPublicAnswerLogEntries } from "../permissions/public-answer-log.js";
import { correctPublicAnswer } from "../permissions/public-correction.js";
import { hasRefusalsDecision, readRefusalsFile } from "../trust/refusals.js";
import { jobsFor } from "./jobs.js";
import { SCOPE_INFO, type Scope } from "./scopes.js";
import type { ServeDeps } from "./server.js";

/** Who a tool call is for and what it may do: the duo the access token names, and the scopes the owner granted at sign-in. */
export interface ToolContext {
  readonly deps: ServeDeps;
  readonly scopes: ReadonlySet<Scope>;
}

const MAX_TEXT_CHARS = 700;
/** The most a waiting-items list returns, newest first. */
const MAX_LISTED = 25;

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function clip(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/**
 * Runs one tool call if the connection was given every scope it needs. The
 * refusal is the daemon's own and names each missing permission, so Claude can
 * tell the owner what to change; it does not depend on the tool having been
 * hidden in claude.ai. Any error a module raises reaches Claude as text: the
 * caller is the authenticated owner, so this is not an asker-facing surface.
 */
export async function guarded(ctx: ToolContext, needs: Scope | readonly Scope[], run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  const missing = ([] as Scope[]).concat(needs).filter((scope) => !ctx.scopes.has(scope));
  if (missing.length > 0) {
    const named = missing.map((scope) => `${SCOPE_INFO[scope].label} (${scope})`).join(" and ");
    return fail(
      `Not permitted: this connection was not given the ${named} permission${missing.length > 1 ? "s" : ""}. ` +
        `Disconnect Claude in your duo's Settings, connect it again, and allow ${missing.map((scope) => SCOPE_INFO[scope].label).join(" and ")} on the sign-in page.`,
    );
  }
  try {
    return await run();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const CHANGES_THE_DUO = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
/** A tool that can reach someone outside the duo. claude.ai reads this to ask before running it. */
const REACHES_OUTSIDE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/** What the owner's own question to their duo looks like to the answering pipeline: the owner, not a person on an ask link. */
const OWNER_ASKER = { ref: "owner", resolved: null, askLinkId: null } as const;

function draftView(draft: NonNullable<ReturnType<typeof getDraft>>) {
  return {
    id: draft.id,
    question: draft.question,
    draft: clip(draft.draftText),
    escalated: draft.escalated,
    escalationReason: draft.escalationReason,
    confidence: draft.confidenceScore,
    sources: draft.sources,
    createdAt: draft.createdAt,
    outcome: draft.outcome,
    sentText: clip(draft.sentText),
    origin: draft.provenance.origin,
    askedBy: draft.provenance.origin === "channel" ? draft.provenance.askerRef : null,
    delivery: draft.delivery,
  };
}

/** What actually happened to a settled draft's text, from the state recorded, not from what was hoped for. */
function deliveryNote(outcome: "sent" | "edited" | "discarded", draft: NonNullable<ReturnType<typeof getDraft>> | undefined): string {
  if (outcome === "discarded") {
    return "Nothing was sent.";
  }
  if (!draft || draft.provenance.origin !== "channel") {
    return "This question did not come from a channel, so nothing was delivered anywhere.";
  }
  const delivery = draft.delivery;
  if (delivery === null) {
    return "This question came from a channel, but no delivery was recorded.";
  }
  if (delivery.state === "failed") {
    return `This question came from a channel, and delivery failed: ${delivery.reason}. The outcome is recorded; nothing reached the channel.`;
  }
  return delivery.state === "delivered" ? "The text was delivered to the channel it came from." : "The text was handed to the channel it came from; delivery is pending.";
}

/** Records how the owner settled a draft, refusing one that is already settled so nothing is delivered twice. */
async function settleDraft(ctx: ToolContext, id: string, outcome: "sent" | "edited" | "discarded", sentText?: string): Promise<CallToolResult> {
  const { deps } = ctx;
  const draft = getDraft(deps.storePath, deps.passphrase, id);
  if (!draft) {
    return fail(`No draft with id "${id}".`);
  }
  if (draft.outcome !== null) {
    return fail(`This draft was already recorded as ${draft.outcome}, so nothing was changed and nothing was delivered again.`);
  }
  const classifier = deps.inferenceProvider ? createLlmEditClassifier(deps.inferenceProvider) : undefined;
  const result = await recordOutcomeAndDeliver(deps.storePath, deps.passphrase, id, outcome, sentText, { classifier, channelAdapters: deps.channelAdapters });
  const after = getDraft(deps.storePath, deps.passphrase, id);
  return ok({
    recorded: outcome,
    // Echoing the draft back shows what the duo wrote, so it is only done for a connection that may read.
    draft: after && ctx.scopes.has("duo:read") ? draftView(after) : undefined,
    ruleCandidatesQueued: result?.queuedKinds ?? [],
    note: deliveryNote(outcome, after),
  });
}

/** Registers every duo tool on a connection's MCP server. Each one checks the scope it needs when it is called. */
export function registerDuoTools(server: McpServer, ctx: ToolContext): void {
  const { deps } = ctx;
  const jobs = jobsFor(deps);

  // ---- duo:read -----------------------------------------------------------------------------------------------

  server.registerTool(
    "search_my_duo",
    {
      title: "Search my duo",
      description:
        "Search the user's Digital Duo, their private work memory, for records that match a question or topic. Use it to find what they have said, decided or worked on before answering from general knowledge.",
      inputSchema: { query: z.string().trim().min(1).describe("What to look for"), limit: z.number().int().min(1).max(20).optional().describe("How many matches, default 8") },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) =>
      guarded(ctx, "duo:read", async () => {
        const outcome = await hybridSearch(deps.storePath, deps.passphrase, query, deps.embeddingProvider, limit ?? 8, 0);
        return ok(JSON.parse(JSON.stringify(outcome, (_key, value) => (typeof value === "string" ? clip(value) : value))));
      }),
  );

  server.registerTool(
    "ask_my_duo",
    {
      title: "Ask my duo",
      description:
        "Ask the user's Digital Duo a question and get the answer it would give, with how sure it is and what it drew on. A question it cannot answer comes back as passed on to the user, not as a guess. This is the duo's own answer, so relay it as the duo's, not as yours. It leaves a record in the duo's answer log, and a passed-on question joins the user's queue.",
      inputSchema: { question: z.string().trim().min(1).describe("The question") },
      annotations: CHANGES_THE_DUO,
    },
    async ({ question }) =>
      guarded(ctx, ["duo:read", "duo:operate"], async () => {
        const outcome = await answerPublicly(
          deps.storePath,
          deps.passphrase,
          deps.duoDir,
          question,
          OWNER_ASKER,
          deps.embeddingProvider,
          deps.inferenceProvider,
          deps.confidenceConfig,
          deps.ownerName,
        );
        return ok({
          kind: outcome.kind,
          text: outcome.kind === "answered" ? outcome.text : outcome.message,
          sources: outcome.kind === "answered" ? outcome.sources : undefined,
          confidence: outcome.kind === "answered" ? outcome.confidence : undefined,
          evidenceAgeDays: outcome.kind === "answered" ? outcome.evidenceAgeDays : undefined,
          draftId: outcome.draftId,
          logEntryId: outcome.logEntryId,
          ownerNotice: outcome.kind === "passed_on" ? outcome.ownerNotice : undefined,
          note: "This is recorded in the duo's answer log; a question it passes on waits in the owner's queue.",
        });
      }),
  );

  server.registerTool(
    "what_my_duo_knows",
    {
      title: "What my duo knows",
      description: "Summarise what the user's Digital Duo holds: how many records, topics, rules and drafts, and how complete each part is.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(ctx, "duo:read", () =>
        ok(
          describeDuoKnowledge(
            deps.storePath,
            deps.passphrase,
            deps.duoDir,
            { inference: deps.inferenceProvider?.name ?? null, embedding: { name: deps.embeddingProvider.name, model: deps.embeddingProvider.model } },
            deps.env,
          ),
        ),
      ),
  );

  server.registerTool(
    "my_duo_rules",
    {
      title: "My duo's rules",
      description: "List the rules the user's Digital Duo has learned or been given, and the subjects it has been told to refuse.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(ctx, "duo:read", () =>
        ok({ rules: listRulesForReview(deps.storePath, deps.passphrase), refusals: { decided: hasRefusalsDecision(deps.duoDir), refusals: readRefusalsFile(deps.duoDir) } }),
      ),
  );

  server.registerTool(
    "my_duo_voice",
    {
      title: "My duo's voice",
      description: "Read the description of how the user writes, which their Digital Duo uses to draft in their voice.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(ctx, "duo:read", () => {
        const path = join(deps.duoDir, "voice.md");
        return ok(existsSync(path) ? { voice: readFileSync(path, "utf8") } : { voice: null, note: "No voice profile yet. Derive the duo first." });
      }),
  );

  server.registerTool(
    "duo_status",
    {
      title: "Duo status",
      description: "Report whether the user's Digital Duo is embedding or deriving right now, how far along each is, and which providers it uses.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(ctx, "duo:read", () =>
        ok({
          embed: jobs.embed.current(),
          derive: jobs.derive.current(),
          providers: { inference: deps.inferenceProvider?.name ?? null, embedding: `${deps.embeddingProvider.name}:${deps.embeddingProvider.model}` },
        }),
      ),
  );

  server.registerTool(
    "list_public_answers",
    {
      title: "List public answers",
      description: "List the answers the user's duo has given to other people, newest first. Each has an id that correct_public_answer takes.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many, default 15") },
      annotations: READ_ONLY,
    },
    async ({ limit }) =>
      guarded(ctx, "duo:read", () => ok(listPublicAnswerLogEntries(deps.storePath, deps.passphrase).slice(-(limit ?? 15)).reverse())),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List drafts",
      description: "List the replies the user's duo has drafted, newest first. Filter to pending (not yet dealt with) or by how they were settled.",
      inputSchema: {
        status: z.enum(["pending", ...DRAFT_OUTCOMES]).optional().describe("pending, sent, edited, discarded or escalation_answered"),
        limit: z.number().int().min(1).max(50).optional().describe("How many, default 15"),
      },
      annotations: READ_ONLY,
    },
    async ({ status, limit }) =>
      guarded(ctx, "duo:read", () => ok(listDrafts(deps.storePath, deps.passphrase, { outcome: status as DraftOutcome | "pending" | undefined, limit: limit ?? 15 }).map(draftView))),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Get a draft",
      description: "Read one drafted reply in full, with its confidence and sources.",
      inputSchema: { id: z.string().trim().min(1).describe("The draft id") },
      annotations: READ_ONLY,
    },
    async ({ id }) =>
      guarded(ctx, "duo:read", () => {
        const draft = getDraft(deps.storePath, deps.passphrase, id);
        return draft ? ok({ ...draftView(draft), draft: draft.draftText, sentText: draft.sentText }) : fail(`No draft with id "${id}".`);
      }),
  );

  server.registerTool(
    "list_escalations",
    {
      title: "What my duo passed to me",
      description:
        "List the questions the user's duo did not feel able to answer and passed on to them, that they have not dealt with yet. Answer one with answer_escalation.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(ctx, "duo:read", () => {
        const waiting = listDrafts(deps.storePath, deps.passphrase, { outcome: "pending" })
          .filter((draft) => draft.escalated)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, MAX_LISTED);
        return ok(waiting.length === 0 ? { waiting: [], note: "Nothing is waiting." } : { waiting: waiting.map(draftView) });
      }),
  );

  server.registerTool(
    "list_review_queue",
    {
      title: "List the review queue",
      description:
        "List the corrections and rule candidates waiting for the user's approval. Approving one changes what the duo will say on their behalf, so it can only be done in the Digital Duo app.",
      inputSchema: { status: z.enum(["pending", "approved", "rejected"]).optional().describe("Default pending") },
      annotations: READ_ONLY,
    },
    async ({ status }) =>
      guarded(ctx, "duo:read", () => {
        const candidates = listReviewCandidates(deps.storePath, deps.passphrase, status ?? "pending");
        return ok(
          candidates.length === 0
            ? { candidates: [], note: "Nothing is waiting for review." }
            : {
                candidates: candidates.map((candidate) => ({
                  id: candidate.id,
                  kind: candidate.kind,
                  source: candidate.source,
                  question: candidate.question,
                  proposed: clip(candidate.proposedText),
                  status: candidate.status,
                  createdAt: candidate.createdAt,
                })),
              },
        );
      }),
  );

  // ---- duo:operate ----------------------------------------------------------------------------------------------

  server.registerTool(
    "embed_my_duo",
    {
      title: "Embed my duo",
      description:
        "Start embedding the user's Digital Duo, which is what lets it search by meaning. It takes minutes. Check duo_status for progress. If one is already running, this says so instead of starting another.",
      inputSchema: {},
      annotations: CHANGES_THE_DUO,
    },
    async () =>
      guarded(ctx, "duo:operate", () => {
        const started = jobs.embed.start(deps.storePath, deps.passphrase, deps.embeddingProvider);
        return ok({ started, alreadyRunning: !started, embed: jobs.embed.current() });
      }),
  );

  server.registerTool(
    "derive_my_duo",
    {
      title: "Derive my duo",
      description:
        "Start building the user's Digital Duo's question-and-answer pairs, topics, rules and voice from what it holds. It takes minutes and is best run after embedding. Check duo_status for progress. It rewrites the duo's voice description, so a hand-edited voice file is overwritten.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () =>
      guarded(ctx, "duo:operate", () => {
        const started = jobs.derive.start({
          storePath: deps.storePath,
          passphrase: deps.passphrase,
          duoDir: deps.duoDir,
          embeddingProvider: deps.embeddingProvider,
          inferenceProvider: deps.inferenceProvider,
        });
        return ok({ started, alreadyRunning: !started, derive: jobs.derive.current() });
      }),
  );

  server.registerTool(
    "draft_reply",
    {
      title: "Draft a reply",
      description:
        "Have the user's Digital Duo draft a reply to a question, in their voice, with how confident it is and what it drew on. Nothing is sent. A question it has nothing to answer from comes back passed to the user, not as an invented draft.",
      inputSchema: {
        question: z.string().trim().min(1).describe("The question to reply to"),
        context: z.string().trim().optional().describe("The thread or situation the question came from"),
      },
      annotations: CHANGES_THE_DUO,
    },
    async ({ question, context }) =>
      guarded(ctx, ["duo:read", "duo:operate"], async () => {
        const result = await draftReply(deps.storePath, deps.passphrase, deps.duoDir, question, context ?? null, deps.embeddingProvider, deps.inferenceProvider, deps.confidenceConfig);
        return ok({ ...result, note: "Nothing was sent. Open the draft with get_draft, or settle it with edit_draft, mark_draft_sent or discard_draft." });
      }),
  );

  server.registerTool(
    "discard_draft",
    {
      title: "Discard a draft",
      description: "Record that the user threw a draft away. Nothing is sent.",
      inputSchema: { id: z.string().trim().min(1).describe("The draft id") },
      annotations: CHANGES_THE_DUO,
    },
    async ({ id }) => guarded(ctx, "duo:operate", () => settleDraft(ctx, id, "discarded")),
  );

  server.registerTool(
    "answer_escalation",
    {
      title: "Answer a question my duo passed on",
      description:
        "Give the user's answer to a question their duo passed on. The answer is queued as a rule candidate for the duo to follow next time; it is not applied until the user approves it in the Digital Duo app.",
      inputSchema: { id: z.string().trim().min(1).describe("The escalated draft's id, from list_escalations"), answer: z.string().trim().min(1).describe("The user's answer, in their own words") },
      annotations: CHANGES_THE_DUO,
    },
    async ({ id, answer }) =>
      guarded(ctx, "duo:operate", () => {
        const draft = getDraft(deps.storePath, deps.passphrase, id);
        if (draft?.outcome === "escalation_answered") {
          return fail("This question was already answered, so no second rule candidate was queued.");
        }
        const candidateId = queueStandingOrderCandidate(deps.storePath, deps.passphrase, id, answer);
        return ok({ candidateId, status: "pending", note: "Queued for the user's approval in the Digital Duo app. The duo's rules are unchanged until then." });
      }),
  );

  // ---- duo:send -------------------------------------------------------------------------------------------------

  server.registerTool(
    "edit_draft",
    {
      title: "Edit a draft (may send)",
      description:
        "Record the user's edited version of a draft as what they sent. The difference teaches the duo, as a rule candidate awaiting the user's approval. IMPORTANT: for a question that came from a channel this hands the edited text to that channel as the user (once a channel is connected; today none is), so only call it when they have said to send it.",
      inputSchema: { id: z.string().trim().min(1).describe("The draft id"), text: z.string().trim().min(1).describe("The user's final text") },
      annotations: REACHES_OUTSIDE,
    },
    async ({ id, text }) => guarded(ctx, "duo:send", () => settleDraft(ctx, id, "edited", text)),
  );

  server.registerTool(
    "mark_draft_sent",
    {
      title: "Mark a draft sent (may send)",
      description:
        "Record that the user sent a draft as written. IMPORTANT: for a question that came from a channel this hands the draft to that channel as the user (once a channel is connected; today none is), so only call it when they have said to send it.",
      inputSchema: { id: z.string().trim().min(1).describe("The draft id") },
      annotations: REACHES_OUTSIDE,
    },
    async ({ id }) => guarded(ctx, "duo:send", () => settleDraft(ctx, id, "sent")),
  );

  server.registerTool(
    "correct_public_answer",
    {
      title: "Correct a public answer",
      description:
        "Record a correction to an answer the user's duo already gave to someone, and lower the duo's autonomy on that topic at once so it checks with them next time. Only call it when the user has said what the right answer is. This records and demotes; it does not post anything or tell anyone, because no channel is connected to post to.",
      inputSchema: {
        entryId: z.string().trim().min(1).describe("The public answer's id, from list_public_answers or ask_my_duo"),
        correctedText: z.string().trim().min(1).describe("The correct answer, in the user's own words"),
      },
      annotations: CHANGES_THE_DUO,
    },
    async ({ entryId, correctedText }) =>
      guarded(ctx, "duo:operate", () => {
        const result = correctPublicAnswer(deps.storePath, deps.passphrase, deps.duoDir, entryId, correctedText, deps.ownerName);
        return ok({
          correctionEntryId: result.correctionEntryId,
          correctedTopicId: result.correctedTopicId,
          demotion: result.demotion,
          text: result.text,
          note: "Recorded, and the topic's autonomy lowered. Nothing was posted and no one was notified: no channel is connected to post to.",
        });
      }),
  );
}
