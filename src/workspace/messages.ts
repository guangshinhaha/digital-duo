/**
 * #189: the message/event contract our side. The platform decision
 * (docs/workspace-platform.md, MERGED) is "Do not write a message store" —
 * Matrix/Synapse holds conversations, messages, membership, read state,
 * ordering and paging as library capability. What this module owns is the
 * typed surface both sides of the wire build against:
 *
 * - the client repo (guangshinhaha/duo) renders these types, and
 * - this daemon consumes them (the question filter's structural duo-author
 *   guard comes from here; #192's addressing/consent work extends here).
 *
 * Matrix event shapes are the wire reality, so every type below is produced
 * by exactly one parsing layer — the `*FromSync`/`messagesFromTimeline`
 * functions — fed the JSON `/sync` delivers. Nothing else in this codebase
 * interprets a raw Matrix event; if a shape needs understanding, it gets
 * understood here once.
 *
 * ## Ordering (stated, so the client builds on behavior not inference)
 *
 * Within a conversation, messages are **totally ordered by `(sentAt, id)`**:
 * `sentAt` is the homeserver's `origin_server_ts` (server time, not client
 * time) and the event id breaks exact-millisecond ties. The pair is total
 * and stable — the same two messages compare the same way on every device,
 * before and after paging, because both components are immutable. This
 * matches the order sync delivers a room's timeline (topological/stream
 * order) for practical timelines; where a late backfilled event sorts
 * earlier than an already-rendered one, that is a gap signal for the client
 * to re-fetch, not a different order.
 *
 * ## Paging
 *
 * Paging is **backwards** over that total order: a page cursor is an event
 * id, exclusive — `pageMessages(timeline, { before, limit })` returns the
 * `limit` messages with order key strictly below the cursor's (the newest
 * `limit` when no cursor is given), oldest→newest, plus `hasMoreBefore`.
 * Walking pages by feeding each page's oldest id back as the next cursor
 * never drops or duplicates a message, because the cursor is exactly the
 * last-returned id and the order is total (pinned by test). A cursor the
 * given slice does not contain yields an **empty page** (`hasMoreBefore:
 * false`): the timeline moved under the walker (a limited/gappy sync
 * rotated the window), and the honest move is to signal the client to
 * re-fetch the conversation — rewinding to the newest page would silently
 * duplicate history it already has.
 *
 * ## v1 parsing scope (deliberate)
 *
 * Parsed: `m.room.message` with `msgtype: "m.text"` (the same filter the
 * daemon's seam applies for questions), `m.file` and `m.image` (#190 — a
 * message can carry file content; see `MessageFile`), `m.replace` edits,
 * `m.thread` parents, `m.receipt`/`m.read` read positions, `m.room.member`
 * membership states, `m.room.name`, `m.room.create`, and the sync's
 * `invite` section as `RoomInvite`s (#192 — an invitation is a consent
 * question, so the contract states its facts). Not parsed, by decision:
 * other msgtypes (`m.audio`, `m.video`, …), redactions, E2EE content
 * (#191), left rooms and room governance. Message events without a
 * parseable sender or body — and file events without a content reference —
 * are skipped by the parser, never guessed at.
 *
 * ## Files (#190): what the platform gives, what this contract states
 *
 * Matrix keeps files out of rooms: an upload lands in the homeserver's
 * media store and returns a stable content URI (`mxc://…`), and the room
 * event *references* it. Serving, then, is two platform facts, stated here
 * so the client builds on them rather than on inference:
 *
 * - **The file message is served to members of that conversation.** The
 *   event — filename, type, size, reference — is room history: the
 *   homeserver delivers it under the room's history visibility, so only
 *   members see it, exactly as for text.
 * - **The bytes are served to authenticated users of the workspace
 *   homeserver, not to the room.** Authenticated media (MSC3916) requires
 *   an access token on every download, but Synapse does not bind an mxc
 *   URI to a room: any authenticated user of the homeserver who holds the
 *   reference can dereference it. On this deployment — the org's own
 *   homeserver, federation off — that population is the org, which is the
 *   read model files inherit wholesale (docs/workspace/org-read.md §4).
 *   What our side adds is the rest of that record's shape: the daemon
 *   dereferences only as the duo's own user over its outbound connection,
 *   never republishes bytes (an answer is text, and text only — the
 *   payload boundary), and gates any *duo-side use* at the attachment
 *   door (docs/workspace/attachments.md), which is where classification
 *   is decided — the workspace itself never classifies and never strips
 *   (§6), so what the contract carries is the file verbatim.
 */

