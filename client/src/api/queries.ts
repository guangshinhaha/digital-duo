import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { apiRequest, type DuoApiConfig } from "./client.js";
import type {
  AuditEntry,
  CorrectionCandidate,
  DraftOutcome,
  DraftPipelineResult,
  DraftRecord,
  DuoSummary,
  GridRow,
  InterruptionPortrait,
  Rule,
  RuleReviewListing,
} from "./types.js";

/**
 * Query keys mirror the routes (`client-tech-design.md` §3.2), so
 * invalidation reads as "which route changed" rather than a hand-maintained
 * list. `["drafts", opts]` and `["review"]` are invalidated together by any
 * outcome mutation — an "edited" outcome writes the draft row *and* queues
 * a correction candidate in one call, and missing the second invalidation
 * is the easiest bug to ship here (§3.2's own warning).
 */
export const queryKeys = {
  duos: ["duos"] as const,
  drafts: (opts?: { outcome?: DraftOutcome | "pending" }) => ["drafts", opts ?? {}] as const,
  draft: (id: string) => ["drafts", id] as const,
  review: ["review"] as const,
  mirrorPortrait: ["mirror", "portrait"] as const,
  mirrorRules: ["mirror", "rules"] as const,
  trustGrid: ["trust", "grid"] as const,
  audit: ["audit"] as const,
};

export function useDuos(api: DuoApiConfig, options?: Partial<UseQueryOptions<DuoSummary[]>>) {
  return useQuery({ queryKey: queryKeys.duos, queryFn: () => apiRequest<DuoSummary[]>(api, "/duos"), ...options });
}

export function usePendingDrafts(api: DuoApiConfig) {
  return useQuery({
    queryKey: queryKeys.drafts({ outcome: "pending" }),
    queryFn: () => apiRequest<DraftRecord[]>(api, "/drafts?outcome=pending"),
  });
}

export function useReview(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.review, queryFn: () => apiRequest<CorrectionCandidate[]>(api, "/review") });
}

export function useMirrorPortrait(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorPortrait, queryFn: () => apiRequest<InterruptionPortrait>(api, "/mirror/portrait") });
}

export function useMirrorRules(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorRules, queryFn: () => apiRequest<RuleReviewListing>(api, "/mirror/rules") });
}

export function useTrustGrid(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.trustGrid, queryFn: () => apiRequest<GridRow[]>(api, "/trust/grid") });
}

export function useAudit(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.audit, queryFn: () => apiRequest<AuditEntry[]>(api, "/audit") });
}

/** Creates a draft (the composer's submit action). Invalidates the pending-drafts list — the new draft (or escalation) should appear in Review immediately. */
export function useCreateDraft(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { question: string; threadContext?: string | null }) =>
      apiRequest<DraftPipelineResult>(api, "/drafts", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/**
 * Send / Edit / Ignore. Invalidates both `["drafts"]` and `["review"]` —
 * see this module's doc comment on why both, always, regardless of which
 * outcome was recorded (an "edited" outcome is the one that actually
 * queues a candidate, but invalidating unconditionally is simpler and
 * cheaper than branching on outcome to decide).
 */
export function useRecordOutcome(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, outcome, sentText }: { draftId: string; outcome: DraftOutcome; sentText?: string }) =>
      apiRequest(api, `/drafts/${draftId}/outcome`, { method: "POST", body: JSON.stringify({ outcome, sentText }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.review });
    },
  });
}

export function useAnswerEscalation(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, answer }: { draftId: string; answer: string }) =>
      apiRequest<{ candidateId: string }>(api, `/drafts/${draftId}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.review });
    },
  });
}

export function useRuleAction(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, action }: { ruleId: string; action: "approve" | "reject" | "promote" }) =>
      apiRequest<Rule>(api, `/mirror/rules/${ruleId}/${action}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mirrorRules });
    },
  });
}
