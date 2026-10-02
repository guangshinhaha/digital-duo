import { strFromU8, unzipSync } from "fflate";
import { MalformedExportError } from "./claude-export.js";

/**
 * Pulled out of a Claude data export zip's top-level listing, or nested one
 * directory deep — real exports have shipped both ways across export
 * versions — by basename, case-insensitively: `conversations.json` is the
 * one file `parseClaudeExport` (claude-export.ts) knows how to read, and
 * everything else in the zip (`users.json`, `projects.json`, attached
 * files) is ignored, same as the paste path only ever sees the one file an
 * owner extracted and pasted.
 */
const CONVERSATIONS_ENTRY = /(^|\/)conversations\.json$/i;

/**
 * Unzips a Claude data export and returns `conversations.json`'s contents
 * as text, ready for `parseClaudeExport`. Reuses `MalformedExportError` —
 * the same type `parseClaudeExport` throws for a bad `conversations.json`
 * — for a bad zip too, so one `catch` in the serve layer (owner-routes.ts)
 * maps both to the same 400: the acceptance criteria treats "not a zip" and
 * "a zip with no conversations.json" identically ("says what was
 * expected, and nothing is imported"), and the owner never needs to tell
 * which kind of malformed file they sent.
 */
export function extractConversationsJson(zipBytes: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (cause) {
    throw new MalformedExportError(
      `Expected a Claude data export: a zip file containing conversations.json. The uploaded file is not a valid zip (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  }

  const names = Object.keys(entries);
  const match = names.find((name) => CONVERSATIONS_ENTRY.test(name));
  if (!match) {
    const found = names.length > 0 ? names.join(", ") : "(empty zip)";
    throw new MalformedExportError(
      `Expected a Claude data export: a zip file containing conversations.json. Found: ${found}.`,
    );
  }

  try {
    return strFromU8(entries[match]);
  } catch (cause) {
    throw new MalformedExportError(
      `Expected a Claude data export: conversations.json inside the zip could not be read as text (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  }
}
