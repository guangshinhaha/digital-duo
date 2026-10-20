import {
  ClientEvent,
  createClient,
  EventType,
  Method,
  MsgType,
  RoomEvent,
  SetPresence,
  SyncState,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Membership,
  type Room,
} from "matrix-js-sdk";
import type { DuoCardEditContent, DuoCardEventContent } from "./cards.js";
import { localpartOf } from "./directory.js";
import { fileFromContent, inviteReasonOf, type RoomInvite } from "./messages.js";
import type { WorkspaceSettings } from "./settings.js";
import type {
  AnswerEventContent,
  WorkspaceCandidateMessage,
  WorkspaceCardResponse,
  WorkspaceFileBody,
  WorkspaceFileReference,
  WorkspaceMember,
  WorkspaceMemberIdentity,
  WorkspaceMemberIdentityListing,
  WorkspaceMemberListing,
  WorkspaceTransport,
} from "./transport.js";
import { WorkspaceTokenRevokedError } from "./transport.js";

/** The custom, non-`m.room.message` event type a card response rides (cards.md §2) — not an SDK-known constant, so it's named here rather than destructured from matrix-js-sdk's EventType enum. */
const CARD_RESPONSE_EVENT_TYPE = "duo.card.response";

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

/**
 * #190: the files a question rode with. Association is positional and
 * sender-scoped — the asker's own contiguous run of `m.file`/`m.image`
 * events immediately preceding their text question in the same room's
 * timeline. Nothing about the protocol links them (Matrix has no
 * attachment relation); this convention is what any Matrix client's
 * "attach then ask" flow produces, and it degrades honestly at every
 * edge: another member's message, the asker's own text, or any other
 * event between the files and the question ends the run (older files
 * don't silently ground a later question — they'd have to be re-shared),
 * and a question not found on the live timeline (a thread reply, whose
 * files would live in the thread) associates nothing.
 *
 * The walk is bounded by the timeline the SDK holds in memory — a run
 * that begins before the live window starts simply associates fewer
 * files, which the door treats as the honest count. The door, not this
 * adapter, enforces the count/type/size policy (attachments.md §7).
 */
function attachmentsForQuestion(room: Room, questionEventId: string, senderId: string): WorkspaceFileReference[] {
  const events = room.getLiveTimeline().getEvents();
  let index = events.length - 1;
  while (index >= 0 && events[index]!.getId() !== questionEventId) {
    index -= 1;
  }
  if (index < 0) {
    return [];
  }
  const attachments: WorkspaceFileReference[] = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = events[i]!;
    if (candidate.getType() !== EventType.RoomMessage || candidate.getSender() !== senderId) {
      break;
    }
    const content = candidate.getContent() as Record<string, unknown>;
    const msgtype = content.msgtype;
    if (msgtype !== MsgType.File && msgtype !== MsgType.Image) {
      break;
    }
    // The same one-parsing-layer rule the contract states (messages.ts):
    // file facts come from fileFromContent or not at all. A file event
    // without a content reference contributes nothing but does not end
    // the run — it renders as its own (broken) file message either way.
    const file = fileFromContent(msgtype as string, content);
    if (file !== undefined) {
      attachments.unshift({ reference: file.reference, name: file.name, mimeType: file.mimeType, size: file.size });
    }
  }
  return attachments;
}

/**
 * A crude `matrix.to` member-link matcher — `https://matrix.to/#/<mxid>`
 * (URL-encoded), the anchor a client renders for a mention pill in
 * `formatted_body`. Only the fallback path for a client that didn't send
 * `m.mentions` (#312/S1) reads this; it never runs when `m.mentions` is
 * present, even an empty one — an explicit empty mentions object is the
 * client's own word that it named nobody, not evidence of an older client.
 */
const MATRIX_TO_USER_LINK = /https:\/\/matrix\.to\/#\/(%40[^"'\s)]+|@[^"'\s)]+)/g;

/**
 * #312/S1: who a message named. `m.mentions.user_ids` (MSC3952/the stable
 * spec) is read first and, when present at all, is authoritative — an
 * empty list is "names nobody," not "didn't say." Only its total absence
 * falls back to scanning `formatted_body` for `matrix.to` anchors, for a
 * client that renders mention pills as plain links without the structured
 * field.
 */
