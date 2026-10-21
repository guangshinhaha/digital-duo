import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../permissions/public-answer.js";
import type { AnswerEventContent } from "./transport.js";

/**
 * #186 AC5 — the corpus never crosses. Every function in this file is a
 * constructor of an outbound workspace payload, and together with
 * `src/workspace/cards.ts`'s card builder (added W-S4-1) they are the ONLY
 * ones that exist. This one builds exactly one shape: the asker-visible
 * answer text as a Matrix text message.
 * `outcome.text` (answered) and `outcome.message` (passed on / refused) are
 * the same asker projection `POST /ask` sends — the composed text already
 * carries its own citations and attribution (public-answer.ts) — and nothing
 * else on the outcome is copied: draftId, logEntryId, confidence, topicId,
 * evidenceAgeDays and ownerNotice are owner-facing and stay on the machine,
 * with no code path that could serialize a record, evidence text, rule or
 * the passphrase into an event. test/workspace-payload.test.ts pins both the
 * shape and the absences.
 *
 * Amended 2026-10-20 (interaction-model PRD v0.4, Phase 1, W-S4-1): the SAME
 * invariant applies to the card builder noted above. See docs/workspace/cards.md §9.
 *
 * W-S3-1 (#313): `options.inReplyTo` — the question's own event id — is the
 * ONE optional widening this story adds: when present, the returned content
 * additionally carries `"m.relates_to": { "m.in_reply_to": { event_id } }`,
 * a plain Matrix reply to the question. It rides in through this same
 * options bag (never copied off the outcome itself — the event id comes
 * from the question, which the corpus-never-crosses rule above was never
 * about), so a direct-room answer (no `inReplyTo` passed) stays the
 * pre-#313 two-key shape byte for byte, and a shared-room answer gets
 * exactly three keys — never a fourth. See `src/workspace/service.ts`,
 * which decides whether to pass `inReplyTo` at all from the question's own
 * `isDirect` fact (questions.ts).
 */
export function buildAnswerEvent(outcome: PublicAnswerOutcome, options?: { readonly inReplyTo?: string }): AnswerEventContent {
  const body = outcome.kind === "answered" ? outcome.text : outcome.message;
  if (options?.inReplyTo === undefined) {
    return { msgtype: "m.text", body };
  }
  return { msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: options.inReplyTo } } };
}

/**
 * The event sent when the answering pipeline itself throws: the SAME
 * `PUBLIC_ANSWER_FAILED_MESSAGE` constant `POST /ask`'s 500 sends
 * (public-answer.ts, the one definition), so one asker-visible vocabulary —
 * a colleague can never tell which transport answered, and internals never
 * reach the wire from either one.
 */
export function buildFailedAnswerEvent(): AnswerEventContent {
  return { msgtype: "m.text", body: PUBLIC_ANSWER_FAILED_MESSAGE };
}

/**
 * #190: the event sent when the attachment grounding door refuses — the
 * door's own message (drafting/attachment-grounding.ts), which is built to
 * name the limit broken (size in KiB, count, type, or the classification
 * marking) so an asker knows what to change, never the file's contents.
 * Still exactly the one shape every other outbound constructor builds — a
 * refusal differs from an answer in wording only, never in what it could
 * carry — so the corpus-never-crosses rule above holds for it too.
 */
export function buildAttachmentRefusalEvent(message: string): AnswerEventContent {
  return { msgtype: "m.text", body: message };
}
