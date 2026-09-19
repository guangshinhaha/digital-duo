import { useState } from "react";
import type { DraftRecord } from "../api/types.js";
import { useAnswerEscalation, useRecordOutcome } from "../api/queries.js";
import type { DuoApiConfig } from "../api/client.js";
import { DuoMessage } from "./DuoMessage.js";
import { OwnerMessage } from "./OwnerMessage.js";
import { ConfidenceHairline } from "./ConfidenceHairline.js";
import type { DraftPipelineResult } from "../api/types.js";

/** Adapts a `DraftRecord` (the list shape) into the discriminated union `ConfidenceHairline` expects — a draft record is always one or the other by construction (`draftText === null` iff escalated), so this narrowing can't fail on real data. */
function toDraftPipelineResult(draft: DraftRecord): DraftPipelineResult {
  if (draft.escalated) {
    return {
      kind: "escalation",
      draftId: draft.id,
      reason: draft.escalationReason ?? "",
      refused: draft.escalationReason?.toLowerCase().includes("refus") ?? false,
      confidence: undefined,
    };
  }
  return {
    kind: "draft",
    draftId: draft.id,
    text: draft.draftText ?? "",
    sources: draft.sources,
    confidence: { score: draft.confidenceScore, passesThreshold: true, threshold: 0.55 },
  };
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
        {!(result.kind === "escalation" && result.refused) && (
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
        )}
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
      {draft.sources.length > 0 && (
        <details className="text-xs text-[var(--muted)]">
          <summary>Drew on {draft.sources.length} source{draft.sources.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1 space-y-1">
            {draft.sources.map((source) => (
              <li key={`${source.kind}:${source.id}`}>{source.label}</li>
            ))}
          </ul>
        </details>
      )}
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
    </div>
  );
}
