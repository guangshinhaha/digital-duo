import type { RankedRecord } from "../ingest/record-store.js";
import type { EmbeddingProvider } from "../provider/types.js";
import { hybridSearch } from "../ingest/embeddings.js";
import type { ClassificationLevel } from "../ingest/record.js";
import { isVisibleToClearance } from "./classification.js";
import { type AskerResolution, effectiveClearance, loadDirectory, resolveAsker } from "./directory.js";

export type ExclusionReason = "above_clearance" | "unknown_requires_top_clearance";

export interface ExcludedRecord extends RankedRecord {
  readonly reason: ExclusionReason;
}

export interface PermissionedRetrievalOutcome {
  /** How the asker resolved — carried through so a caller can log/trace it (#49 AC3). */
  readonly asker: AskerResolution;
  /** The clearance actually applied to this retrieval. */
  readonly clearance: ClassificationLevel;
  /**
   * What the asker's clearance permits — this, and only this, is what a
   * generation step may ever be handed. The name is deliberate: #49's own
   * acceptance criteria call this "a generation context", and this field
   * is exactly that boundary.
   */
  readonly generationContext: readonly RankedRecord[];
  /** What matched the query but was filtered out before generation, and why — the trace #49 AC3 asks for. */
  readonly excluded: readonly ExcludedRecord[];
  readonly usedEmbeddings: boolean;
  readonly warning?: string;
}

/**
 * The one entry point derivation/drafting/answering code should ever call
 * to get retrieval results for a *specific asker* (as opposed to #20's
 * hybridSearch, which is the owner's own unfiltered search). Resolution
 * happens first — directory lookup, then clearance — and only then does
 * retrieval run; the filter is applied to the candidate set the moment it
 * comes back, before anything downstream ever sees it (#49 AC3: "a trace
 * shows filtering occurred pre-generation rather than as a post-hoc
 * redaction"). There is no code path here through which an excluded
 * record reaches `generationContext`.
 */
export async function retrieveForAsker(
  storePath: string,
  passphrase: string,
  query: string,
  provider: EmbeddingProvider,
  askerRef: string,
  duoDir: string,
  limit = 10,
): Promise<PermissionedRetrievalOutcome> {
  const directory = loadDirectory(duoDir);
  const asker = resolveAsker(askerRef, directory);
  const clearance = effectiveClearance(asker);

  const hybrid = await hybridSearch(storePath, passphrase, query, provider, limit);

  const generationContext: RankedRecord[] = [];
  const excluded: ExcludedRecord[] = [];
  for (const ranked of hybrid.results) {
    if (isVisibleToClearance(ranked.record.classification, clearance)) {
      generationContext.push(ranked);
    } else {
      excluded.push({
        ...ranked,
        reason: ranked.record.classification === "unknown" ? "unknown_requires_top_clearance" : "above_clearance",
      });
    }
  }

  return { asker, clearance, generationContext, excluded, usedEmbeddings: hybrid.usedEmbeddings, warning: hybrid.warning };
}
