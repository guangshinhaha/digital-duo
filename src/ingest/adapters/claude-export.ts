import { createRecord, type IngestRecord, type RecordInput } from "../record.js";
import { isWorkRelevant } from "../work-relevance.js";

/** Thrown when a file handed to `duo import claude` isn't a recognisable Claude data export. Names what was expected. */
export class MalformedExportError extends Error {}

interface RawChatMessage {
  sender?: unknown;
  text?: unknown;
  content?: unknown;
  created_at?: unknown;
}

interface RawConversation {
  uuid?: unknown;
  chat_messages?: unknown;
}

/**
 * A Claude export's message carries either a plain `text` string (older
 * exports) or a `content` array of typed blocks (current exports); this
 * reads whichever is present rather than assuming one shape.
 */
function messageText(message: RawChatMessage): string {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

export interface ClaudeImportResult {
  readonly records: readonly IngestRecord[];
  readonly conversationCount: number;
  readonly workRelevantConversationCount: number;
}

/**
 * Parses a Claude data export's `conversations.json` contents into
 * records. Every message in a conversation becomes one record with
 * `kind: "my_thinking"` — a chat with an assistant trains reasoning and
 * voice, never a stated position (import-adapters.md §2 notes) — and
 * `author` distinguishing whose turn it was (`me` for the human side,
 * `assistant` for the model's). The whole conversation is classified for
 * work-relevance once (AR-11); a conversation judged not work-relevant
 * contributes no records at all, so the filter runs before derivation
 * ever sees it, not as a flag derivation would have to remember to check.
 */
export function parseClaudeExport(raw: string): ClaudeImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedExportError(
      "Expected a Claude data export: a JSON array of conversations, each with a chat_messages array. Got invalid JSON.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MalformedExportError(
      `Expected a Claude data export: a JSON array of conversations. Got ${typeof parsed}.`,
    );
  }

  const records: IngestRecord[] = [];
  let workRelevantConversationCount = 0;

  parsed.forEach((entry, index) => {
    const conversation = entry as RawConversation;
    if (typeof conversation !== "object" || conversation === null || !Array.isArray(conversation.chat_messages)) {
      throw new MalformedExportError(
        `Expected a Claude data export: conversation at index ${index} is missing a chat_messages array.`,
      );
    }
    const messages = conversation.chat_messages as RawChatMessage[];
    const threadId = typeof conversation.uuid === "string" ? conversation.uuid : `conversation-${index}`;
    const sourceRef = typeof conversation.uuid === "string" ? `https://claude.ai/chat/${conversation.uuid}` : null;

    const fullText = messages.map((message) => messageText(message)).join("\n");
    if (!isWorkRelevant(fullText)) {
      return; // excluded before it ever becomes a record — see AR-11
    }
    workRelevantConversationCount += 1;

    for (const message of messages) {
      const text = messageText(message);
      if (text.length === 0) {
        continue;
      }
      const sender = message.sender;
      if (sender !== "human" && sender !== "assistant") {
        continue; // an unrecognised turn shape (e.g. a tool-use block); skip rather than fail the whole import
      }
      const input: RecordInput = {
        source: "claude-export",
        sourceRef,
        kind: "my_thinking",
        author: sender === "human" ? "me" : "assistant",
        text,
        timestamp: typeof message.created_at === "string" ? message.created_at : new Date(0).toISOString(),
        threadId,
        audience: "private",
      };
      records.push(createRecord(input));
    }
  });

  return { records, conversationCount: parsed.length, workRelevantConversationCount };
}
