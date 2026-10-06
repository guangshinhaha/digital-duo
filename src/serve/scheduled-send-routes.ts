import type { FastifyInstance, FastifyReply } from "fastify";
import { getDraft } from "../drafting/draft-log.js";
import {
  cancelScheduledSend,
  listScheduledSends,
  nextWorkingHoursStart,
  parseWorkingHours,
  readWorkingHours,
  scheduleSend,
  writeWorkingHours,
  type ScheduledOutcome,
} from "../drafting/scheduled-sends.js";
import type { ScheduledSendRunner } from "./scheduled-send-runner.js";
import type { ServeDeps } from "./server.js";

function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ error: { code, message } });
}

function statusFor(error: Error): number | undefined {
  switch (error.name) {
    case "DraftNotFoundError":
    case "ScheduledSendNotFoundError":
      return 404;
    case "DraftAlreadySettledError":
    case "DraftAlreadyScheduledError":
      return 409;
    case "InvalidScheduleError":
    case "InvalidWorkingHoursError":
      return 400;
    default:
      return undefined;
  }
}

/** Maps a domain error to its status and passes its message through; anything else is rethrown as a 500. */
function replyWithError(reply: FastifyReply, error: unknown): void {
  const status = error instanceof Error ? statusFor(error) : undefined;
  if (status === undefined) {
    throw error;
  }
  sendError(reply, status, (error as Error).name, (error as Error).message);
}

/**
 * Scheduled send (guangshinhaha/duo#261) over HTTP: hold an approved draft
 * for later, list what is held, take one back, and the working-hours setting
 * "start of their working hours" resolves against. Owner-only like every
 * route but `/ask` (serve/auth.ts refuses an ask token here).
 */
export function registerScheduledSendRoutes(app: FastifyInstance, deps: ServeDeps, runner: ScheduledSendRunner): void {
  // Every held send, soonest first, each with its draft — so the client can
  // show a Scheduled list without the draft also sitting in Waiting on you
  // (GET /drafts?outcome=pending leaves held drafts out).
  // guangshinhaha/duo#268: an autonomous send's undo window shares the
  // table but is not something the owner scheduled — it is listed under
  // GET /autonomous-sends, with Stop/Edit, and left out here.
  app.get("/scheduled-sends", async () =>
    listScheduledSends(deps.storePath, deps.passphrase).filter((send) => !send.autonomous).flatMap((send) => {
      const draft = getDraft(deps.storePath, deps.passphrase, send.draftId);
      return draft ? [{ ...send, draft }] : [];
    }),
  );

  // Body: { outcome?: "sent" | "edited", sentText?, sendAt?: ISO } or { at: "working-hours" } in place of sendAt.
  app.post<{ Params: { id: string }; Body: { outcome?: unknown; sentText?: unknown; sendAt?: unknown; at?: unknown } | undefined }>(
    "/drafts/:id/schedule",
    async (request, reply) => {
      const body = request.body ?? {};
      const outcome = body.outcome ?? "sent";
      if (outcome !== "sent" && outcome !== "edited") {
        sendError(reply, 400, "bad_request", 'outcome must be "sent" or "edited"');
        return;
      }
      if (body.sentText !== undefined && typeof body.sentText !== "string") {
        sendError(reply, 400, "bad_request", "sentText, when present, must be a string");
        return;
      }
      let sendAt: Date;
      if (body.at === "working-hours") {
        sendAt = nextWorkingHoursStart(new Date(), readWorkingHours(deps.storePath, deps.passphrase, deps.env));
      } else if (body.at !== undefined) {
        sendError(reply, 400, "bad_request", 'at, when present, must be "working-hours"');
        return;
      } else if (typeof body.sendAt === "string" && body.sendAt.trim().length > 0) {
        sendAt = new Date(body.sendAt);
      } else {
        sendError(reply, 400, "bad_request", 'sendAt (an ISO-8601 time) or at: "working-hours" is required');
        return;
      }
      try {
        const scheduled = scheduleSend(deps.storePath, deps.passphrase, request.params.id, {
          outcome: outcome as ScheduledOutcome,
          sentText: body.sentText as string | undefined,
          sendAt,
        });
        runner.rearm();
        reply.code(201);
        return scheduled;
      } catch (error) {
        replyWithError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/drafts/:id/schedule", async (request, reply) => {
    try {
      cancelScheduledSend(deps.storePath, deps.passphrase, request.params.id);
      runner.rearm();
      reply.code(204).send();
    } catch (error) {
      replyWithError(reply, error);
    }
  });

  // The setting "start of their working hours" resolves against, plus when
  // that next is — so a Send-later menu can say the time before it is picked.
  app.get("/settings/working-hours", async () => {
    const hours = readWorkingHours(deps.storePath, deps.passphrase, deps.env);
    return { ...hours, nextStart: nextWorkingHoursStart(new Date(), hours).toISOString() };
  });

  app.put<{ Body: { start?: unknown; end?: unknown; timezone?: unknown; days?: unknown } | undefined }>(
    "/settings/working-hours",
    async (request, reply) => {
      try {
        const hours = parseWorkingHours(request.body ?? {});
        writeWorkingHours(deps.storePath, deps.passphrase, hours);
        return { ...hours, nextStart: nextWorkingHoursStart(new Date(), hours).toISOString() };
      } catch (error) {
        replyWithError(reply, error);
      }
    },
  );
}