/**
 * Who authored a message — a person or a duo. Two disjoint kinds, never a
 * flag on a person (platform record §6): the duo posts as its own Matrix
 * user (`@duo-<owner>:server`), so authorship is a fact of which account
 * sent the event, and this type can only express that fact. A client that
 * renders a duo message as its owner would have to ignore `kind` entirely —
 * there is no field it could misread instead, because neither variant
 * carries anything but its own identity.
 */
export type MessageAuthor = PersonAuthor | DuoAuthor;

/** A human's own Matrix account. */
export interface PersonAuthor {
  readonly kind: "person";
  readonly userId: string;
}

/** A duo's own Matrix account (`@duo-<owner>:server`, record §6). */
export interface DuoAuthor {
  readonly kind: "duo";
  readonly userId: string;
}

/**
 * Derives the author kind structurally from the authoring Matrix user id:
 * a localpart beginning `@duo-` is the org-homeserver's duo-account
 * convention (record §6); every other localpart is a person. The homeserver
 * is the org's own with federation off (record §7), so account creation —
 * and therefore who owns a `@duo-` name — is an admin act; mapping a duo
 * account to its owner's person account is #187's directory, not a guess
 * this function makes. A bare `@duo:server` is NOT the convention and
 * reads as a person.
 */
export function authorFromUserId(userId: string): MessageAuthor {
  return /^@duo-[^:]+:/.test(userId) ? { kind: "duo", userId } : { kind: "person", userId };
}

/** True only for the duo kind — the narrow type guard consumers narrow on. */
export function isDuoAuthor(author: MessageAuthor): author is DuoAuthor {
  return author.kind === "duo";
}

/** Matrix membership states for a room member (`m.room.member` `membership`). */
export type MembershipState = "join" | "leave" | "invite" | "ban";

/**
 * Narrows an unknown `membership` value against the union — the wire does
 * carry other strings (`knock`, future spec additions), and the parser's
 * floor for those is `"leave"`.
 */
function isMembershipState(value: unknown): value is MembershipState {
  return value === "join" || value === "leave" || value === "invite" || value === "ban";
}

/** One member of a conversation, with the same structural author kind messages carry. */
export interface ConversationMember {
  readonly userId: string;
  readonly author: MessageAuthor;
  readonly membership: MembershipState;
}

/**
 * How a conversation reads. `channel` is explicit — the room was created
 * with `m.room.create` `content.type === "m.channel"`, this org's
 * homeserver convention for public-namespace rooms (federation is off, so
 * the convention is ours to set). Without that, membership decides:
 * exactly two joined members is `direct` (the same definition the daemon's
 * question filter uses), anything else is `group`. `m.room.create`'s
 * `is_direct` flag is deliberately not trusted over membership — membership
 * is the truth a client can verify; a flagged "direct" room that later grew
 * members would otherwise mislabel itself.
 */
export type ConversationKind = "direct" | "group" | "channel";

/** A conversation as our side models it — membership, name, read state; the messages live in the timeline. */
export interface Conversation {
  /** Matrix room id, e.g. `!room:workspace` — the stable id conversations are addressed by. */
  readonly id: string;
  readonly kind: ConversationKind;
  /** The room's `m.room.name`, or null when it never got one (direct rooms usually don't). */
  readonly title: string | null;
  readonly members: readonly ConversationMember[];
  /**
   * Read state per member who has sent a read receipt the sync carried —
   * per person per conversation, recorded server-side by the homeserver
   * (Matrix receipts), so it is consistent across a member's devices by
   * construction. Our daemon's own durable variant of this (which events it
   * has handled) is src/workspace/read-state.ts.
   */
  readonly readPositions: readonly ReadPosition[];
  /** ISO-8601 instant of the newest timeline event, or null for a room sync carried no events for. */
  readonly lastActivityAt: string | null;
}

/** One member's read position in one conversation — their latest `m.read` receipt. */
export interface ReadPosition {
  readonly userId: string;
  readonly eventId: string;
  /** ISO-8601 instant of the receipt (the homeserver's `ts`). */
  readonly readAt: string;
}

