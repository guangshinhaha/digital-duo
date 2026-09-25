import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { ClassificationLevel } from "../ingest/record.js";
import { isWithinCeiling } from "../permissions/classification.js";
import type {
  WorkspaceAttachmentDoor,
  WorkspaceAttachmentDoorResult,
  WorkspaceFileBody,
  WorkspaceGroundedAttachment,
} from "../workspace/transport.js";

/**
 * #190/#183: the attachment grounding door — the duo's own door, run
 * between the question filter and the answering pipeline. "Attach" means
 * ephemeral grounding and never import (docs/workspace/attachments.md §1),
 * and everything this module does is that record's §6/§7 as code:
 *
 * **The order is load-bearing.** Count → type → declared size → the read
 * (cut at the bound) → classification ceiling → grounding. The first three
 * run before any byte of any body is read (`fetchFile` is not called until
 * they all pass — pinned by test), and the ceiling check runs before
 * grounding, before prompt assembly, before any model sees the text (#34's
 * shape: a refused attachment escalates without reasoning about it; nothing
 * below the check ever runs).
 *
 * **The workspace never classifies and never strips (§6)** — it serves
 * files verbatim so THIS door can read the marking. The ceiling is the
 * owner's policy (`DUO_CLASSIFICATION_CEILING`), and two duos in one room
 * may legitimately differ. Above the ceiling: refused, naming the marking
 * — never stripped-into-use, never quarantined. Within it: the marking
 * line is stripped HERE, once, at the boundary, so every downstream echo
 * (source label, extractive quote, provider prompt — the #164 residual,
 * closed for this path by stripping before the prompt is built rather than
 * after) would have to re-invent a marking it never received to echo one.
 * Unmarked ("unknown") grounds: the asker supplied the file and it passed
 * no gate that could have minted a clearance.
 *
 * **Nothing is retained (§3).** The decoded text lives in the returned
 * value — daemon memory — for exactly one draft call: no record, no
 * embedding, no draft-log copy of the body, no staging file. What the
 * draft log keeps is the source row's `id` (the file reference) and
 * `label`, built in pipeline.ts. And structurally there is no import here:
 * this module's imports are an allowlist pinned by test — the read-only
 * classification helpers, the ceiling comparison, and the seam's types —
 * so no path from a conversation file into the corpus can grow inside the
 * door. Importing a document remains the existing, explicit, owner-only
 * ingest path, unchanged (§4).
 *
 * Why this module lives under drafting and is injected into the service
 * rather than living in src/workspace: the pinned import boundary
 * (test/workspace-payload.test.ts) keeps src/workspace off the ingest and
 * drafting modules the door needs; like the answering pipeline, the door
 * arrives by injection (commands/serve.ts wires it) and this file never
 * touches the seam's implementations.
 */

/** §7: 32 KiB of text per attachment — one whole attachment plus the rest of the prompt fits the ~8k-token floor of the smallest supported local model contexts without truncation games. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024;

/** §7: at most 3 attachments per question. */
export const MAX_ATTACHMENTS_PER_QUESTION = 3;

/** §7: the only types a duo may ground on — there is no extraction pipeline in v1 for anything else. */
export const GROUNDING_ATTACHMENT_MIME_TYPES = ["text/plain", "text/markdown"] as const;

/** KiB with one decimal, for refusal messages that name the size they broke (e.g. "45.0 KiB"). */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * A filename is sender-chosen free text that this module echoes into
 * asker-visible refusals (and, via the grounded attachment's name, into
 * source labels and prompt headers downstream) — bounded here, once, at
 * the boundary, so no echo of it can balloon a message or a prompt. Same
 * shape as pipeline.ts's label truncate.
 */
