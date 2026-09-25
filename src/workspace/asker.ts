import { localpartOf } from "./directory.js";
import { resolveAskerRef } from "../permissions/directory.js";
import type { AskerContext } from "../permissions/public-answer.js";
import type { WorkspaceMemberIdentity } from "./transport.js";

// The user-id grammar lives in directory.ts (the identity module, and the
// one the adapter can share without importing the asker/permissions
// chain); re-exported here unchanged for the callers that know it from
// this module (#219's surface).
export { localpartOf };

/**
 * #186 AC3, #187 AC3: the asking Matrix user id mapped to an asker id
 * through the EXISTING resolution (`resolveAskerRef` over
 * `duo/directory.json`) — the same seam `POST /ask`'s `askerContextFor`
 * uses, so workspace asks and link asks log the same way and #49's
 * "unresolvable asker gets the most restrictive treatment" holds
 * identically. A resolved sender logs the directory id; an unresolved one
 * logs the full Matrix user id (the protocol's own spelling, more precise
 * than a bare localpart that matched nothing). No ask link is involved, so
 * `askLinkId` is always null.
 *
 * #187's feed: `member` is the workspace directory's record for this
 * sender (`WorkspaceService.memberFor(senderId)`, from the identity
 * listing read at the last successful connect), when the daemon has one.
 * Said plainly: as wired, this parameter cannot change any outcome — the
 * cache is keyed by the very user id it would hand back, so the lookup
 * key (the localpart) and the fallback ref (the full user id) are the
 * same strings fed or unfed. That is deliberate: AC3's contract is that
 * the workspace directory SERVES the existing resolution without
 * altering it, and the pinned fed/unfed equality is that contract made
 * testable. What the parameter buys is the typed surface — the resolution
 * path accepts the directory's own record, so a later consumer (#192's
 * daemon/client surfaces) can feed member facts here without re-plumbing
 * serve.ts — with the safety rules already pinned where they will matter:
 * the member's display name is never a key (self-service on Matrix; an
 * asker must not choose their own log identity), and resolution cannot
 * move a permission — asker resolution is audit fidelity only;
 * `answerPublicly` applies a uniform clearance ceiling regardless of who
 * resolved.
 *
 * A duo-shaped sender (`@duo-carol:…`) resolves as itself or not at all —
 * never as its owner (AR-13's direction, applied to inbound work: a duo's
 * asks are the duo's).
 */
export function askerContextForSender(senderId: string, duoDir: string, member?: WorkspaceMemberIdentity): AskerContext {
  const userId = member?.userId ?? senderId;
  const { ref, resolved } = resolveAskerRef(localpartOf(userId), userId, duoDir);
  return { ref, resolved, askLinkId: null };
}