/** A message's edit state: untouched, or edited (the body is the latest text either way). */
export type MessageEditState = { readonly kind: "original" } | { readonly kind: "edited"; readonly editedAt: string };

/**
 * #190: the file a message carries — everything a client needs to render
 * it and everything the duo's side needs to reference it. See the module
 * doc's "Files" section for who may dereference `reference` and under what
 * model; the short form is that the reference is stable, asker-
 * dereferenceable through authenticated media, and doubles as the id the
 * duo's draft sources cite when an attachment grounds a draft
 * (docs/workspace/attachments.md §8's contract dependency).
 */
export interface MessageFile {
  /** The filename as sent — the event's `filename`, falling back to its `body` (Matrix's own convention for m.file). */
  readonly name: string;
  /** The declared MIME type (`info.mimetype`), null when the sender didn't declare one. An `m.image` without one reads as `"image/*"`. */
  readonly mimeType: string | null;
  /** The declared size in bytes (`info.size`), null when undeclared — a hint from the sender, checked before it is trusted anywhere. */
  readonly size: number | null;
  /** The Matrix content URI (`mxc://…`) — the stable reference to the bytes in the homeserver's media store. */
  readonly reference: string;
}

/** A message in a conversation, as both the daemon and the client see it. */
export interface Message {
  /** Matrix event id — stable, unique, and the paging cursor. */
  readonly id: string;
  readonly conversationId: string;
  /** Structural: a person or a duo, derived from the sending user id. */
  readonly author: MessageAuthor;
  /**
   * The message's body text — the text for `m.text`, the filename for
   * `m.file`/`m.image` (Matrix's own convention: the body is the fallback
   * name a client renders when it cannot preview the file).
   */
  readonly body: string;
  /** The file this message carries (#190) — null on text messages. */
  readonly file: MessageFile | null;
  /** ISO-8601 instant of the homeserver's `origin_server_ts` — the ordering component. */
  readonly sentAt: string;
  readonly edit: MessageEditState;
  /** The thread root's event id when this message is a thread reply; null on the main timeline and on roots. */
  readonly threadParentId: string | null;
}

/** One page of a conversation's messages — see the paging statement in the module doc. */
export interface MessagePage {
  readonly messages: readonly Message[];
  readonly hasMoreBefore: boolean;
}

// ---------------------------------------------------------------------------
// The wire reality: the subset of Matrix event JSON the parsing layer reads.
// These are input types — everything the contract exposes is derived below
// and nothing downstream should touch a Raw* shape.
// ---------------------------------------------------------------------------

/** A Matrix event as `/sync` delivers it (client-side format). */
export interface RawMatrixEvent {
  readonly type: string;
  readonly state_key?: string;
  readonly sender?: string;
  readonly event_id?: string;
  readonly origin_server_ts?: number;
  readonly content: Record<string, unknown>;
}

/** One room's slice of a `/sync` response. */
export interface RawSyncRoom {
  readonly state?: { readonly events: readonly RawMatrixEvent[] };
  readonly timeline?: { readonly events: readonly RawMatrixEvent[] };
  readonly ephemeral?: { readonly events: readonly RawMatrixEvent[] };
}

/** One room's slice of the sync's `invite` section — Matrix stripped state: the events the homeserver judged an invitee needs to see the invitation in context. */
export interface RawSyncInviteRoom {
  readonly invite_state?: { readonly events: readonly RawMatrixEvent[] };
}

/**
 * The rooms section of a `/sync` response — v1 reads joined rooms and, since
 * #192, the invite section (left rooms remain unparsed). The invite section
 * is what makes "a duo joins by invitation, the same as a person"
 * (docs/workspace-platform.md §6) a consent question: it is the only wire
 * form in which someone else's room add reaches this account at all.
 */
export interface RawSyncRooms {
  readonly join?: Readonly<Record<string, RawSyncRoom>>;
  readonly invite?: Readonly<Record<string, RawSyncInviteRoom>>;
}

