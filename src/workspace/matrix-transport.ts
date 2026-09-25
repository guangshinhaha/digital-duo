import {
  ClientEvent,
  createClient,
  EventType,
  MsgType,
  RoomEvent,
  SetPresence,
  SyncState,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import type { WorkspaceSettings } from "./settings.js";
import type { AnswerEventContent, WorkspaceCandidateMessage, WorkspaceTransport } from "./transport.js";

/**
 * The one file that knows `matrix-js-sdk` exists. Wired in composition
 * (`commands/serve.ts` lazily imports it) and never imported by a test: the
 * behavior that matters — backoff, held-not-lost, the answering loop, the
 * payload — all lives above the seam, against the fake. This adapter only
 * translates SDK facts into seam facts:
 *
 * - `connect()` resolves when sync reaches `Prepared` (the first sync is
 *   done: room state the homeserver held for us, including events that
 *   arrived while we were away, has caught up) and rejects on `Error` (the
 *   SDK's own retry threshold exhausted, or a hard failure like an invalid
 *   token).
 * - `onDisconnected` fires only on `Error`/`Stopped` — transient blips the
 *   SDK's internal sync retries absorb never surface, so the service's
 *   backoff and the SDK's never fight over one connection.
 * - `onMessage` forwards every `m.room.message`/`m.text` timeline event,
 *   live AND replayed-by-sync: a question asked while the Mac was asleep
 *   must be answered on wake, which is the whole held-not-lost point. The
 *   cost — a daemon restart re-reads the initial-sync window and may
 *   re-answer a question still inside it — is the documented v1 boundary
 *   (#189's read state owns the durable fix; in-process dedupe is the
 *   service's).
 *
 * Plaintext only for v1: E2EE rooms with a key-holding duo are #191
 * (decision record §8), federation is off (§7), and the homeserver is the
 * org's own (§1) — the closed deployment the record describes.
 */
export function createMatrixTransport(settings: WorkspaceSettings): WorkspaceTransport {
  // The access token lives in the client and in the env var it came from,
  // and nowhere else: it is never logged, never persisted by this code.
  const client: MatrixClient = createClient({
    baseUrl: settings.homeserverUrl,
    accessToken: settings.accessToken,
    userId: settings.userId,
  });
  let stopped = false;
  let pendingConnectReject: ((error: Error) => void) | undefined;
  const messageHandlers: ((message: WorkspaceCandidateMessage) => void)[] = [];
  const disconnectHandlers: (() => void)[] = [];

  client.on(ClientEvent.Sync, (state: SyncState, _oldState: SyncState | null, _data?: { error?: Error }) => {
    if (stopped) {
      return;
    }
    // Only the states the SDK cannot recover from on its own surface as a
    // disconnect (see the module comment): a rejected pending connect() is
    // the service's console-visible error, and an established connection
    // going Error/Stopped hands the recovery to the service's backoff.
    if (state === SyncState.Error || state === SyncState.Stopped) {
      for (const handler of disconnectHandlers) {
        handler();
      }
    }
  });

  client.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined, _toStartOfTimeline: boolean | undefined, removed: boolean, _data: IRoomTimelineData) => {
    if (stopped || removed) {
      return;
    }
    if (event.getType() !== EventType.RoomMessage) {
      return;
    }
    const content = event.getContent() as { msgtype?: unknown; body?: unknown };
    if (content.msgtype !== MsgType.Text || typeof content.body !== "string") {
      return;
    }
    const senderId = event.getSender();
    if (senderId === undefined || room === undefined) {
      return;
    }
    const message: WorkspaceCandidateMessage = {
      eventId: event.getId() ?? "",
      roomId: event.getRoomId() ?? room.roomId,
      senderId,
      body: content.body,
      joinedMemberIds: room.getJoinedMembers().map((member) => member.userId),
    };
    for (const handler of messageHandlers) {
      handler(message);
    }
  });

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        // stop() settles a still-pending connect by rejecting it, so the
        // awaiting dial() can never hang off a client that's already gone.
        const settle = (finish: () => void) => {
          pendingConnectReject = undefined;
          finish();
        };
        pendingConnectReject = reject;
        const onSync = (state: SyncState, _oldState: SyncState | null, data?: { error?: Error }) => {
          if (state === SyncState.Prepared) {
            client.off(ClientEvent.Sync, onSync);
            settle(resolve);
          } else if (state === SyncState.Error) {
            client.off(ClientEvent.Sync, onSync);
            settle(() => reject(new Error(`workspace sync failed: ${data?.error?.message ?? "unknown error"}`)));
          }
        };
        client.on(ClientEvent.Sync, onSync);
        client.startClient().catch((error: unknown) => {
          client.off(ClientEvent.Sync, onSync);
          settle(() => reject(error instanceof Error ? error : new Error(`workspace startClient failed: ${String(error)}`)));
        });
      });
    },

    async stop() {
      stopped = true;
      client.removeAllListeners(ClientEvent.Sync);
      client.removeAllListeners(RoomEvent.Timeline);
      client.stopClient();
      pendingConnectReject?.(new Error("workspace transport stopped before connect finished"));
      pendingConnectReject = undefined;
    },

    async sendAnswer(roomId: string, content: AnswerEventContent) {
      // Sent as the duo's own account — protocol-level attribution
      // (decision record §6): the room's members cannot read this as the
      // owner, whatever a client renders.
      await client.sendMessage(roomId, { msgtype: MsgType.Text, body: content.body });
    },

    async markAlive() {
      await client.setPresence({ presence: SetPresence.Online });
    },

    onMessage(handler: (message: WorkspaceCandidateMessage) => void) {
      messageHandlers.push(handler);
    },

    onDisconnected(handler: () => void) {
      disconnectHandlers.push(handler);
    },
  };
}
