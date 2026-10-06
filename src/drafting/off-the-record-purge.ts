import { rejectPendingCorrectionCandidatesForDrafts } from "../corrections/queue.js";
import { rejectRulesForDrafts } from "../derivation/rule-review.js";
import { listDraftIdsForRoom } from "./draft-log.js";
import { rejectPendingStandingOrderCandidatesForDrafts } from "./standing-order-candidates.js";

/**
 * guangshinhaha/duo#274: "turning it on purges what was already learned
 * from that room" — the store-touching half of marking a room off the
 * record. Lives in `drafting/`, not `workspace/`, because
 * `src/workspace/**` is pinned to never import a store module
 * (`workspace/off-the-record.ts`'s own doc comment); the route that calls
 * this also calls `markRoomOffTheRecord` for the file-based marker itself.
 *
 * What "already learned" means today, concretely — everything a draft in
 * this room could have produced:
 *
 * 1. **Pending standing-order candidates** (`standing-order-candidates.ts`)
 *    — an escalation in this room the owner answered, not yet reviewed.
 *    Rejected, never deleted (the same reviewable-rejection stance the
 *    owner's own "reject" action takes).
 * 2. **Pending correction candidates** (`corrections/queue.ts`) — an edit
 *    to a draft in this room, not yet reviewed. Rejected the same way.
 * 3. **Rules already written from a correction** on a draft in this room
 *    (`Rule.correctionDraftId`) — an edit that was already *approved*
 *    before the room was marked off the record. Rejected through the
 *    same `rejectRule` the owner's own review screen uses, which is the
 *    one action that actually stops a rule being active.
 *
 * What this does NOT touch, by design: the draft rows themselves (the
 * owner's own record of what was asked and answered stays — #274 is about
 * learning, not about the conversation disappearing), anything already
 * *approved* as a standing-order candidate before #1's reject ran (same
 * reasoning as #3: once approved it is a rule, and #3 is what un-does
 * that), and any rule derived from the bulk-import corpus
 * (`derivation/rules.ts`'s induction) — that pipeline has never read from
 * a live workspace room (there is no ingest path from one), so there is
 * nothing there for a room-scoped purge to find.
 */
export interface PurgeOffTheRecordRoomResult {
  readonly draftIds: readonly string[];
  readonly standingOrderCandidatesRejected: number;
  readonly correctionCandidatesRejected: number;
  readonly rulesRejected: number;
}

export function purgeOffTheRecordRoom(storePath: string, passphrase: string, duoDir: string, roomId: string): PurgeOffTheRecordRoomResult {
  const draftIds = listDraftIdsForRoom(storePath, passphrase, roomId);
  if (draftIds.length === 0) {
    return { draftIds, standingOrderCandidatesRejected: 0, correctionCandidatesRejected: 0, rulesRejected: 0 };
  }
  const standingOrderCandidatesRejected = rejectPendingStandingOrderCandidatesForDrafts(storePath, passphrase, draftIds);
  const correctionCandidatesRejected = rejectPendingCorrectionCandidatesForDrafts(storePath, passphrase, draftIds);
  const rulesRejected = rejectRulesForDrafts(storePath, passphrase, duoDir, draftIds).length;
  return { draftIds, standingOrderCandidatesRejected, correctionCandidatesRejected, rulesRejected };
}