function isoFromTs(ts: number | undefined): string | null {
  // The ±8.64e15 ms range is ECMAScript's whole time domain; outside it
  // `toISOString` throws rather than guessing, and a timestamp that cannot
  // be an ISO instant cannot be an ordering key — skip, as with the rest.
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts) <= 8_640_000_000_000_000
    ? new Date(ts).toISOString()
    : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The event's content object, or undefined when the wire delivered
 * something that is not one (null, a string, …). The `Raw*` types declare
 * `content` as a record because well-formed Matrix events always carry one,
 * but this module is the seam that faces the wire, so it narrows at runtime
 * instead of trusting the declaration — one guard, used by every parser
 * below.
 */
function contentOf(event: RawMatrixEvent | undefined): Record<string, unknown> | undefined {
  return event !== undefined && event.content !== null && typeof event.content === "object" ? event.content : undefined;
}

/**
 * Every conversation in a sync's joined rooms, ordered by room id for
 * determinism. This is the "list conversations" surface: direct, group and
 * channel rooms come back with membership (a duo member appears alongside
 * people, as its own kind) and every member's latest read receipt.
 */
export function conversationsFromSync(rooms: RawSyncRooms): Conversation[] {
  return Object.keys(rooms.join ?? {})
    .sort()
    .map((roomId) => conversationFromSync(roomId, rooms.join![roomId]!));
}

/** Parses one joined room into a `Conversation`. */
export function conversationFromSync(roomId: string, room: RawSyncRoom): Conversation {
  const timelineEvents = room.timeline?.events ?? [];

  // State can arrive in either section: the `state` block carries the room's
  // state at the start of the window, but a room whose recent history the
  // sync window covers (every room on initial sync of a fresh account) has
  // its newest membership/create/name lines in `timeline`. /sync orders
  // state before timeline, so concatenating preserves "latest line wins".
  const stateLike = [...(room.state?.events ?? []), ...timelineEvents.filter((event) => event.state_key !== undefined)];

  const memberEvents = new Map<string, RawMatrixEvent>();
  let createEvent: RawMatrixEvent | undefined;
  let nameEvent: RawMatrixEvent | undefined;
  for (const event of stateLike) {
    if (event.type === "m.room.member" && event.state_key !== undefined) {
      memberEvents.set(event.state_key, event);
    } else if (event.type === "m.room.create" && event.state_key === "") {
      createEvent = event;
    } else if (event.type === "m.room.name" && event.state_key === "") {
      nameEvent = event;
    }
  }

  const members: ConversationMember[] = [...memberEvents.entries()].map(([userId, event]) => {
    const membership = stringOrUndefined(contentOf(event)?.membership);
    return {
      userId,
      author: authorFromUserId(userId),
      membership: isMembershipState(membership) ? membership : "leave",
    };
  });

  const joinedCount = members.filter((member) => member.membership === "join").length;
  const kind: ConversationKind =
    stringOrUndefined(contentOf(createEvent)?.type) === "m.channel" ? "channel" : joinedCount === 2 ? "direct" : "group";

  const lastTs = timelineEvents.length > 0 ? timelineEvents[timelineEvents.length - 1]!.origin_server_ts : undefined;

  return {
    id: roomId,
    kind,
    title: stringOrUndefined(contentOf(nameEvent)?.name) ?? null,
    members,
    readPositions: readPositionsFromEphemeral(room.ephemeral?.events ?? []),
    lastActivityAt: isoFromTs(lastTs),
  };
}

/**
 * Parses a room's ephemeral events into per-user read positions — the
 * per-person-per-conversation read state the homeserver records from
 * receipts. `m.receipt` content maps event id → receipt type → user → ts;
 * when several receipts arrive in one sync (or one user's receipts arrive
 * across events), the newest `ts` per user wins.
 */
