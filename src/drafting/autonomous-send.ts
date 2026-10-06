import { activeAutonomyGrant, autonomyKeyForDraft, readAutonomySettings } from "../trust/recipient-autonomy.js";
import { HEDGE_MARGIN } from "./confidence.js";
import { getDraft } from "./draft-log.js";
import { holdAutonomousSend, listScheduledSends, stopAutonomousSend, type ScheduledSend } from "./scheduled-sends.js";

/**
 * Where autonomy the owner granted (guangshinhaha/duo#266) actually acts —
 * and the one place it does: a freshly written draft either waits on the
 * owner as always, or, when every condition below holds, is HELD for the
 * owner's undo window (#268) and then sent by the daemon through the normal
 * delivery seam. Never instantly: the hold is the only door an autonomous
 * send has (`holdAutonomousSend`), and a zero-length hold exists only when
 * the owner explicitly confirmed one.
 *
 * Conditions, all required — anything else stays a normal draft:
 *
 * 1. The draft is still undecided, confident, not refused, and has text.
 * 2. It is a REPLY: someone asked through a channel (`provenance.origin ===
 *    "channel"`). An owner-asked draft reaches nobody, so there is nothing to
 *    send on the owner's behalf; it is also not evidence the grant was earned
 *    on (`trust/recipient-autonomy.ts`).
 * 3. Its person has a standing grant.
 * 4. It is not hedged — a draft that only just cleared the escalation line
 *    is shown to the owner even under autonomy (the client marks the same
 *    drafts "hedging"; `HEDGE_MARGIN` is that shared line).
 *
 * NOTE: no daemon path writes channel-origin drafts today (no channel adapter
 * ships — digital-duo#265), so in production this resolves `not_a_reply`
 * for every draft until one does. That is deliberate: a send that reaches no
 * one must never be recorded as the duo having answered someone.
 */
export type AutonomousSendDecision =
  | { readonly held: true; readonly send: ScheduledSend }
  | { readonly held: false; readonly reason: "not_found" | "decided" | "no_text" | "not_a_reply" | "no_grant" | "hedged" };

export function considerAutonomousSend(storePath: string, passphrase: string, draftId: string, now: Date = new Date()): AutonomousSendDecision {
  const draft = getDraft(storePath, passphrase, draftId);
  if (!draft) {
    return { held: false, reason: "not_found" };
  }
  if (draft.outcome !== null) {
    return { held: false, reason: "decided" };
  }
  if (draft.escalated || draft.refused || draft.draftText === null || draft.draftText.trim().length === 0) {
    return { held: false, reason: "no_text" };
  }
  const key = autonomyKeyForDraft(draft.provenance, draft.recipient);
  if (key === undefined) {
    return { held: false, reason: "not_a_reply" };
  }
  if (activeAutonomyGrant(storePath, passphrase, key) === undefined) {
    return { held: false, reason: "no_grant" };
  }
  if (draft.confidenceScore < draft.escalationThreshold + HEDGE_MARGIN) {
    return { held: false, reason: "hedged" };
  }
  const { holdSeconds } = readAutonomySettings(storePath, passphrase);
  return { held: true, send: holdAutonomousSend(storePath, passphrase, draftId, holdSeconds, now) };
}

/** Every autonomous send still inside its undo window, soonest first. */
export function listAutonomousHolds(storePath: string, passphrase: string): ScheduledSend[] {
  return listScheduledSends(storePath, passphrase).filter((send) => send.autonomous);
}

/**
 * Stops every autonomous send still held for one person — what revoking
 * their grant also does, so taking autonomy back can never leave one last
 * reply to go out a few seconds later. Returns the drafts stopped.
 */
export function stopAutonomousHoldsFor(storePath: string, passphrase: string, recipientKey: string, now: Date = new Date()): string[] {
  const stopped: string[] = [];
  for (const send of listAutonomousHolds(storePath, passphrase)) {
    const draft = getDraft(storePath, passphrase, send.draftId);
    if (draft && autonomyKeyForDraft(draft.provenance, draft.recipient) === recipientKey) {
      try {
        stopAutonomousSend(storePath, passphrase, send.draftId, now);
        stopped.push(send.draftId);
      } catch {
        // Fired or stopped in the meantime — nothing left to stop.
      }
    }
  }
  return stopped;
}
