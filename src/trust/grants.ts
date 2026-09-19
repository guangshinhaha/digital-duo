import { readTopicsFile } from "../derivation/topics.js";
import { withDatabase } from "../store/store.js";
import { ensureTrustSchema, upsertCellRow, type TrustTier } from "./grid.js";
import { appendLedgerEntry, ensureTrustLedgerSchema } from "./ledger.js";
import { findConflictingRefusal, type Refusal } from "./refusals.js";

/**
 * `docs/concept.md` §6: two routes to autonomy, "earned" (the ledger, #54)
 * and "granted" (standing orders, this module). A grant moves a cell
 * straight to `"auto"` — that is what "granted outright" means — for
 * every tier except T3, which #59 caps at `"approve"` even on a grant
 * ("no T3 action is autonomous on first grant... every one enters as
 * draft-and-approve"). A partial grant to `"approve"` for any other tier
 * isn't part of the story #53 describes, and would need its own
 * confirmation semantics that issue didn't specify.
 */

export interface GrantCandidate {
  readonly topicId: string;
  readonly label: string;
  readonly score: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Deterministic word-overlap heuristic — the same "documented v1 stand-in"
 * idiom `work-relevance.ts`/`decision-guard.ts` use rather than an LLM
 * dependency for something this codebase can already do without one. Scores
 * how much of a topic's own label is covered by the grant's free text, so a
 * short, specific label ("Deploy access") scores fully against a longer
 * description that mentions it, while a broad or unrelated topic scores low
 * or zero.
 */
function scoreTopicAgainst(scopeText: string, label: string): number {
  const labelTokens = tokenize(label);
  if (labelTokens.length === 0) {
    return 0;
  }
  const scopeTokens = new Set(tokenize(scopeText));
  const overlap = labelTokens.filter((token) => scopeTokens.has(token)).length;
  return overlap / labelTokens.length;
}

/** Every topic the grant's free text could plausibly refer to, best match first. Topics that score 0 (no overlap at all) are left out entirely — "no match" is a real, reportable outcome, not just a low score. */
export function matchTopicsForGrant(duoDir: string, scopeText: string): GrantCandidate[] {
  return readTopicsFile(duoDir)
    .map((topic) => ({ topicId: topic.id, label: topic.label, score: scoreTopicAgainst(scopeText, topic.label) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface GrantInput {
  /** Plain-English description of what's being granted, e.g. "point people at the runbook for deploy access". Always recorded in the ledger, even when `topicId` is given explicitly. */
  readonly scopeText: string;
  readonly tier: TrustTier;
  /** Skips matching entirely and grants exactly this topic — how the owner confirms an ambiguous match (#53 AC2): re-run with the chosen candidate's id. */
  readonly topicId?: string;
}

export type GrantOutcome =
  | { readonly status: "applied"; readonly topicId: string; readonly topicLabel: string; readonly tier: TrustTier }
  | { readonly status: "ambiguous"; readonly candidates: readonly GrantCandidate[] }
  | { readonly status: "no_match" }
  | { readonly status: "topic_not_found"; readonly topicId: string }
  | { readonly status: "refused"; readonly refusal: Refusal };

/**
 * Implements #53's core story: write a grant in plain words, have it take
 * effect immediately (AC1) unless its scope is ambiguous (AC2, resolved by
 * the owner re-calling with an explicit `topicId`) or it conflicts with a
 * standing refusal (AC3, which always wins). There is no separate
 * "approve" step distinct from calling this function — the owner invoking
 * it (a CLI command only they can run; #53's own out-of-scope note: nobody
 * else grants on their behalf) *is* the approval "AC1: when it is approved"
 * describes, so writing and approving a grant are the same action here.
 */
export function grantAutonomy(storePath: string, passphrase: string, duoDir: string, input: GrantInput): GrantOutcome {
  const topics = readTopicsFile(duoDir);

  let topicId: string;
  let topicLabel: string;
  if (input.topicId !== undefined) {
    const topic = topics.find((candidate) => candidate.id === input.topicId);
    if (!topic) {
      return { status: "topic_not_found", topicId: input.topicId };
    }
    topicId = topic.id;
    topicLabel = topic.label;
  } else {
    const candidates = matchTopicsForGrant(duoDir, input.scopeText);
    if (candidates.length === 0) {
      return { status: "no_match" };
    }
    const topScore = candidates[0].score;
    const tiedForTop = candidates.filter((candidate) => candidate.score === topScore);
    if (tiedForTop.length > 1) {
      return { status: "ambiguous", candidates: tiedForTop };
    }
    topicId = candidates[0].topicId;
    topicLabel = candidates[0].label;
  }

  const conflict = findConflictingRefusal(duoDir, topicId, topicLabel);
  if (conflict) {
    return { status: "refused", refusal: conflict };
  }

  // #59 AC ("no T3 action is autonomous on first grant: every one enters
  // as draft-and-approve") — a standing-order grant on a T3 cell lands at
  // "approve", never "auto", unlike every other tier. In practice the
  // action-ladder's own T3 module (`src/actions/binding.ts`) never even
  // reads this cell's level — every T3 action is staged for approval
  // regardless — but capping it here too means the trust grid itself
  // never *claims* an autonomy this codebase doesn't act on, which would
  // be misleading to an owner reading `duo trust grid`.
  const grantedLevel = input.tier === "T3" ? "approve" : "auto";

  withDatabase(storePath, passphrase, true, (db) => {
    ensureTrustSchema(db);
    ensureTrustLedgerSchema(db);
    const now = new Date().toISOString();
    upsertCellRow(db, {
      topicId,
      tier: input.tier,
      level: grantedLevel,
      source: "granted",
      cleanStreak: 0,
      lastOfferStreak: null,
      lastOfferStatus: null,
      demotionAnnounced: true,
      updatedAt: now,
    });
    appendLedgerEntry(db, { topicId, tier: input.tier, eventType: "granted", detail: { scopeText: input.scopeText, topicLabel, level: grantedLevel } });
  });

  return { status: "applied", topicId, topicLabel, tier: input.tier };
}