export function readPositionsFromEphemeral(events: readonly RawMatrixEvent[]): ReadPosition[] {
  const latest = new Map<string, ReadPosition>();
  for (const event of events) {
    const content = contentOf(event);
    if (event.type !== "m.receipt" || content === undefined) {
      continue;
    }
    for (const [eventId, byType] of Object.entries(content)) {
      const reads = (byType as { "m.read"?: Record<string, { ts?: unknown }> } | undefined)?.["m.read"];
      if (reads === undefined || reads === null || typeof reads !== "object") {
        continue;
      }
      for (const [userId, receipt] of Object.entries(reads)) {
        const readAt = isoFromTs(typeof receipt?.ts === "number" ? receipt.ts : undefined);
        if (readAt === null) {
          continue;
        }
        const existing = latest.get(userId);
        if (existing === undefined || existing.readAt < readAt) {
          latest.set(userId, { userId, eventId, readAt });
        }
      }
    }
  }
  return [...latest.values()].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/**
 * #192: an invitation to this account, as the sync's invite section carries
 * it — the facts the owner decides on when allowing or refusing a room, and
 * (on the daemon side) the payload the transport seam's `onInvite` delivers.
 * Defined here, beside the parsing that produces it, so the contract and the
 * seam share one shape instead of two drifting copies of the same wire fact.
 *
 * `joinedMemberCount` is what the invite's stripped state shows, which on
 * Matrix is heroes-limited — the honest count visible at invitation time,
 * never an inflated "everyone". `inviterId`/`name` are null when the wire
 * did not carry them; a fact missing is a fact missing.
 */
export interface RoomInvite {
  readonly roomId: string;
  /** The sender of the `m.room.member` event that invited this account, or null when the slice did not carry it. */
  readonly inviterId: string | null;
  /** The room's `m.room.name` from the stripped state, or null. */
  readonly name: string | null;
  /** `m.room.member` events in `join` state within the stripped state — heroes-limited, stated as such. */
  readonly joinedMemberCount: number;
  /**
   * guangshinhaha/duo#315: the invite event's own `reason` — where a
   * colleague's client carries their first message to a duo, so the owner
   * sees what is being asked before allowing it. Null when the invite gave
   * none; absent on the pre-#315 shape (read as null).
   */
  readonly reason?: string | null;
  /** guangshinhaha/duo#315: the invite event's `is_direct` flag — a one-to-one conversation, as the inviter's client marked it. Absent reads as false. */
  readonly direct?: boolean;
}

/** The longest invite reason kept — a first message's preview, not the whole of a long one. */
export const INVITE_REASON_MAX_CHARS = 500;

/**
 * guangshinhaha/duo#315: an invite event's `reason`, read as a preview —
 * inviter-controlled text bound for the owner's screen, so control
 * characters are dropped and the length capped. Null for anything that is
 * not a non-blank string. Exported for the seam adapter, which reads the
 * same field off a live SDK event (one parsing rule, two callers).
 */
export function inviteReasonOf(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? "\n" : "")).trim();
  if (cleaned.length === 0) {
    return null;
  }
  return cleaned.length > INVITE_REASON_MAX_CHARS ? `${cleaned.slice(0, INVITE_REASON_MAX_CHARS - 1)}…` : cleaned;
}

/**
 * Parses the sync's invite section into `RoomInvite`s, ordered by room id
 * for determinism. A room in the invite section with no `m.room.member`
 * invite event for `selfUserId` is not an invitation to this account —
 * skipped rather than guessed at (the parser's floor, applied here too).
 */
export function invitesFromSync(rooms: RawSyncRooms, selfUserId: string): RoomInvite[] {
  return Object.keys(rooms.invite ?? {})
    .sort()
    .map((roomId) => {
      const events = rooms.invite![roomId]!.invite_state?.events ?? [];
      const inviteEvent = events.find(
        (event) => event.type === "m.room.member" && event.state_key === selfUserId && stringOrUndefined(contentOf(event)?.membership) === "invite",
      );
      if (inviteEvent === undefined) {
        return null;
      }
      const nameEvent = events.find((event) => event.type === "m.room.name" && event.state_key === "");
      const joinedMemberCount = events.filter(
        (event) => event.type === "m.room.member" && stringOrUndefined(contentOf(event)?.membership) === "join",
      ).length;
      const inviteContent = contentOf(inviteEvent);
      const roomInvite: RoomInvite = {
        roomId,
        inviterId: inviteEvent.sender ?? null,
        name: stringOrUndefined(contentOf(nameEvent)?.name) ?? null,
        joinedMemberCount,
        reason: inviteReasonOf(inviteContent?.reason),
        direct: inviteContent?.is_direct === true,
      };
      return roomInvite;
    })
    .filter((invite): invite is RoomInvite => invite !== null);
}

interface RelatesTo {
  readonly relType?: string;
  readonly eventId?: string;
}

