import { createHash } from "node:crypto";
import { createRecord, type IngestRecord, type RecordAuthor } from "../record.js";
import { isWorkRelevant } from "../work-relevance.js";

/**
 * Thrown when pasted text has no line recognisable as a turn (see
 * TURN_MARKER). Names the expected format. Sets `name` so the serve
 * layer's error-to-status mapping (#176) can tell it apart from a generic
 * Error — the same idiom every named error that reaches HTTP follows.
 */
export class MalformedTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedTranscriptError";
  }
}

/** "Human:"/"Me:" for the owner's turns, "Assistant:"/"Claude:" for the model's — case-insensitive, one turn per matching line. */
const TURN_MARKER = /^(human|me|assistant|claude)\s*:\s?(.*)$/i;

function normalizeSpeaker(marker: string): RecordAuthor {
  const lower = marker.toLowerCase();
  return lower === "human" || lower === "me" ? "me" : "assistant";
}

export interface PasteImportResult {
  readonly records: readonly IngestRecord[];
  readonly workRelevant: boolean;
}

/**
 * Parses a pasted conversation transcript into the same record shape the
 * Claude export adapter produces (import-adapters.md §3: "makes testing
 * trivial without a full export"). A line not matching a turn marker is
 * folded into the previous turn's text, so multi-line messages survive the
 * paste intact. The whole transcript is one thread and is classified for
 * work-relevance once, same as a Claude export conversation (AR-11) — a
 * transcript judged not work-relevant produces no records at all.
 */
export function parsePastedTranscript(raw: string): PasteImportResult {
  const turns: { author: RecordAuthor; text: string }[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const match = TURN_MARKER.exec(line);
    if (match) {
      turns.push({ author: normalizeSpeaker(match[1]), text: match[2] });
    } else if (turns.length > 0 && line.trim().length > 0) {
      turns[turns.length - 1].text += `\n${line}`;
    }
  }

  if (turns.length === 0) {
    throw new MalformedTranscriptError(
      'Expected a pasted transcript with lines starting "Human: " / "Assistant: " (or "Me: " / "Claude: "). Found no recognisable turn.',
    );
  }

  const fullText = turns.map((turn) => turn.text).join("\n");
  if (!isWorkRelevant(fullText)) {
    return { records: [], workRelevant: false };
  }

  const threadId = `paste-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
  const timestamp = new Date().toISOString();
  const records = turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) =>
      createRecord({
        source: "paste",
        sourceRef: null,
        kind: "my_thinking",
        author: turn.author,
        text: turn.text.trim(),
        timestamp,
        threadId,
        audience: "private",
      }),
    );

  return { records, workRelevant: true };
}
