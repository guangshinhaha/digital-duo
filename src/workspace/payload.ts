import { PUBLIC_ANSWER_FAILED_MESSAGE, type PublicAnswerOutcome } from "../permissions/public-answer.js";
import type { AnswerEventContent } from "./transport.js";

/**
 * #186 AC5 — the corpus never crosses. These two functions are the ONLY
 * constructors of an outbound workspace payload, and they can build exactly
 * one shape: the asker-visible answer text as a Matrix text message.
 * `outcome.text` (answered) and `outcome.message` (passed on / refused) are
 * the same asker projection `POST /ask` sends — the composed text already
 * carries its own citations and attribution (public-answer.ts) — and nothing
 * else on the outcome is copied: draftId, logEntryId, confidence, topicId,
 * evidenceAgeDays and ownerNotice are owner-facing and stay on the machine,
 * with no code path that could serialize a record, evidence text, rule or
 * the passphrase into an event. test/workspace-payload.test.ts pins both the
 * shape and the absences.
 */
export function buildAnswerEvent(outcome: PublicAnswerOutcome): AnswerEventContent {
  return {
    msgtype: "m.text",
    body: outcome.kind === "answered" ? outcome.text : outcome.message,
  };
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
