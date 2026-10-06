import type { InferenceProvider } from "../provider/types.js";
import { rebuildDraftContext } from "./context.js";
import {
  currentCandidateText,
  DraftNotFoundError,
  DraftNotShapeableError,
  getDraft,
  recordShape,
  type DraftRecord,
  type ShapeInstruction,
} from "./draft-log.js";
import { buildShapePrompt } from "./generate.js";
import { deriveRecipientVoice } from "./recipient-voice.js";

/** Thrown when a shape is asked of a daemon with no inference provider — there is no model to rewrite with, and the extractive fallback has nothing to say about tone. */
export class ShapingUnavailableError extends Error {
  constructor() {
    super("Shaping a draft needs an inference provider, and none is configured.");
    this.name = "ShapingUnavailableError";
  }
}

/**
 * Regenerates one candidate of a pending draft with an instruction
 * (guangshinhaha/duo#258) — the one regeneration primitive, re-entering
 * the generation step without re-running retrieval: the draft's grounding
 * is rebuilt from the sources it already cites (rebuildDraftContext), so
 * the rewrite can only lean on that evidence pool, and its `sources` are
 * left exactly as they were. One model call, no self-consistency sampling
 * and no re-scoring — a shape changes how the draft says what it says, not
 * how sure the duo is of it, so the candidate keeps its confidence.
 *
 * Validated before the model is ever called (unknown draft, escalated,
 * settled, unknown alternative), and written atomically against the text it
 * was generated from (recordShape), so a slow rewrite can never clobber a
 * newer one. Every shape is logged in `draft_shapes` — the chip tap itself
 * is the training signal — and returns the updated draft.
 */
export async function shapeDraft(
  storePath: string,
  passphrase: string,
  duoDir: string,
  draftId: string,
  instruction: ShapeInstruction,
  alternative: number,
  inferenceProvider: InferenceProvider | undefined,
): Promise<DraftRecord> {
  const draft = getDraft(storePath, passphrase, draftId);
  if (!draft) {
    throw new DraftNotFoundError(draftId);
  }
  if (draft.escalated || draft.draftText === null) {
    throw new DraftNotShapeableError(`Draft "${draftId}" was passed to you, not drafted — there is no draft text to shape.`);
  }
  if (draft.outcome !== null) {
    throw new DraftNotShapeableError(`Draft "${draftId}" was already recorded as "${draft.outcome}" — only a pending draft can be shaped.`);
  }
  const fromText = currentCandidateText(draft, alternative);
  if (!inferenceProvider) {
    throw new ShapingUnavailableError();
  }

  const sources = draft.alternatives[alternative]?.sources ?? draft.sources;
  const rebuilt = rebuildDraftContext(storePath, passphrase, duoDir, sources);
  // duo#262: a draft addressed to someone keeps sounding like how the owner
  // writes to them — the shape changes tone or length on top of that, not
  // instead of it.
  const recipientVoice = draft.recipient !== null ? deriveRecipientVoice(storePath, passphrase, draft.recipient) : undefined;
  const context = recipientVoice !== undefined ? { ...rebuilt, recipientVoice } : rebuilt;
  const toText = (await inferenceProvider.complete(buildShapePrompt(draft.question, draft.threadContext, context, fromText, instruction))).trim();
  if (toText.length === 0) {
    throw new DraftNotShapeableError(`Your duo came back with nothing for that — the draft is unchanged.`);
  }
  // A rewrite identical to what it was given is not a version: logging it
  // would offer an Undo back to the same words, and count a preference the
  // draft never actually took on.
  if (toText.replace(/\s+/g, " ") === fromText.trim().replace(/\s+/g, " ")) {
    throw new DraftNotShapeableError(`Your duo couldn't make that ${instruction.replace("_", " ")} — the draft is unchanged.`);
  }
  return recordShape(storePath, passphrase, draftId, { alternative, instruction, fromText, toText });
}
