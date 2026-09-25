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
import { localpartOf } from "./directory.js";
import type { WorkspaceSettings } from "./settings.js";
import type {
  AnswerEventContent,
  WorkspaceCandidateMessage,
  WorkspaceMember,
  WorkspaceMemberIdentity,
  WorkspaceMemberIdentityListing,
  WorkspaceMemberListing,
  WorkspaceTransport,
} from "./transport.js";
import { WorkspaceTokenRevokedError } from "./transport.js";

/**
 * The page size asked of the homeserver's user directory. Not configuration:
 * a closed org homeserver's whole user population is the workspace, and a
 * listing that comes back `limited` at this size is surfaced as truncated
 * (the seam carries the flag) rather than silently paged past — #192 owns
 * any real pagination, which needs a decision about what a workspace bigger
 * than this means for the product, not a bigger constant.
 */
const MEMBER_LISTING_LIMIT = 500;

/**
 * How many presence lookups may be in flight at once: presence is one
 * request per user on Matrix (there is no bulk API), and an unbounded
 * fan-out against the org's own homeserver on every directory read would
 * be a self-inflicted burst. Order-preserving chunks, so the listing the
 * seam returns keeps the server's order.
 */
const PRESENCE_CONCURRENCY = 10;

/** Maps with bounded concurrency, preserving order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, project: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(project))));
  }
  return results;
}

/** A directory result → the seam's identity facts, with the localpart as the display-name fallback. */
function memberIdentityOf(result: { user_id: string; display_name?: string }): WorkspaceMemberIdentity {
  return {
    userId: result.user_id,
    // A profile display name is optional and self-service; the localpart
    // is homeserver-issued and stable — the honest fallback for "no
    // display name set" (never empty).
    displayName: result.display_name || localpartOf(result.user_id),
  };
}

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
 *   token — an `M_UNKNOWN_TOKEN` rejection arrives as
 *   `WorkspaceTokenRevokedError`, the service's fail-fast signal).
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
 * - `listMembers` (#187) reads the homeserver's user directory and each
 *   listed user's presence — a read of exactly the facts the platform
 *   decision says the workspace holds (identity), nothing written.
 *   `listMemberIdentities` is the same read minus the per-user presence
 *   fan-out, for callers that want identity facts only.
 *
 * Plaintext only for v1: E2EE rooms with a key-holding duo are #191
 * (decision record §8), federation is off (§7), and the homeserver is the
 * org's own (§1) — the closed deployment the record describes.
 */

/**
 * Matrix's `M_UNKNOWN_TOKEN`, recognized where the SDK surfaces it — duck-
 * typed on `errcode` rather than `instanceof MatrixError` so an SDK release
 * that moves the class cannot silence the one error this adapter must
 * classify (the stub test pins the shape; a miss degrades to a retry loop,
 * never to a wrong terminal state).
 */
function revokedTokenErrorOf(error: unknown): WorkspaceTokenRevokedError | undefined {
  return (error as { errcode?: unknown } | null | undefined)?.errcode === "M_UNKNOWN_TOKEN"
    ? new WorkspaceTokenRevokedError(error instanceof Error ? error.message : String(error))
    : undefined;
}

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
            settle(() =>
              reject(
                revokedTokenErrorOf(data?.error) ??
                  new Error(`workspace sync failed: ${data?.error?.message ?? "unknown error"}`),
              ),
            );
          }
        };
        client.on(ClientEvent.Sync, onSync);
        client.startClient().catch((error: unknown) => {
          client.off(ClientEvent.Sync, onSync);
          settle(() =>
            reject(
              revokedTokenErrorOf(error) ??
                (error instanceof Error ? error : new Error(`workspace startClient failed: ${String(error)}`)),
            ),
          );
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

    async listMembers(): Promise<WorkspaceMemberListing> {
      // Reads ride the held connection — after stop() there is none, and
      // the service detaches the transport anyway; refusing here (like the
      // fake does) keeps a racing caller from issuing HTTP over a client
      // this adapter has already torn down.
      if (stopped) {
        throw new Error("workspace transport stopped — the member read needs the held connection");
      }
      // The user directory is Matrix's own "who is on this server" surface —
      // on the closed, federation-off org homeserver the platform decision
      // specifies, its contents ARE the workspace's members. An empty search
      // term is match-all on Synapse; that is a deployment assumption
      // recorded here for #192 to revisit against the homeserver actually
      // flown, not a property of the spec.
      const response = await client.searchUserDirectory({ term: "", limit: MEMBER_LISTING_LIMIT });
      // Presence is per-user on Matrix (there is no bulk API), so the full
      // read is one presence request per member — the documented
      // pilot-scale cost, and the reason the identity-only variant below
      // exists. Each lookup fails soft to offline-never-seen: a presence
      // the server won't state is a fact missing, and the directory says so
      // rather than guessing the user offline for the whole listing.
      const members: WorkspaceMember[] = await mapWithConcurrency(response.results, PRESENCE_CONCURRENCY, async (result) => {
        const presence = await client.getPresence(result.user_id).then(
          (status) => ({
            online: status.presence === SetPresence.Online,
            lastActiveAgoMs: typeof status.last_active_ago === "number" ? status.last_active_ago : null,
          }),
          () => ({ online: false, lastActiveAgoMs: null }),
        );
        return { ...memberIdentityOf(result), presence };
      });
      return { members, truncated: response.limited === true };
    },

    async listMemberIdentities(): Promise<WorkspaceMemberIdentityListing> {
      if (stopped) {
        throw new Error("workspace transport stopped — the member read needs the held connection");
      }
      // Same directory read, no presence fan-out: the identity facts are
      // one searchUserDirectory call, and callers that don't state
      // availability (the asker feed's connect-time cache) don't pay for it.
      const response = await client.searchUserDirectory({ term: "", limit: MEMBER_LISTING_LIMIT });
      return { members: response.results.map(memberIdentityOf), truncated: response.limited === true };
    },

    onMessage(handler: (message: WorkspaceCandidateMessage) => void) {
      messageHandlers.push(handler);
    },

    onDisconnected(handler: () => void) {
      disconnectHandlers.push(handler);
    },
  };
}