function mentionedUserIdsOf(content: Record<string, unknown>): string[] {
  const mentions = content["m.mentions"];
  if (mentions !== null && typeof mentions === "object") {
    const userIds = (mentions as Record<string, unknown>).user_ids;
    if (Array.isArray(userIds)) {
      return userIds.filter((id): id is string => typeof id === "string");
    }
  }
  const formattedBody = content.formatted_body;
  if (typeof formattedBody !== "string") {
    return [];
  }
  const found: string[] = [];
  for (const match of formattedBody.matchAll(MATRIX_TO_USER_LINK)) {
    try {
      found.push(decodeURIComponent(match[1]!));
    } catch {
      // A malformed percent-encoding in a hostile or buggy formatted_body
      // contributes nothing rather than throwing out of a content parse.
    }
  }
  return found;
}

/**
 * #312/S1: resolves one related event's sender through the room's own
 * known timelines (`room.findEventById` — not only the live one, matching
 * what the real SDK searches). `undefined`/missing room support, or a
 * target the room has never loaded, both resolve to `null` rather than
 * throwing — a reply or thread root the adapter cannot see is an honest
 * "don't know who," never a crash.
 */
function senderOfRelatedEvent(room: Room, eventId: string | undefined): string | null {
  if (eventId === undefined) {
    return null;
  }
  const found = (room as { findEventById?: (id: string) => MatrixEvent | undefined }).findEventById?.(eventId);
  return found?.getSender() ?? null;
}

/**
 * #312/S1: the reply target's sender — `m.relates_to["m.in_reply_to"].event_id`
 * resolved through the room. `null` when the message isn't a reply at all.
 */
function replyToSenderIdOf(room: Room, content: Record<string, unknown>): string | null {
  const relatesTo = content["m.relates_to"];
  if (relatesTo === null || typeof relatesTo !== "object") {
    return null;
  }
  const inReplyTo = (relatesTo as Record<string, unknown>)["m.in_reply_to"];
  if (inReplyTo === null || typeof inReplyTo !== "object") {
    return null;
  }
  const eventId = (inReplyTo as Record<string, unknown>).event_id;
  return senderOfRelatedEvent(room, typeof eventId === "string" ? eventId : undefined);
}

/**
 * #312/S1: the thread root's sender — `m.relates_to.event_id` resolved
 * through the room, but only when `rel_type` names the thread relation
 * (`m.thread`); an `m.replace`/`m.reference`/any other relation is not a
 * thread, so this stays `null` for those (the edit-unwrap path above reads
 * `m.replace` itself; this function never confuses the two).
 */
function threadRootSenderIdOf(room: Room, content: Record<string, unknown>): string | null {
  const relatesTo = content["m.relates_to"];
  if (relatesTo === null || typeof relatesTo !== "object") {
    return null;
  }
  const record = relatesTo as Record<string, unknown>;
  if (record.rel_type !== "m.thread") {
    return null;
  }
  return senderOfRelatedEvent(room, typeof record.event_id === "string" ? record.event_id : undefined);
}

/**
 * W-S4-3: parses one `duo.card.response` timeline event's content into the
 * seam's shape, or `undefined` for anything malformed — cards.md §2's wire
 * shape plus the §4 rule that the daemon drops an unknown `v`. Never
 * throws: a tap from a legitimate client sends well-formed content, and
 * anything else (a hostile or buggy sender) is dropped here rather than
 * crashing the timeline listener. This function only checks SHAPE; the
 * anti-spoofing checks that need the daemon's own state (does this card
 * exist, is it still open, is the sender the right person — cards.md §6)
 * are the service's, over `workspace_cards`, not this adapter's.
 */
function cardResponseOf(content: Record<string, unknown>, eventId: string, roomId: string, senderId: string, originServerTs: number): WorkspaceCardResponse | undefined {
  const relatesTo = content["m.relates_to"];
  if (relatesTo === null || typeof relatesTo !== "object") {
    return undefined;
  }
  const cardEventId = (relatesTo as Record<string, unknown>).event_id;
  if (typeof cardEventId !== "string" || cardEventId.length === 0) {
    return undefined;
  }
  const response = content["duo.card.response"];
  if (response === null || typeof response !== "object") {
    return undefined;
  }
  const { v, card_id: cardId, action_id: actionId, values } = response as Record<string, unknown>;
  if (v !== 1) {
    return undefined;
  }
  if (typeof cardId !== "string" || cardId.length === 0) {
    return undefined;
  }
  if (typeof actionId !== "string" || actionId.length === 0) {
    return undefined;
  }
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return undefined;
  }
  return {
    eventId,
    roomId,
    senderId,
    cardEventId,
    cardId,
    actionId,
    values: values as Record<string, unknown>,
    originServerTs,
  };
}

