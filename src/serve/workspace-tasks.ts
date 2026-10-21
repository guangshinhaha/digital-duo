import { createCard, createTask, listCards, updateCardRevAndState, updateTaskState } from "../tasks/store.js";
import type { OpenWorkspaceCard, WorkspaceTaskSink } from "../workspace/service.js";

/**
 * W-S4-4/W-S4-5: the `WorkspaceTaskSink` implementation against
 * `src/tasks/store.ts` — the encrypted personal store. Lives in
 * `src/serve/`, not `src/workspace/`, for the same reason
 * `workspace-read-state.ts` does: the pinned import scan
 * (test/workspace-payload.test.ts) keeps `src/workspace/**` from reaching
 * into `src/tasks/` directly, so the store arrives at the service by
 * ordinary composition — `runServe`/`createDuoWorkspaceService` construct
 * this and hand it in as `taskSink`, and the service knows the interface
 * only.
 *
 * `payload_json` (the store's own column) holds nothing this function
 * reads back — the service tracks a card's rev/state itself via
 * `OpenWorkspaceCard` and builds the actual `duo.card` content through
 * `src/workspace/cards.ts`; this sink's `payloadJson` write is an empty
 * JSON object, kept only because the column is `NOT NULL` on the shared
 * table W-S5/S6/S7 will also use for cards this sink doesn't build.
 */
export function durableWorkspaceTaskSink(storePath: string, passphrase: string): WorkspaceTaskSink {
  return {
    createTask(input) {
      const task = createTask(storePath, passphrase, {
        roomId: input.roomId,
        questionEventId: input.questionEventId,
        requester: input.requester,
        draftId: input.draftId ?? null,
      });
      return { taskId: task.id };
    },

    updateTaskState(taskId, event, fields) {
      updateTaskState(storePath, passphrase, taskId, event, fields?.draftId !== undefined ? { draftId: fields.draftId } : {});
    },

    createCard(input) {
      const card = createCard(storePath, passphrase, {
        id: input.cardId,
        taskId: input.taskId,
        roomId: input.roomId,
        eventId: input.eventId,
        kind: input.kind,
        audience: input.audience,
        state: input.state,
        payloadJson: "{}",
        requester: input.requester,
      });
      return { cardId: card.id };
    },

    recordCardEdit(cardId, fields) {
      updateCardRevAndState(storePath, passphrase, cardId, { rev: fields.rev, state: fields.state, payloadJson: "{}" });
    },

    openCardFor(taskId, roomId): OpenWorkspaceCard | undefined {
      // "Open" means not yet done/failed — the only two terminal task-card
      // states (cards.md §8); a decision card's own terminal states
      // (chosen/expired) are S6's concern, not read here. Cards for one
      // task accumulate (an edit is a write, not a new row in this store's
      // own history — see updateCardRevAndState), so the most recently
      // created row for this (taskId, roomId) pair is the one still live;
      // listCards already orders oldest-first.
      const cards = listCards(storePath, passphrase, { taskId, roomId });
      const openCards = cards.filter((card) => card.state !== "done" && card.state !== "failed");
      const latest = openCards[openCards.length - 1];
      if (latest === undefined) {
        return undefined;
      }
      return { cardId: latest.id, taskId: latest.taskId, eventId: latest.eventId, rev: latest.rev, state: latest.state };
    },
  };
}
