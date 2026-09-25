import { resolveAskerRef } from "../permissions/directory.js";
import type { AskerContext } from "../permissions/public-answer.js";

/**
 * The localpart of a Matrix user id — `@alice:workspace` → `alice`, the
 * natural key against `duo/directory.json`'s hand-maintained ids. Anything
 * that isn't `@local:domain` shaped is returned unchanged so it simply
 * fails to resolve (the safe default), rather than crashing the ask.
 */
export function localpartOf(userId: string): string {
  const match = /^@([^:]+):/.exec(userId);
  return match ? match[1] : userId;
}

/**
 * #186 AC3: the asking Matrix user id mapped to an asker id through the
 * EXISTING resolution (`resolveAsker` over `duo/directory.json`) — the same
 * seam `POST /ask`'s `askerContextFor` uses, so workspace asks and link asks
 * log the same way and #49's "unresolvable asker gets the most restrictive
 * treatment" holds identically. A resolved sender logs the directory id; an
 * unresolved one logs the full Matrix user id (the protocol's own spelling,
 * more precise than a bare localpart that matched nothing). No ask link is
 * involved, so `askLinkId` is always null.
 *
 * #187 formalizes the workspace directory that will feed this mapping
 * (people *and* whose duo is whose); until then the localpart convention is
 * the stand-in, and an unresolvable sender degrades the logs' fidelity —
 * never the answer (`answerPublicly` applies a uniform ceiling regardless).
 */
export function askerContextForSender(senderId: string, duoDir: string): AskerContext {
  // The same resolve-or-degrade core POST /ask's askerContextFor uses
  // (directory.ts's resolveAskerRef): the localpart is the lookup key, the
  // full sender id the fallback ref (the protocol's own spelling, more
  // precise than a bare localpart that matched nothing), and no ask link is
  // involved, so `askLinkId` is always null.
  const { ref, resolved } = resolveAskerRef(localpartOf(senderId), senderId, duoDir);
  return { ref, resolved, askLinkId: null };
}