function displayName(name: string): string {
  const max = 80;
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * Normalizes a declared MIME type for comparison: parameters after `;`
 * (`text/plain; charset=utf-8`) carry nothing the door decides on, and
 * type/subtype is case-insensitive by RFC 2045.
 */
function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

function refused(message: string): WorkspaceAttachmentDoorResult {
  return { kind: "refused", message };
}

/** §7's image refusal: shared yes, grounded no — blocked on #14's open provider decision, stated as that dependency rather than hand-waved. */
function imageRefusal(name: string): string {
  return (
    `I can't read images, so I won't ground on "${name}" — deciding which inference provider may ` +
    "process this corpus is still an open decision, and until it is made I won't pretend to see image content. " +
    "The image stays shared in the conversation."
  );
}

/** §7's other-type refusal: the reason stated is the real one — no extraction pipeline exists — not "unsupported". The declared type is bounded the same way the name is — it is sender-chosen free text too. */
function ungroundableTypeRefusal(name: string, mimeType: string | null): string {
  const type = mimeType === null ? "its type wasn't declared" : `it is a ${displayName(mimeType)} file`;
  return (
    `I can't ground on "${name}" — ${type}, and I can only ground on plain text (text/plain) and Markdown ` +
    "(text/markdown): there is no extraction pipeline to read document formats yet. " +
    "The file stays shared in the conversation."
  );
}

function sizeRefusal(name: string, detail: string): string {
  return (
    `"${name}" is ${detail} — over the ${kib(MAX_ATTACHMENT_BYTES)} per attachment I can ground on. ` +
    "A document that needs to be bigger is import-shaped (chunked, embedded, retrieved), not attachment-shaped: " +
    "the owner can import it into the corpus as their own explicit act."
  );
}

/**
 * Builds the door for one owner's ceiling. The ceiling arrives parsed and
 * validated (parseClassificationCeiling) — the same value ingest's boundary
 * reads, because this is the same policy applied at a different door.
 */
export function attachmentGroundingDoor(ceiling: ClassificationLevel): WorkspaceAttachmentDoor {
  return async (attachments, fetchFile): Promise<WorkspaceAttachmentDoorResult> => {
    // --- Count, type, and declared size: decided before any body is read. ---
    if (attachments.length > MAX_ATTACHMENTS_PER_QUESTION) {
      return refused(
        `I can ground on at most ${MAX_ATTACHMENTS_PER_QUESTION} attachments per question — this question carries ` +
          `${attachments.length}. The files all stay shared in the conversation; ask again with fewer.`,
      );
    }
    for (const attachment of attachments) {
      const name = displayName(attachment.name);
      const mimeType = attachment.mimeType === null ? null : normalizeMimeType(attachment.mimeType);
      if (mimeType !== null && mimeType.startsWith("image/")) {
        return refused(imageRefusal(name));
      }
      if (mimeType === null || !(GROUNDING_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType)) {
        return refused(ungroundableTypeRefusal(name, attachment.mimeType));
      }
      if (attachment.size !== null && attachment.size > MAX_ATTACHMENT_BYTES) {
        return refused(sizeRefusal(name, kib(attachment.size)));
      }
    }

    // --- The read, cut at the bound (§7): a declared size that understates
    // --- the body is caught here, not by trusting the declaration.
    const grounded: WorkspaceGroundedAttachment[] = [];
    for (const attachment of attachments) {
      const name = displayName(attachment.name);
      const mimeType = normalizeMimeType(attachment.mimeType!); // passed the declaration checks above
      let body: WorkspaceFileBody;
      try {
        body = await fetchFile(attachment.reference, { maxBytes: MAX_ATTACHMENT_BYTES });
      } catch {
        // §3's deletion case, and every other retrieval failure: the
        // grounding is lost, the question is refused with a recoverable
        // reason (duo#66's AC: the failure is stated, nothing is lost — the
        // file message itself is workspace data and stays right where it
        // was). Never a guess, never a silent pass-through to text-only.
        return refused(
          `I couldn't retrieve "${name}" from the workspace file store — it may have been deleted since it was ` +
            "shared, or the connection dropped; sharing it again and re-asking will work either way.",
        );
      }
      if (body.exceededMaxBytes) {
        return refused(sizeRefusal(name, `larger than ${kib(MAX_ATTACHMENT_BYTES)}`));
      }

      // --- The classification ceiling: the same read ingest makes, on the
      // --- decoded text, before any grounding happens (§6).
      const text = new TextDecoder().decode(body.bytes);
      const classification = detectClassification(text);
      if (!isWithinCeiling(classification, ceiling)) {
        return refused(
          `I won't ground on "${name}": it is marked ${classification}, which is above the classification ` +
            `ceiling this duo's owner has set (${ceiling}). I won't reason about its contents at all — the file ` +
            "stays shared in the conversation.",
        );
      }

      // --- Within the ceiling: ground, with the marking stripped here so
      // --- no downstream echo can repeat it (#164's residual, closed for
      // --- this path at the source).
      grounded.push({
        reference: attachment.reference,
        name,
        mimeType,
        text: stripMarkingLine({ text, classification }),
      });
    }
    return { kind: "grounded", grounding: grounded };
  };
}
