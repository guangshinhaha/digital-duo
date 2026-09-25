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
