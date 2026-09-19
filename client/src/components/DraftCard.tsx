import { useState } from "react";
import type { DraftRecord } from "../api/types.js";
import { useAnswerEscalation, useRecordOutcome } from "../api/queries.js";
import type { DuoApiConfig } from "../api/client.js";
import { DuoMessage } from "./DuoMessage.js";
import { OwnerMessage } from "./OwnerMessage.js";
import { ConfidenceHairline } from "./ConfidenceHairline.js";
import type { DraftPipelineResult } from "../api/types.js";

/**
 * Adapts a `DraftRecord` (the list shape) into the discriminated union
 * `ConfidenceHairline` expects — a draft record is always one or the
 * other by construction (`draftText === null` iff escalated), so this
 * narrowing can't fail on real data. Uses `draft.refused` and
 * `draft.escalationThreshold` directly rather than guessing at either:
 * an earlier version pattern-matched `refused` out of `escalationReason`'s
 * human-readable text and hardcoded the threshold, both of which drift
 * the moment the server-side wording or a configured threshold changes.
 */
function toDraftPipelineResult(draft: DraftRecord): DraftPipelineResult {
  if (draft.escalated) {
    return {
      kind: "escalation",
      draftId: draft.id,
      reason: draft.escalationReason ?? "",
      refused: draft.refused,
      confidence: undefined,
    };
  }
  return {
    kind: "draft",
    draftId: draft.id,
    text: draft.draftText ?? "",
    sources: draft.sources,
    confidence: { score: draft.confidenceScore, passesThreshold: true, threshold: draft.escalationThreshold },
  };
}

/** A failed mutation with no feedback looks identical to a button that silently did nothing — the owner can't tell whether Send actually sent. Renders nothing when there's no error, so call sites don't need their own conditional. */
function MutationError({ error }: { error: Error | null }) {
  if (!error) {
    return null;
  }
  return (
    <p className="text-xs text-[var(--refused)]" data-testid="mutation-error">
      {error.message}
    </p>
  );
}

function SourceList({ sources }: { sources: DraftRecord["sources"] }) {
  if (sources.length === 0) {
    return null;
  }
  return (
    <details className="text-xs text-[var(--muted)]">
      <summary>
        Drew on {sources.length} source{sources.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-1">
        {sources.map((source) => (
          <li key={`${source.kind}:${source.id}`}>{source.label}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One item in the Review surface (`client-tech-design.md` §1.5 /
 * client-design.md §1.5): the question, the duo's draft or escalation,
 * the provenance rail, and Send / Edit / Ignore — the correction loop's
 * only input, so this is the component the whole product exists to serve.
 */
export function DraftCard({ api, draft }: { api: DuoApiConfig; draft: DraftRecord }) {
  const recordOutcome = useRecordOutcome(api);
  const answerEscalation = useAnswerEscalation(api);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(draft.draftText ?? "");
  const [answerText, setAnswerText] = useState("");
  const result = toDraftPipelineResult(draft);

  if (draft.escalated) {
    return (
      <div className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="draft-card">
        <ConfidenceHairline result={result} />
        <OwnerMessage>{draft.question}</OwnerMessage>
        <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--edge)] px-4 py-3 text-[var(--muted)]" data-testid="escalation-reason">
          {draft.escalationReason}
        </div>
        <SourceList sources={draft.sources} />
        {!draft.refused &&
          (answerEscalation.isSuccess ? (
            <p className="text-xs text-[var(--confident)]" data-testid="answer-confirmation">
              Queued as a standing-order candidate.
            </p>
          ) : (
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
                placeholder="Answer it yourself — becomes a standing-order candidate"
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
              />
              <button
                className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-white disabled:opacity-40"
                disabled={!answerText || answerEscalation.isPending}
                onClick={() => answerEscalation.mutate({ draftId: draft.id, answer: answerText })}
              >
                Answer
              </button>
            </div>
          ))}
        <MutationError error={answerEscalation.error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="draft-card">
      <ConfidenceHairline result={result} />
      <OwnerMessage>{draft.question}</OwnerMessage>
      <DuoMessage>
        {editing ? (
          <textarea
            className="w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-2 text-[var(--text)]"
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={4}
          />
        ) : (
          draft.draftText
        )}
      </DuoMessage>
      <SourceList sources={draft.sources} />
      <div className="flex gap-2">
        {editing ? (
          <>
            <button
              className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-white"
              disabled={recordOutcome.isPending}
              onClick={() => recordOutcome.mutate({ draftId: draft.id, outcome: "edited", sentText: editedText })}
            >
              Send edited
            </button>
            <button className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-white"
              disabled={recordOutcome.isPending}
              onClick={() => recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })}
            >
              Send
            </button>
            <button className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)]"
              disabled={recordOutcome.isPending}
              onClick={() => recordOutcome.mutate({ draftId: draft.id, outcome: "discarded" })}
            >
              Ignore
            </button>
          </>
        )}
      </div>
      <MutationError error={recordOutcome.error} />
    </div>
  );
}