/** The SDK's own logger interface, for a caller that wants this client's SDK logging elsewhere (a hosted daemon runs many clients in one process, #236). */
export type MatrixSdkLogger = NonNullable<Parameters<typeof createClient>[0]["logger"]>;

/**
 * `client.sendMessage`'s SDK type is `RoomMessageEventContent` — a closed
 * set of known msgtypes that does not (and should not) know about
 * `duo.card`. The card builders are this codebase's only constructors of
 * that content (cards.ts), already schema-validated before it reaches
 * here, so this cast is the one place a card's wire shape crosses into the
 * SDK's narrower type — never a license to send arbitrary content.
 */
function sendRoomMessage(client: MatrixClient, roomId: string, content: DuoCardEventContent | DuoCardEditContent): Promise<{ event_id: string }> {
  return client.sendMessage(roomId, content as unknown as Parameters<MatrixClient["sendMessage"]>[1] & object);
}

export function createMatrixTransport(settings: WorkspaceSettings, options: { readonly sdkLogger?: MatrixSdkLogger } = {}): WorkspaceTransport {
  // The access token lives in the client and in the env var it came from,
  // and nowhere else: it is never logged, never persisted by this code.
  const client: MatrixClient = createClient({
    baseUrl: settings.homeserverUrl,
    accessToken: settings.accessToken,
    userId: settings.userId,
    // Absent: the SDK's global logger, exactly as before (`duo serve`, one client).
    ...(options.sdkLogger ? { logger: options.sdkLogger } : {}),
  });
  let stopped = false;
  let pendingConnectReject: ((error: Error) => void) | undefined;
  const messageHandlers: ((message: WorkspaceCandidateMessage) => void)[] = [];
  const cardResponseHandlers: ((response: WorkspaceCardResponse) => void)[] = [];
  const inviteHandlers: ((invite: RoomInvite) => void)[] = [];
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
    const content = event.getContent() as Record<string, unknown>;
    if (content.msgtype !== MsgType.Text || typeof content.body !== "string") {
      return;
    }
    // An edited message arrives as an m.replace replacement whose top-level
    // body is the "* " fallback marker — the same marker the message
    // contract refuses to treat as text. The edited text lives in
    // m.new_content.body (a top-level key beside m.relates_to): prefer it,
    // so a person editing their question re-asks the question as written,
    // and the marker never reaches a draft.
    const relatesTo = content["m.relates_to"];
    let body = content.body;
    if (relatesTo !== null && typeof relatesTo === "object" && (relatesTo as Record<string, unknown>).rel_type === "m.replace") {
      const newContent = content["m.new_content"];
      if (newContent !== null && typeof newContent === "object" && typeof (newContent as Record<string, unknown>).body === "string") {
        body = (newContent as Record<string, unknown>).body as string;
      }
    }
    const senderId = event.getSender();
    if (senderId === undefined || room === undefined) {
      return;
    }
    const eventId = event.getId() ?? "";
    // #190: the asker's own files immediately preceding this question, on
    // the room's timeline (see attachmentsForQuestion). Set only when
    // non-empty so the no-attachments candidate stays byte-identical to
    // the pre-#190 shape — the seam-level fakes and the sibling works read
    // this same object.
    const attachments = attachmentsForQuestion(room, eventId, senderId);
    const message: WorkspaceCandidateMessage = {
      eventId,
      roomId: event.getRoomId() ?? room.roomId,
      senderId,
      body,
      originServerTs: event.getTs(),
      joinedMemberIds: room.getJoinedMembers().map((member) => member.userId),
      ...(attachments.length > 0 ? { attachments } : {}),
      // #312/S1: mentions and reply/thread targets, normalized here and
      // nowhere else — the shared-room question filter (questions.ts) is
      // the one consumer, gating a group room on whether the duo's own id
      // shows up in any of the three.
      mentionedUserIds: mentionedUserIdsOf(content),
      replyToSenderId: replyToSenderIdOf(room, content),
      threadRootSenderId: threadRootSenderIdOf(room, content),
    };
    for (const handler of messageHandlers) {
      handler(message);
    }
  });

  // W-S4-3: duo.card.response is NOT an m.room.message (cards.md §2) — it
  // rides the same RoomEvent.Timeline the text-message listener above
  // reads, just filtered on its own event type instead of msgtype. Not
  // gated on `removed` only, matching the message listener's own pattern:
  // a response replayed by the sync catch-up `connect()` resolves on must
  // reach a handler exactly like a live one (held-not-lost applies here
  // too), so the only early-outs are `stopped` and the wrong event type.
  client.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined, _toStartOfTimeline: boolean | undefined, removed: boolean, _data: IRoomTimelineData) => {
    if (stopped || removed) {
      return;
    }
    if (event.getType() !== CARD_RESPONSE_EVENT_TYPE) {
      return;
    }
    const senderId = event.getSender();
    // The duo's own echo is dropped defensively (the module comment on
    // sendCard/editCard states why this account could never legitimately
    // be the response's sender) — and a response with no sender at all is
    // unattributable, so it is dropped the same way a candidate message
    // with no sender is in the listener above.
    if (senderId === undefined || senderId === settings.userId) {
      return;
    }
    const content = event.getContent() as Record<string, unknown>;
    const eventId = event.getId();
    const roomId = event.getRoomId() ?? room?.roomId;
    if (eventId === undefined || roomId === undefined) {
      return;
    }
    const response = cardResponseOf(content, eventId, roomId, senderId, event.getTs());
    if (response === undefined) {
      // Malformed shape, or an unknown `v` (cards.md §4: "the daemon drops
      // responses carrying an unknown v") — dropped, never thrown, so one
      // bad response can never take the listener down for every other one.
      return;
    }
    for (const handler of cardResponseHandlers) {
      handler(response);
    }
  });

  // #192: the invite surface. MyMembership fires for THIS account's
  // membership changing — including rooms the initial sync catch-up
  // discovers (an invitation held while the Mac was asleep surfaces on
  // wake, the same held-not-lost recovery a question gets). Only the
  // `invite` state is an invitation; the facts delivered are exactly what
  // the room object knows: the invite membership event's sender (the
  // inviter — a fact the protocol attributes, not a display-name claim),
  // the m.room.name state if the stripped state carried one, and the joined
  // members visible in it (heroes-limited until the room is joined —
  // stated by the contract, not inflated here). Nothing else happens on an
  // invite: the adapter never joins; the service holds it for the owner.
  client.on(RoomEvent.MyMembership, (room: Room, membership: Membership) => {
    if (stopped || membership !== "invite") {
      return;
    }
    const inviteEvent = room.getMember(settings.userId)?.events.member;
    const nameContent = room.currentState.getStateEvents(EventType.RoomName, "")?.getContent() as Record<string, unknown> | undefined;
    const inviteContent = inviteEvent?.getContent() as Record<string, unknown> | undefined;
    const invite: RoomInvite = {
      roomId: room.roomId,
      inviterId: inviteEvent?.getSender() ?? null,
      name: typeof nameContent?.name === "string" ? nameContent.name : null,
      joinedMemberCount: room.getMembers().filter((member) => member.membership === "join").length,
      // guangshinhaha/duo#315: the colleague's first message, when their
      // client carried it as the invite's reason, and whether they marked
      // the conversation one-to-one — read by the same rule the sync parser
      // uses (messages.ts).
      reason: inviteReasonOf(inviteContent?.reason),
      direct: inviteContent?.is_direct === true,
    };
    for (const handler of inviteHandlers) {
      handler(invite);
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
      client.removeAllListeners(RoomEvent.MyMembership);
      client.stopClient();
      pendingConnectReject?.(new Error("workspace transport stopped before connect finished"));
      pendingConnectReject = undefined;
    },

    async sendAnswer(roomId: string, content: AnswerEventContent) {
      // Sent as the duo's own account — protocol-level attribution
      // (decision record §6): the room's members cannot read this as the
      // owner, whatever a client renders. The sent event's id is returned
      // (W-S4-3) so a caller can later point a card's result link at it.
      const sent = await client.sendMessage(roomId, { msgtype: MsgType.Text, body: content.body });
      return { eventId: sent.event_id };
    },

    async sendCard(roomId: string, content: DuoCardEventContent) {
      // Exactly the builder's content, verbatim — nothing added or
      // dropped, matching the "the type allows nothing else" contract the
      // seam states. See sendRoomMessage's doc comment for the SDK-type cast.
      const sent = await sendRoomMessage(client, roomId, content);
      return { eventId: sent.event_id };
    },

    async editCard(roomId: string, _eventId: string, content: DuoCardEditContent) {
      // An edit is an ordinary new message carrying m.relates_to/m.replace
      // and m.new_content (cards.md §3) — not a distinct SDK primitive, so
      // it rides the same sendMessage call sendCard does. `_eventId` (the
      // card's own event id) already lives inside `content["m.relates_to"]`
      // — the builder put it there — so it isn't threaded separately here;
      // it is kept as a parameter because the seam's doc states the edit
      // is "against the card's own event id," which content already encodes.
      await sendRoomMessage(client, roomId, content);
    },

    onCardResponse(handler: (response: WorkspaceCardResponse) => void) {
      cardResponseHandlers.push(handler);
    },

    async fetchFile(reference: string, options: { readonly maxBytes: number }): Promise<WorkspaceFileBody> {
      // #190: the daemon's one dereference of conversation files — as the
      // duo's own authenticated user, over the held connection, bounded by
      // the caller's byte cap. See messages.ts's "Files" section for the
      // platform model (authenticated media, MSC3916; the homeserver
      // serves bytes to authenticated users, not to rooms) and what our
      // side adds on top: this body goes to the door and nowhere else.
      if (stopped) {
        throw new Error("workspace transport stopped — the file read needs the held connection");
      }
      const parsed = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(reference);
      if (parsed === null) {
        throw new Error(`workspace file reference is not an mxc URI: ${reference}`);
      }
      // Range is inclusive, so `0..maxBytes` fetches at most maxBytes+1
      // bytes — one byte past the cap is exactly the evidence that the
      // body exceeds it (`exceededMaxBytes`), while a body at or under the
      // cap arrives whole. A server that ignores Range and sends the full
      // body is caught by the same check; the bytes still never leave this
      // function's return value.
      const response = await client.http.authedRequest<unknown>(
        Method.Get,
        `/_matrix/client/v1/media/download/${encodeURIComponent(parsed[1]!)}/${encodeURIComponent(parsed[2]!)}`,
        undefined,
        undefined,
        {
          prefix: "",
          rawResponseBody: true,
          headers: { Range: `bytes=0-${options.maxBytes}` },
          // Required by this SDK version's IRequestOpts (it extends
          // Pick<RequestInit, "priority">); undefined is the browser/fetch
          // default — no scheduling hint asked for.
          priority: undefined,
        },
      );
      if (!(response instanceof Blob)) {
        // rawResponseBody promised a raw body; anything else is an SDK
        // contract change, and the door's caller treats a throw as a
        // retrieval failure — refused with a recoverable reason, never a
        // guessed grounding.
        throw new Error("workspace media download returned an unreadable body");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, exceededMaxBytes: bytes.byteLength > options.maxBytes };
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

    onInvite(handler: (invite: RoomInvite) => void) {
      inviteHandlers.push(handler);
    },

    async joinRoom(roomId: string) {
      // The sole join primitive (the seam's own doc): a homeserver-accepted
      // membership change and nothing else — the service's allow path is the
      // only caller, and it joins BEFORE recording the decision (the
      // crash-safety ordering: a crash between the two leaves the room
      // joined-but-unrecorded, which the gate answers with silence).
      await client.joinRoom(roomId);
    },

    async leaveRoom(roomId: string, reason?: string) {
      // A leave is also the invite rejection on Matrix — the seam's doc —
      // which is why the refusal path and the withdrawal path share this
      // one primitive.
      if (reason === undefined) {
        await client.leave(roomId);
        return;
      }
      // guangshinhaha/duo#315: the spec's leave body carries an optional
      // `reason`, which the SDK's leave() doesn't expose — the same raw
      // authed request the media read above uses, against the spec path.
      await client.http.authedRequest(Method.Post, `/rooms/${encodeURIComponent(roomId)}/leave`, undefined, { reason });
    },

    async inviteToRoom(roomId: string, userId: string) {
      // guangshinhaha/duo#314: the service's one caller invites only the
      // duo's own owner (the seam's doc) — a plain invite, nothing else.
      await client.invite(roomId, userId);
    },
  };
}
