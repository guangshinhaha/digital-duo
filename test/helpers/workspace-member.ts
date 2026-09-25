import type { WorkspaceMember, WorkspacePresence } from "../../src/workspace/transport.js";

/**
 * The one member builder shared by the workspace tests (#187): a member
 * with identity facts and, optionally, the server-side presence shape the
 * presence-carrying tests vary. Offline-never-seen is the default because
 * it is the factless floor — tests that state availability pass it in.
 */
export function memberOf(userId: string, displayName: string, online = false, lastActiveAgoMs: number | null = null): WorkspaceMember {
  return { userId, displayName, presence: presenceOf(online, lastActiveAgoMs) };
}

export function presenceOf(online: boolean, lastActiveAgoMs: number | null): WorkspacePresence {
  return { online, lastActiveAgoMs };
}
