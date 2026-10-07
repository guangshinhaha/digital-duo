import { detectClassification, stripMarkingLine } from "../ingest/record.js";
import type { EmbeddingProvider, InferenceProvider } from "../provider/types.js";
import { gatherDraftContext, type DraftContext } from "./context.js";
import type { DraftSource } from "./draft-log.js";

/**
 * Same bar `fact-check.ts` uses: below this retrieved-evidence similarity a
 * candidate fact is too tenuously related to the message being explained to
 * even show the model — keeps the citation honest (duo#283 AC2/AC3) rather
 * than padding it with weak matches. A standing-order hit carries no
 * similarity score of its own and is always eligible, same reasoning as
 * `fact-check.ts`.
 */
const RETRIEVAL_FLOOR = 0.55;

export interface ExplainResult {
  readonly explanation: string;
  readonly sources: readonly DraftSource[];
}

/**
 * Thrown when there is no safe way to explain — acronym expansion and
 * "what's the background here" both need a model's general knowledge, and
 * (like `rewrite.ts`'s `RewriteUnavailableError`) there is no safe
 * deterministic fallback: guessing at what an acronym means without a model
 * would be worse than visibly declining. The route this feeds turns it into
 * a 503, never a silent "nothing to explain".
 */
export class ExplainUnavailableError extends Error {
  constructor() {
    super("Explaining a message needs a configured inference provider.");
    this.name = "ExplainUnavailableError";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Candidate {
  readonly source: DraftSource;
  readonly fact: string;
}

/** Same source-label conventions as `fact-check.ts`'s own `candidatesOf` (itself matching `pipeline.ts`'s `buildSources`) — one owner reading a draft's sources, a fact-check's source, and an explanation's sources should see the same shape of label. */
function candidatesOf(context: DraftContext): Candidate[] {
  const candidates: Candidate[] = [];
  if (context.ruleHit) {
    const strippedRule = stripMarkingLine({ text: context.ruleHit.text, classification: detectClassification(context.ruleHit.text) });
    candidates.push({
      source: { kind: "rule", id: context.ruleHit.id, label: `standing order: ${truncate(strippedRule, 80)}` },
      fact: strippedRule,
    });
  }
  for (const item of context.evidence) {
    if (item.similarity < RETRIEVAL_FLOOR) {
      continue;
    }
    const strippedEvidence = stripMarkingLine(item);
    candidates.push({
      source: { kind: "evidence", id: item.recordId, label: `past exchange (similarity ${item.similarity.toFixed(2)}): ${truncate(strippedEvidence, 80)}` },
      fact: strippedEvidence,
    });
  }
  return candidates;
}

function buildExplainPrompt(text: string, threadContext: string | null, candidates: readonly Candidate[]): string {
  const facts = candidates.length > 0 ? candidates.map((candidate, index) => `[${index}] ${candidate.fact}`).join("\n") : "(none retrieved)";
  return [
    "A member of this workspace received the message below and privately asked their own duo to explain it to them — this is for them alone, never posted anywhere. Explain any acronym, jargon, or missing background a reasonable colleague might not have, in plain words.",
    "",
    "Known facts you may draw on (indexed):",
    facts,
    ...(threadContext ? ["", "Conversation so far:", threadContext] : []),
    "",
    "The message to explain:",
    text,
    "",
    'Reply with ONLY JSON, nothing else, in exactly this shape: {"explanation": string, "usedIndices": number[]}.',
    '"explanation" is a short, plain-prose explanation — if there is genuinely nothing to explain, say so plainly instead of padding. "usedIndices" lists only the indices above (from "Known facts") that the explanation actually drew on — [] when none did, and never an index that was not shown. Never invent a fact or a source that is not one of the indexed ones above; general knowledge not tied to any of them simply gets no index.',
  ].join("\n");
}

interface ParsedExplanation {
  readonly explanation: string;
  readonly usedIndices: readonly number[];
}

/** Best-effort JSON extraction, same tolerance as `fact-check.ts`'s `parseVerdict`: a model that wraps its answer in prose or a code fence despite the instruction still gets read. Any failure here is a missing/malformed response, never a thrown error. */
function parseExplanation(raw: string): ParsedExplanation | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as Partial<ParsedExplanation>;
    if (typeof parsed.explanation !== "string" || !Array.isArray(parsed.usedIndices) || !parsed.usedIndices.every((i) => typeof i === "number")) {
      return undefined;
    }
    return { explanation: parsed.explanation, usedIndices: parsed.usedIndices };
  } catch {
    return undefined;
  }
}

/**
 * duo#283: privately explains `text` — a message the member received, not
 * necessarily one the duo wrote or the owner sent — using the same
 * retrieval `draftReply`/`checkOwnerText` already run (`gatherDraftContext`,
 * no clearance ceiling: this route is owner-only, same table-separation
 * `/compose/rewrite` and `/compose/fact-check` already rely on, so there is
 * nothing here the member couldn't already see in their own corpus — AC3).
 *
 * Conservative the same way `fact-check.ts` is, minus the two-call
 * agreement (this is an explanation, not a flag that could embarrass
 * someone if wrong — lower stakes, private to the owner alone):
 *
 * - No configured inference provider → throws `ExplainUnavailableError`,
 *   same reasoning as `rewrite.ts`: there is no safe deterministic fallback
 *   for "explain this acronym".
 * - Only facts retrieved at or above `RETRIEVAL_FLOOR`, or an explicit
 *   confirmed+approved standing order, are even shown to the model.
 * - Sources returned are only the ones the model actually said it drew on
 *   (`usedIndices`), filtered against the real candidate list — never a
 *   source the model merely saw but didn't cite, and never one it invented
 *   (AC2: "it cites what it drew on").
 * - A malformed or empty response throws the same unavailable error rather
 *   than guessing.
 */
export async function explainMessage(
  storePath: string,
  passphrase: string,
  duoDir: string,
  text: string,
  threadContext: string | null,
  embeddingProvider: EmbeddingProvider,
  inferenceProvider: InferenceProvider | undefined,
): Promise<ExplainResult> {
  if (!inferenceProvider) {
    throw new ExplainUnavailableError();
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { explanation: "There's nothing in this message to explain.", sources: [] };
  }

  const context = await gatherDraftContext(storePath, passphrase, duoDir, trimmed, embeddingProvider, 5);
  const candidates = candidatesOf(context);

  let raw: string;
  try {
    raw = await inferenceProvider.complete(buildExplainPrompt(trimmed, threadContext, candidates));
  } catch {
    throw new ExplainUnavailableError();
  }

  const parsed = parseExplanation(raw);
  if (!parsed || parsed.explanation.trim().length === 0) {
    throw new ExplainUnavailableError();
  }

  const usedIndices = Array.from(new Set(parsed.usedIndices)).filter((index) => candidates[index] !== undefined);
  const sources = usedIndices.map((index) => candidates[index]!.source);

  return { explanation: parsed.explanation.trim(), sources };
}
