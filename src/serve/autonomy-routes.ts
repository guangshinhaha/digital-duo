import type { FastifyInstance, FastifyReply } from "fastify";
import { considerAutonomousSend, listAutonomousHolds, stopAutonomousHoldsFor, type AutonomousSendDecision } from "../drafting/autonomous-send.js";
import { getDraft } from "../drafting/draft-log.js";
import { stopAutonomousSend } from "../drafting/scheduled-sends.js";
import { notifyDraftWaiting } from "../push/notify.js";
import {
  acceptAutonomyOffer,
  declineAutonomyOffer,
  getAutonomyOffers,
  listAutonomyGrants,
  listTrackRecords,
  readAutonomySettings,
  revokeAutonomyGrant,
  writeAutonomySettings,
} from "../trust/recipient-autonomy.js";
import type { ScheduledSendRunner } from "./scheduled-send-runner.js";
import type { ServeDeps } from "./server.js";
import type { DraftReadyHub } from "./ws.js";

function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ error: { code, message } });
}

function statusFor(error: Error): number | undefined {
  switch (error.name) {
    case "NoPendingAutonomyOfferError":
    case "AutonomyGrantNotFoundError":
    case "ScheduledSendNotFoundError":
    case "DraftNotFoundError":
      return 404;
    case "InvalidAutonomySettingError":
      return 400;
    default:
      return undefined;
  }
}

function replyWithError(reply: FastifyReply, error: unknown): void {
  const status = error instanceof Error ? statusFor(error) : undefined;
  if (status === undefined) {
    throw error;
  }
  sendError(reply, status, (error as Error).name, (error as Error).message);
}

/**
 * What every serving-layer site that writes a new draft calls in place of
 * announcing it directly (guangshinhaha/duo#266/#268): if autonomy the owner
 * granted covers it, the draft is held for the undo window — the runner is
 * re-armed so it fires on time, and the owner is told it is about to go
 * (`kind: "autonomous_hold"`, so the notification can offer Stop/Edit);
 * otherwise it is announced as a draft waiting on them, exactly as before.
 * Either way the WebSocket hears about it, so an open client refreshes both
 * Waiting on you and the live strip. Never throws: a draft that cannot be
 * held (any refusal, any store error) stays a normal draft — the safe side.
 */
export function announceNewDraft(deps: ServeDeps, draftReady: DraftReadyHub, runner: ScheduledSendRunner, draftId: string): AutonomousSendDecision {
  let decision: AutonomousSendDecision;
  try {
    decision = considerAutonomousSend(deps.storePath, deps.passphrase, draftId);
  } catch {
    decision = { held: false, reason: "no_grant" };
  }
  draftReady.publish(draftId);
  if (decision.held) {
    runner.rearm();
    void notifyDraftWaiting(deps, draftId, deps.pushSender, { kind: "autonomous_hold", sendAt: decision.send.sendAt });
  } else {
    void notifyDraftWaiting(deps, draftId, deps.pushSender);
  }
  return decision;
}

/**
 * Earned autonomy (#266) and its undo window (#268) over HTTP. Owner-only,
 * like every route but `/ask`.
 */
export function registerAutonomyRoutes(app: FastifyInstance, deps: ServeDeps, runner: ScheduledSendRunner): void {
  // #266: offers the duo would make right now — computed fresh, reading changes nothing.
  app.get("/autonomy/offers", async () => getAutonomyOffers(deps.storePath, deps.passphrase));

  // Each person's track record — how close the duo is to asking, for a person's profile.
  app.get("/autonomy/track-records", async () => listTrackRecords(deps.storePath, deps.passphrase));

  app.post<{ Params: { recipientKey: string } }>("/autonomy/offers/:recipientKey/accept", async (request, reply) => {
    try {
      reply.code(201);
      return acceptAutonomyOffer(deps.storePath, deps.passphrase, request.params.recipientKey);
    } catch (error) {
      replyWithError(reply, error);
    }
  });

  app.post<{ Params: { recipientKey: string } }>("/autonomy/offers/:recipientKey/decline", async (request, reply) => {
    try {
      declineAutonomyOffer(deps.storePath, deps.passphrase, request.params.recipientKey);
      reply.code(204).send();
    } catch (error) {
      replyWithError(reply, error);
    }
  });

  // Standing grants, to review and revoke later.
  app.get("/autonomy/grants", async () => listAutonomyGrants(deps.storePath, deps.passphrase));

  // Revoking also stops any reply to that person still inside its window.
  // A POST like every other revoke here (/devices/:id/revoke, /connector/connections/:id/revoke).
  app.post<{ Params: { recipientKey: string } }>("/autonomy/grants/:recipientKey/revoke", async (request, reply) => {
    try {
      const grant = revokeAutonomyGrant(deps.storePath, deps.passphrase, request.params.recipientKey);
      const stopped = stopAutonomousHoldsFor(deps.storePath, deps.passphrase, request.params.recipientKey);
      if (stopped.length > 0) {
        runner.rearm();
      }
      return { ...grant, stoppedDraftIds: stopped };
    } catch (error) {
      replyWithError(reply, error);
    }
  });

  // #268: the undo window.
  app.get("/settings/autonomy", async () => readAutonomySettings(deps.storePath, deps.passphrase));

  app.put<{ Body: { holdSeconds?: unknown; confirmNoHold?: unknown } | undefined }>("/settings/autonomy", async (request, reply) => {
    try {
      return writeAutonomySettings(deps.storePath, deps.passphrase, request.body ?? {});
    } catch (error) {
      replyWithError(reply, error);
    }
  });

  // #268: what the duo is about to send by itself, each with its draft — the live strip in Waiting on you.
  app.get("/autonomous-sends", async () =>
    listAutonomousHolds(deps.storePath, deps.passphrase).flatMap((send) => {
      const draft = getDraft(deps.storePath, deps.passphrase, send.draftId);
      return draft ? [{ ...send, draft }] : [];
    }),
  );

  // Stop: nothing is posted; the draft waits on the owner again as a normal draft.
  // Edit: the same stop, answering with the draft so the client can open it in the editor.
  for (const action of ["stop", "edit"] as const) {
    app.post<{ Params: { id: string } }>(`/autonomous-sends/:id/${action}`, async (request, reply) => {
      try {
        stopAutonomousSend(deps.storePath, deps.passphrase, request.params.id);
        runner.rearm();
        return { draft: getDraft(deps.storePath, deps.passphrase, request.params.id) };
      } catch (error) {
        replyWithError(reply, error);
      }
    });
  }
}