/**
 * Reads a file message's content into a `MessageFile` — the one place an
 * `m.file`/`m.image` event becomes contract file facts. Undefined (skip the
 * event) when the content carries no usable content reference: without a
 * reference there is nothing to render or dereference, and guessing a
 * filename-only "file" would hand a client a dead card it can neither
 * preview nor download. An `m.image` that declares no MIME type still reads
 * as `image/*` — the msgtype itself is the sender's own type declaration.
 * Exported for the seam adapter (#190's association walk), which feeds it
 * the same content shape off a live SDK event — one parsing layer, stated
 * rule of this module.
 */
export function fileFromContent(msgtype: string, content: Record<string, unknown>): MessageFile | undefined {
  const reference = stringOrUndefined(content.url);
  if (reference === undefined) {
    return undefined;
  }
  const info = content.info !== null && typeof content.info === "object" ? (content.info as Record<string, unknown>) : {};
  const body = stringOrUndefined(content.body);
  const filename = stringOrUndefined(content.filename);
  const size = typeof info.size === "number" && Number.isFinite(info.size) ? info.size : null;
  return {
    name: filename !== undefined && filename.length > 0 ? filename : (body ?? reference),
    mimeType: stringOrUndefined(info.mimetype) ?? (msgtype === "m.image" ? "image/*" : null),
    size,
    reference,
  };
}

function relatesToOf(content: Record<string, unknown>): RelatesTo {
  const relatesTo = content["m.relates_to"];
  if (relatesTo === null || typeof relatesTo !== "object") {
    return {};
  }
  const record = relatesTo as Record<string, unknown>;
  return {
    relType: stringOrUndefined(record.rel_type),
    eventId: stringOrUndefined(record.event_id),
  };
}

/**
 * Parses a timeline's events into messages — the one place a raw
 * `m.room.message` becomes a contract `Message`:
 *
 * - only `m.room.message` events with `msgtype: "m.text"` and a string body
 *   (the daemon's seam applies the same filter; other msgtypes are #190's);
 * - a replacement (`m.relates_to` `rel_type: "m.replace"`) folds into the
 *   message it replaces: the original keeps its id/time/thread and gains
 *   the new body from `m.new_content` plus `editedAt` — and only when the
 *   replacement's sender IS the original's sender (the spec's rule; a
 *   replacement from anyone else is ignored, not folded). A replacement
 *   whose `m.new_content` carries no readable body is skipped outright —
 *   the top-level body is the "* " fallback marker, not text, and an edit
 *   with nothing to say must not flip a message's edit state. A replacement
 *   whose original is outside the parsed slice renders standalone (as
 *   Element does) — the body comes from `m.new_content`, edit state
 *   `original`;
 * - a thread reply (`rel_type: "m.thread"`) carries the root's event id as
 *   `threadParentId`; a rich reply's `m.in_reply_to` is NOT a thread parent
 *   (falling back to it would thread every rich reply);
 * - the author kind is derived structurally from the sender
 *   (`authorFromUserId`) — protocol-level attribution (record §6).
 *
 * Output is in the timeline's delivery order; `compareMessages` states the
 * total order for anything that needs to sort or page it.
 */
