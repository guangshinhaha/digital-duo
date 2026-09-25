import type { RoomConsentStatus } from "./consent.js";
import { authorFromUserId, isDuoAuthor } from "./messages.js";
import type { WorkspaceCandidateMessage, WorkspaceQuestion } from "./transport.js";

/**
 * #186 AC3, v1 scope: what counts as work arriving over the connection. A
 * question is a text message from someone else in a *direct* room — exactly
 * two joined members, one of them the duo — because "people talk to duos"
 * starts person-to-duo (#184). Group-room addressing, mentions and the
 * consent questions around them are #189/#192 and are deliberately not
 * guessed at here: a three-plus-member room produces no question at all
 * rather than a wrong one.
 *
 * #189 adds the structural guard #219's successor notes flagged: the sender
 * must be a PERSON, not merely "not this duo". A message from another duo
 * (`@duo-*`, the record §6 convention, read through the same
 * `authorFromUserId` the message contract uses) is not a question — v1's
 * answering is person-to-duo, and without this guard a duo-to-duo direct
 * room would answer each other's messages in a loop (the self-filter only
 * ever excluded our own exact user id). Duo-to-duo conversation, if it ever
 * becomes product, is #192's consent surface, not a filter loosened here.
 */
export function directQuestionFrom(message: WorkspaceCandidateMessage, selfUserId: string): WorkspaceQuestion | null {
  if (message.senderId === selfUserId) {
    // The duo's own messages (an earlier answer replayed by sync, a local
    // echo) are never questions to itself.
    return null;
  }
  if (isDuoAuthor(authorFromUserId(message.senderId))) {
    // Another duo's message is never a question to this duo.
    return null;
  }
  if (message.body.trim().length === 0) {
    return null;
  }
  const joined = new Set(message.joinedMemberIds);
  // A direct room: the duo and exactly one other member, both joined. More
  // members than that is a group room (#192's consent surface); fewer means
  // a room dissolving under us.
  if (!(joined.size === 2 && joined.has(selfUserId) && joined.has(message.senderId))) {
    return null;
  }
  return {
    eventId: message.eventId,
    roomId: message.roomId,
    senderId: message.senderId,
    body: message.body,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * The room-consent lookup the #192 filter consults: the standing decision
 * for a room, or null when there is none. Pure input — the service hands this
 * over a fresh `readRoomConsent` per message, so the owner's latest word
 * (an allow, a withdrawal) is what the very next message is gated on.
 */
export type RoomDecisionLookup = (roomId: string) => RoomConsentStatus | null;

/**
 * #192: what counts as work arriving over the connection, with consent in
 * force. A question is a text message from a PERSON in a room the duo is
 * reachable in, where "reachable in" is exactly one of:
 *
 * - **the v1 default posture** — a direct room (the duo and exactly one
 *   other member, both joined), unchanged from #186: a person DMing the duo
 *   was always answerable, and consent does not retro-require a record for
 *   it; or
 * - **the owner's recorded allow** — any other room (group, channel) whose
 *   consent record says `allowed`. The record exists only because the owner
 *   allowed a held invitation (consent.ts); nobody else's act can put a
 *   room on that side of the line.
 *
 * An explicit non-allow decision — `refused` or `withdrawn` — vetoes the
 * default posture too: the owner's latest word about a room is stronger
 * than the posture, so a withdrawn direct room stays unanswered until a
 * fresh consent act (a new invitation, explicitly allowed) reopens it.
 * Absent lookup (no consent surface configured) is the pre-#192 behavior
 * byte for byte: direct rooms only, and a lookup that throws (a malformed
 * `duo/room-consent.json`) is the caller's to degrade — see the service,
 * which fails closed on shared rooms and leaves the direct posture alone.
 *
 * The duo-to-duo loop guard (#219's successor note) stays first and
 * upstream of the consent check: another duo's message is never a question,
 * in a direct room or a consented one, so no consent state can create two
 * daemons answering each other forever.
 */
export function answerableQuestionFrom(
  message: WorkspaceCandidateMessage,
  selfUserId: string,
  roomDecision?: RoomDecisionLookup,
): WorkspaceQuestion | null {
  if (message.senderId === selfUserId || isDuoAuthor(authorFromUserId(message.senderId))) {
    return null;
  }
  if (message.body.trim().length === 0) {
    return null;
  }
  // The owner's standing word about THIS room, read once for both halves
  // below. An explicit non-allow decision vetoes even the direct posture —
  // the owner's latest word about a room outranks the default, so a
  // withdrawn direct room stays unanswered until a fresh consent act
  // reopens it. Silence (null, or no lookup at all) leaves the direct
  // posture exactly as it was and keeps every shared room gated.
  const decision = roomDecision?.(message.roomId) ?? null;
  if (decision !== null && decision !== "allowed") {
    return null;
  }
  const direct = directQuestionFrom(message, selfUserId);
  if (direct !== null) {
    return direct;
  }
  const joined = new Set(message.joinedMemberIds);
  if (!joined.has(selfUserId) || !joined.has(message.senderId)) {
    // Not in the room — or asked by someone who has since left it: no
    // consent record can make the duo reachable somewhere it is not a
    // member, and a departed member's replayed line is not a live question.
    return null;
  }
  if (decision !== "allowed") {
    // null (no record) is the v1 default refusal for shared rooms. The
    // message is not work — before any retrieval, generation, or store
    // access (the refusal gate's short-circuit shape).
    return null;
  }
  return {
    eventId: message.eventId,
    roomId: message.roomId,
    senderId: message.senderId,
    body: message.body,
    receivedAt: new Date().toISOString(),
  };
}
