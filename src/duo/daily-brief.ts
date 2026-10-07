import { listDrafts, type DraftRecord } from "../drafting/draft-log.js";
import { listPublicAnswerLogEntriesBetween } from "../permissions/public-answer-log.js";

/**
 * duo#282 (digital-duo#279): the daily brief — "what's waiting, what was
 * passed on, what your duo handled". A composition, like
 * `knowledge-summary.ts`'s `DuoKnowledge`: every field below is read from
 * a module that already owns the fact, never re-derived.
 *
 * - **Waiting on you** — pending, non-escalated drafts (`drafts.ts`'s own
 *   `outcome IS NULL`, `escalated = 0`): the duo wrote an answer and is
 *   waiting for a send/edit/dismiss.
 * - **Passed on** — pending, escalated drafts: the duo asked the owner
 *   instead of guessing. This is deliberately NOT built over
 *   `escalation/digest.ts`'s `assembleEscalationDigest`/
 *   `listEscalationDigests`: the first assembling is itself the send
 *   (it writes an append-only row and marks items digested — exactly the
 *   side effect `escalations/digest`'s own route comment says a mere
 *   *view* must never cause), and the second only shows digests already
 *   sent, which would make "passed on" look empty on a day nothing was
 *   explicitly digested even though escalations are genuinely
 *   outstanding. Reading `drafts` directly keeps the brief a pure view —
 *   opening it changes nothing — while still counting exactly the same
 *   predicate (`escalated = 1`, unresolved) `escalation/digest.ts`
 *   classifies urgency over.
 * - **Handled by your duo** — what nobody else can show, per #279's own
 *   framing: `public_answer_log` entries outcome `"answered"` in the
 *   window, i.e. questions a colleague asked through an ask link that the
 *   duo answered on its own, no owner involved. Reuses
 *   `listPublicAnswerLogEntriesBetween`, the same read `trust/away.ts`'s
 *   return summary already uses for an identically-shaped "what happened
 *   while you were out" window.
 *
 * `trust/recipient-autonomy.ts`'s autonomous-send grants are deliberately
 * NOT a fourth section here: that mechanism computes offers and grants
 * but has no confirmed path wiring granted autonomy into a live send in
 * this codebase today (no caller of `drafting/autonomous-send.ts` outside
 * its own tests) — folding it in would show a section that can never
 * truthfully populate. If/when that path is wired for real, add a
 * section reading its own settled log the same way the other two already
 * do; a daily brief with an always-empty-and-silently-so section is
 * better than one that implies a capability the product doesn't yet
 * deliver.
 */

export interface DailyBriefWaitingItem {
  readonly draftId: string;
  readonly question: string;
  readonly createdAt: string;
}

export interface DailyBriefPassedOnItem {
  readonly draftId: string;
  readonly question: string;
  readonly escalationReason: string | null;
  readonly createdAt: string;
}

export interface DailyBriefHandledItem {
  readonly id: string;
  readonly question: string;
  readonly askerRef: string;
  readonly createdAt: string;
}

export interface DailyBrief {
  /** The window this brief covers — `[since, generatedAt)`. */
  readonly since: string;
  readonly generatedAt: string;
  readonly waitingOnYou: readonly DailyBriefWaitingItem[];
  readonly passedOn: readonly DailyBriefPassedOnItem[];
  readonly handledByDuo: readonly DailyBriefHandledItem[];
  /** True when all three sections are empty — AC: "an all-clear says so" rather than three empty sections with nothing to tell them apart from a loading state. */
  readonly allClear: boolean;
}

function toWaitingItem(draft: DraftRecord): DailyBriefWaitingItem {
  return { draftId: draft.id, question: draft.question, createdAt: draft.createdAt };
}

function toPassedOnItem(draft: DraftRecord): DailyBriefPassedOnItem {
  return { draftId: draft.id, question: draft.question, escalationReason: draft.escalationReason, createdAt: draft.createdAt };
}

/**
 * Assembles the brief over `[since, now)` — `since` defaults to 24 hours
 * before `now`, i.e. "since yesterday", AC "delivered at the owner's
 * chosen time" being the client's schedule to pick a `since` that lines
 * up with the last time one was shown; this function itself only knows
 * how to read a window, same separation `awayAnswerContext` keeps from
 * `trust/away.ts`'s own period bookkeeping.
 */
export function assembleDailyBrief(storePath: string, passphrase: string, since?: string, now: Date = new Date()): DailyBrief {
  const generatedAt = now.toISOString();
  const windowStart = since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const pending = listDrafts(storePath, passphrase, { outcome: "pending" }).filter((draft) => draft.createdAt >= windowStart);
  const waitingOnYou = pending.filter((draft) => !draft.escalated).map(toWaitingItem);
  const passedOn = pending.filter((draft) => draft.escalated).map(toPassedOnItem);

  const handledByDuo = listPublicAnswerLogEntriesBetween(storePath, passphrase, windowStart, generatedAt)
    .filter((entry) => entry.outcome === "answered")
    .map((entry) => ({ id: entry.id, question: entry.question, askerRef: entry.askerRef, createdAt: entry.createdAt }));

  return {
    since: windowStart,
    generatedAt,
    waitingOnYou,
    passedOn,
    handledByDuo,
    allClear: waitingOnYou.length === 0 && passedOn.length === 0 && handledByDuo.length === 0,
  };
}
