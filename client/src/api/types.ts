/**
 * Client-side mirrors of the daemon's domain types. `client-tech-design.md`
 * §1.4: "Responses return the domain types verbatim. No DTO layer" — that
 * rule is about the *server* never inventing a second shape, not about the
 * two npm packages sharing a TypeScript project reference (this client is
 * a separate package from the CLI/daemon, so there's no way to `import
 * type` across that boundary without a workspace-wide build step this
 * pass doesn't add). These are kept intentionally minimal and are the one
 * place a server-side type change must be mirrored by hand — see
 * `src/drafting/pipeline.ts`, `src/drafting/draft-log.ts`, etc. for the
 * authoritative shapes this file must never drift from silently.
 */

export type DuoSummary = { kind: "personal" } | { kind: "shared"; ownerId: string; ownerName: string };

export interface DraftSource {
  kind: "rule" | "evidence";
  id: string;
  label: string;
}

// Mirrors the daemon's own split (src/drafting/draft-log.ts):
// SETTABLE_DRAFT_OUTCOMES is what this client may POST to
// /drafts/:id/outcome; DRAFT_OUTCOMES adds "escalation_answered", which
// the daemon writes itself the moment an escalation is answered and this
// client only ever reads back, never sets.
export const SETTABLE_DRAFT_OUTCOMES = ["sent", "edited", "discarded"] as const;
export type SettableDraftOutcome = (typeof SETTABLE_DRAFT_OUTCOMES)[number];

export const DRAFT_OUTCOMES = [...SETTABLE_DRAFT_OUTCOMES, "escalation_answered"] as const;
export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];

export interface ConfidenceResult {
  score: number;
  passesThreshold: boolean;
  threshold: number;
}

export interface DraftRecord {
  id: string;
  question: string;
  threadContext: string | null;
  draftText: string | null;
  escalated: boolean;
  escalationReason: string | null;
  confidenceScore: number;
  sources: DraftSource[];
  createdAt: string;
  outcome: DraftOutcome | null;
  outcomeRecordedAt: string | null;
  sentText: string | null;
  /** True only for a refused-subject escalation — a real stored field, not derived from escalationReason's text (src/drafting/draft-log.ts's own reasoning for why). */
  refused: boolean;
  /** The composite-confidence escalation threshold that was actually in effect when this draft was generated — what ConfidenceHairline compares confidenceScore against, instead of a hardcoded guess. */
  escalationThreshold: number;
}

/**
 * What `POST /drafts` actually returns — a discriminated union on `kind`,
 * mirroring `DraftPipelineResult` (`src/drafting/pipeline.ts`). `refused`
 * is what lets the UI tell "won't" from "can't" without parsing `reason`.
 */
export type DraftPipelineResult =
  | { kind: "draft"; draftId: string; text: string; sources: DraftSource[]; confidence: ConfidenceResult }
  | { kind: "escalation"; draftId: string; reason: string; refused: boolean; confidence: ConfidenceResult | undefined };

export const CORRECTION_CANDIDATE_KINDS = ["style", "substance"] as const;
export type CorrectionCandidateKind = (typeof CORRECTION_CANDIDATE_KINDS)[number];

export interface CorrectionCandidate {
  id: string;
  kind: CorrectionCandidateKind;
  draftId: string;
  question: string;
  draftText: string;
  sentText: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
}

export interface TopicShare {
  topicId: string;
  label: string;
  count: number;
  share: number;
}

export interface ThreadShare {
  threadId: string;
  count: number;
  share: number;
}

export interface InterruptionPortrait {
  totalQuestions: number;
  periodStart: string | null;
  periodEnd: string | null;
  topicBreakdown: TopicShare[];
  topFiveShare: number;
  busiestThreads: ThreadShare[];
  insufficientHistory?: boolean;
}

export type RuleReviewStatus = "pending" | "approved" | "rejected" | "superseded";
export type RuleOrigin = "derived" | "owner_asserted";

export interface Rule {
  id: string;
  topicId: string;
  text: string;
  status: "confirmed" | "inconsistent" | "weak_signal";
  supportCount: number;
  consistency: number;
  createdAt: string;
  lastConfirmedAt: string | null;
  reviewStatus: RuleReviewStatus;
  origin: RuleOrigin;
}

export interface RuleReviewListing {
  awaitingApproval: Rule[];
  weakSignals: Rule[];
  inconsistent: Rule[];
  approved: Rule[];
  rejected: Rule[];
}

export type TrustTier = "T0" | "T1" | "T2" | "T3";
export type AutonomyLevel = "ask" | "approve" | "auto";

export interface GridRow {
  topicId: string;
  topicLabel: string | undefined;
  tier: TrustTier;
  level: AutonomyLevel;
  source: "earned" | "granted";
  stale: boolean;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  question: string;
  askerRef: string;
  askerResolved: boolean;
  declined: boolean;
  answerText: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
