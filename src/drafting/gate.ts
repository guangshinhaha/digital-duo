import { appendGateDecision, type GateDecisionEntry } from "./gate-log.js";
import { classifyMention, type GateVerdict } from "./relevance-gate.js";
import { readRefusalsFile } from "./refusals.js";

/** An inbound message directed at the owner — a Slack mention once epic e8 ships, hand-supplied in the meantime (e.g. by a test or `duo derive`'s eventual eval harness). */
export interface Mention {
  readonly text: string;
  readonly from?: string;
}

export interface GateOutcome extends GateVerdict {
  /** The gate_decisions row id this call wrote (#31's own "every decision is logged" requirement). */
  readonly logId: string;
}

/**
 * The personal duo's relevance gate: reads `duo/refusals.md`, classifies
 * the mention (classifyMention), and logs the decision — the one function
 * a future Slack mention handler (epic e8) is meant to call. Deliberately
 * separate from the CLI's `duo draft <question>` path (#32): a question the
 * owner types themselves is, by construction, a question they want
 * answered, not an inbound mention that might be noise — so that path
 * checks refusals directly (via matchesRefusedSubject) rather than running
 * the noise/question classifier over the owner's own input.
 */
export function runRelevanceGate(storePath: string, passphrase: string, duoDir: string, mention: Mention): GateOutcome {
  const refusals = readRefusalsFile(duoDir);
  const verdict = classifyMention(mention.text, refusals);
  const logId = appendGateDecision(storePath, passphrase, {
    mentionText: mention.text,
    from: mention.from,
    passes: verdict.passes,
    reason: verdict.reason,
  });
  return { ...verdict, logId };
}

export type { GateDecisionEntry };
export { listGateDecisions } from "./gate-log.js";
