import { attachmentGroundingDoor } from "../drafting/attachment-grounding.js";
import { parseClassificationCeiling } from "../permissions/classification.js";
import { answeringPausedOutcome, answerPublicly, workspaceDeclineNotice } from "../permissions/public-answer.js";
import { notifyDraftWaiting } from "../push/notify.js";
import { askerContextForSender } from "../workspace/asker.js";
import type { WorkspaceSettings } from "../workspace/settings.js";
import { WorkspaceService } from "../workspace/service.js";
import type { WorkspaceQuestion, WorkspaceTransportFactory } from "../workspace/transport.js";
import type { DraftProvenance } from "../drafting/draft-log.js";
import { durableDuoReadState } from "./workspace-read-state.js";
import type { ServeDeps } from "./server.js";

/** What one duo's workspace connection needs of the duo itself: its own store, folder, providers and owner. */
export type DuoWorkspaceInputs = Pick<
  ServeDeps,
  | "storePath"
  | "passphrase"
  | "duoDir"
  | "embeddingProvider"
  | "inferenceProvider"
  | "confidenceConfig"
  | "classificationCeiling"
  | "ownerName"
  // digital-duo#251: env carries DUO_PUSH_VAPID_SUBJECT, pushSender is the
  // injectable transport — both already required/optional on ServeDeps, so
  // every existing caller that builds one already has them.
  | "env"
  | "pushSender"
  // duo#318: whether this duo may currently answer colleagues — undefined on a personal duo,
  // which answers exactly as before this existed.
  | "verification"
>;

export interface DuoWorkspaceServiceOptions {
  readonly settings: WorkspaceSettings;
  readonly transportFactory: WorkspaceTransportFactory;
  /** One line per event. A hosted duo's connection passes a logger that names the duo; `duo serve` leaves it out (console.error, as before). */
  readonly log?: (line: string) => void;
  /** What to say when the homeserver refuses the token for good. Default: the single-owner remedy. */
  readonly revokedRemedy?: string;
}

/**
 * Builds the workspace service for ONE duo over that duo's own store: the wiring `duo serve` has
 * always done (#186-#192), lifted out so a hosted duo (#236) gets exactly the same service and
 * the same answering pipeline, argument for argument, over its own store and folder. Nothing
 * here is shared between two duos: the read state, consent record, answer log and the member
 * cache all hang off the `duo` passed in.
 */
export function createDuoWorkspaceService(duo: DuoWorkspaceInputs, options: DuoWorkspaceServiceOptions): WorkspaceService {
  const { settings } = options;
  // Annotated, not inferred: the answer closure below reaches back into
  // `workspace` for the member cache (the #187 feed), and a self-referencing
  // initializer is exactly the shape TS refuses to infer through.
  const workspace: WorkspaceService = new WorkspaceService({
    settings,
    transportFactory: options.transportFactory,
    log: options.log,
    revokedRemedy: options.revokedRemedy,
    // #189: durable read state in the same encrypted store the answers
    // themselves log to — which events previous processes handled, so a
    // restart no longer re-answers the sync window. The impl lives in
    // src/serve/ (the workspace boundary scan forbids the store import
    // there); its retention is the backlog age window, one concept.
    readState: durableDuoReadState(duo.storePath, duo.passphrase, settings.backlog.maxAgeMs, options.log),
    // #192: the consent surface — held invitations, the shared-room
    // gate, allow/refuse/withdrawal — over the same `duo/` directory
    // every other owner policy lives in (consent.ts states why a file
    // and not the store). Wired whenever a workspace exists at all, so
    // the owner surface is never half-configured.
    // guangshinhaha/duo#315: a declined first message tells the colleague,
    // politely, in fixed words naming the owner.
    consent: { duoDir: duo.duoDir, declineNotice: workspaceDeclineNotice(duo.ownerName) },
    // #190: the attachment grounding door, wired with the owner's own
    // classification ceiling — the same parsed value every ingest
    // boundary reads, because this is the same policy applied at a
    // different door. Parsed here, at wiring, in the boot-refusal
    // family: a workspace-configured daemon with an unparseable
    // DUO_CLASSIFICATION_CEILING must not come up guessing what a door
    // should admit (every other surface already fails the same value
    // at its own point of use).
    attachmentDoor: attachmentGroundingDoor(parseClassificationCeiling(duo.classificationCeiling)),
    // THE answering pipeline, not a workspace twin: the identical
    // answerPublicly call POST /ask makes, argument for argument, with
    // the asking Matrix user resolved through the same directory
    // lookup. A question over the workspace connection and a question
    // over an ask link cannot diverge, because this is one call.
    answer: (question) => {
      // duo#318: a workspace question is always a colleague's (the owner's own loop never goes
      // through this pipeline) — checked before `answerPublicly` runs at all, same as `POST /ask`'s
      // ask-link branch, so a paused duo leaves no draft behind.
      if (duo.verification?.status().answeringEnabled === false) {
        return Promise.resolve(answeringPausedOutcome());
      }
      return answerPublicly(
        duo.storePath,
        duo.passphrase,
        duo.duoDir,
        // POST /ask hands answerPublicly a trimmed question; a chat
        // client's body can carry trailing whitespace. The trim keeps
        // "argument for argument" true (the body itself is non-blank —
        // directQuestionFrom already rejected whitespace-only).
        question.body.trim(),
        // #187's feed: the sender's workspace member record when the
        // daemon's connect-time listing has one, through the same
        // resolver either way (asker.ts — the member is the mapping's
        // input, never a second resolution path).
        askerContextForSender(question.senderId, duo.duoDir, workspace.memberFor(question.senderId)),
        duo.embeddingProvider,
        duo.inferenceProvider,
        duo.confidenceConfig,
        duo.ownerName,
        // #190: what the door admitted — the asker's files, decoded
        // and marking-stripped, grounding this one draft call. The
        // door refused, or the question rode with nothing, and this is
        // undefined — the pre-#190 call shape, byte-identical.
        question.grounding,
        // digital-duo#251: a workspace message arrived while the owner
        // was away — the epic's own headline case for a push.
        (draftId) => void notifyDraftWaiting(duo, draftId, duo.pushSender),
        // guangshinhaha/duo#314: whose question, from which conversation —
        // so a passed-on question reaches the owner with where to answer it.
        workspaceDraftProvenance(question),
      );
    },
  });
  return workspace;
}

/**
 * The channel kind a workspace conversation's drafts carry. No delivery
 * adapter owns it: the duo never posts the owner's words — the owner
 * answers from their own workspace account, and the client records that it
 * did (`ownerDelivered` on POST /drafts/:id/outcome).
 */
export const WORKSPACE_CHANNEL_KIND = "workspace";

/**
 * guangshinhaha/duo#314: a workspace question's draft provenance — the
 * asker's Matrix user id, the room as the thread, and the question's own
 * `matrix.to` permalink (the spec's address for a room and an event, which
 * the client already reads to find a draft's conversation). Pure, so the
 * shape is pinned by test without a connection.
 */
export function workspaceDraftProvenance(question: Pick<WorkspaceQuestion, "roomId" | "eventId" | "senderId">): DraftProvenance {
  return {
    origin: "channel",
    channelKind: WORKSPACE_CHANNEL_KIND,
    askerRef: question.senderId,
    threadId: question.roomId,
    permalink: `https://matrix.to/#/${encodeURIComponent(question.roomId)}/${encodeURIComponent(question.eventId)}`,
  };
}