export function messagesFromTimeline(conversationId: string, events: readonly RawMatrixEvent[]): Message[] {
  const messages = new Map<string, Message>();
  const order: string[] = [];
  for (const event of events) {
    if (event.type !== "m.room.message" || event.sender === undefined || event.event_id === undefined) {
      continue;
    }
    const content = contentOf(event);
    const msgtype = content?.msgtype;
    const isFileMessage = msgtype === "m.file" || msgtype === "m.image";
    if (content === undefined || (msgtype !== "m.text" && !isFileMessage)) {
      continue;
    }
    const sentAt = isoFromTs(event.origin_server_ts);
    if (sentAt === null) {
      // No homeserver timestamp (or one outside the representable time
      // domain) means no ordering key — the contract's ordering rule cannot
      // hold for this event, so it is skipped rather than admitted out of
      // order.
      continue;
    }
    const relatesTo = relatesToOf(content);
    const sender = event.sender;
    const eventId = event.event_id;
    // A file message is only a message if its content reference parsed —
    // see fileFromContent. A file event without a reference is skipped,
    // exactly like a text event without a body.
    let file: MessageFile | null = null;
    if (isFileMessage) {
      const parsed = fileFromContent(msgtype as string, content);
      if (parsed === undefined) {
        continue;
      }
      file = parsed;
    }
    if (messages.has(eventId)) {
      // A duplicated event id inside one slice is wire malformity; the
      // first copy stands and the second must not emit twice.
      continue;
    }

    if (relatesTo.relType === "m.replace" && relatesTo.eventId !== undefined) {
      const newContent = content["m.new_content"];
      const body =
        newContent !== null && typeof newContent === "object"
          ? stringOrUndefined((newContent as Record<string, unknown>).body)
          : undefined;
      if (body === undefined) {
        // A replacement whose m.new_content carries no readable body has
        // nothing honest to show or fold — the top-level body is the "* "
        // fallback marker, not the text — so it is skipped whether the
        // original is in the slice or not.
        continue;
      }
      const original = messages.get(relatesTo.eventId);
      if (original !== undefined) {
        if (original.author.userId !== sender) {
          // The spec's rule: only the original's sender may replace it. A
          // replacement from anyone else is ignored, not folded — else a
          // crafted event could rewrite another member's message.
          continue;
        }
        // Fold: the original event id, time, thread and author all stand —
        // an edit is not a new message, it is a new state of one. A file
        // message's edit folds the same way: the body (the filename)
        // updates, the file facts stand — an edit renames, it does not
        // re-upload; a replacement event carrying a whole new file is a new
        // file event, and the #190 door treats whatever reference actually
        // rides the question, not what an edit claims.
        messages.set(original.id, {
          ...original,
          body,
          edit: { kind: "edited", editedAt: sentAt },
        });
        continue;
      }
      messages.set(eventId, {
        id: eventId,
        conversationId,
        author: authorFromUserId(sender),
        body,
        file,
        sentAt,
        edit: { kind: "original" },
        threadParentId: null,
      });
      order.push(eventId);
      continue;
    }

    const body = stringOrUndefined(content.body);
    if (body === undefined) {
      continue;
    }
    messages.set(eventId, {
      id: eventId,
      conversationId,
      author: authorFromUserId(sender),
      body,
      file,
      sentAt,
      edit: { kind: "original" },
      threadParentId: relatesTo.relType === "m.thread" && relatesTo.eventId !== undefined ? relatesTo.eventId : null,
    });
    order.push(eventId);
  }
  return order.map((eventId) => messages.get(eventId)!);
}

// ---------------------------------------------------------------------------
// Ordering and paging — the stated behavior, as code.
// ---------------------------------------------------------------------------

/**
 * The total order: by `sentAt` (ISO-8601 UTC, ms precision — lexicographic
 * comparison equals chronological for this uniform format), event id
 * breaking exact ties. Negative when `a` sorts before `b`.
 */
export function compareMessages(a: Message, b: Message): number {
  if (a.sentAt !== b.sentAt) {
    return a.sentAt < b.sentAt ? -1 : 1;
  }
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

/**
 * One backwards page over a conversation's messages (expected in delivery
 * order; it sorts defensively). `before` is an exclusive cursor — the page
 * is the `limit` messages with order key strictly below the cursor
 * message's, or the newest `limit` when no cursor is given. `hasMoreBefore`
 * says whether an earlier page exists. Walking pages by feeding each
 * page's oldest id back as the next cursor covers every message exactly
 * once — pinned by test. A `before` id the slice does not contain returns
 * an empty page with `hasMoreBefore: false`: the timeline moved under the
 * walker, and the caller's correct next move is to re-fetch the
 * conversation, not to keep walking (see the paging statement above).
 */
export function pageMessages(messages: readonly Message[], options: { before?: string; limit: number }): MessagePage {
  const sorted = [...messages].sort(compareMessages);
  if (options.before !== undefined) {
    const end = sorted.findIndex((message) => message.id === options.before);
    if (end === -1) {
      return { messages: [], hasMoreBefore: false };
    }
    const start = Math.max(0, end - options.limit);
    return { messages: sorted.slice(start, end), hasMoreBefore: start > 0 };
  }
  const start = Math.max(0, sorted.length - options.limit);
  return { messages: sorted.slice(start), hasMoreBefore: start > 0 };
}
