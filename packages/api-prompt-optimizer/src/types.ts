/**
 * Wire contracts for the experimental prompt-optimizer Remote. The shapes are
 * owned by the capability package; this module re-exports them so the Remote
 * surface and the client generation share one home per fact.
 * @module @yimiliya/dsh-api-prompt-optimizer/types
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** One optimization round failed; `reason` names the typed service failure. */
    'prompt-optimizer/optimization-failed': { readonly reason: string }
    /** One N-candidate round failed; `reason` names the typed service failure. */
    'prompt-optimizer/candidates-failed': { readonly reason: string }
    /** One skill-distillation round or write failed; `reason` names the typed service failure. */
    'prompt-optimizer/distill-failed': { readonly reason: string }
    /** One intent-clarification interview round failed; `reason` names the typed service failure. */
    'prompt-optimizer/interview-failed': { readonly reason: string }
    /** One local-metrics operation failed; `reason` names the typed service failure. */
    'prompt-optimizer/metrics-failed': { readonly reason: string }
    /** One acceptance-criterion check command failed to run; `reason` names the typed service failure. */
    'prompt-optimizer/verify-failed': { readonly reason: string }
    /** One acceptance-criterion check command was rejected by the host safety policy; `reason` names the matched deny rule. */
    'prompt-optimizer/verify-blocked': { readonly reason: string }
    /** One prompt-library operation failed; `reason` names the typed service failure. */
    'prompt-optimizer/library-failed': { readonly reason: string }
    /** Listing the roles directory failed; `reason` names the typed service failure. */
    'prompt-optimizer/roles-failed': { readonly reason: string }
    /** One role-definition evolution failed; `reason` names the typed service failure. */
    'prompt-optimizer/role-evolve-failed': { readonly reason: string }
  }
}

export type {
  ModelTier,
  PromptCandidate,
  PromptDistillRequest,
  PromptDistillResult,
  PromptCandidateScores,
  PromptCandidatesRequest,
  PromptCandidatesResult,
  PromptClarification,
  PromptInterviewQuestion,
  PromptInterviewRequest,
  PromptInterviewResult,
  PromptLibraryDeleteRequest,
  PromptLibraryEntry,
  PromptLibrarySaveRequest,
  PromptMetricKind,
  PromptMetricReportRequest,
  PromptMetricsSummary,
  PromptOptimizeDirection,
  PromptOptimizeRequest,
  PromptOptimizeResult,
  PromptOptimizeTarget,
  PromptRoleEvolveRequest,
  PromptRoleEvolveResult,
  PromptRoleRecommendation,
  PromptRoleRecommendRequest,
  PromptRoleSummary,
  PromptSkipReason,
  PromptVerifyRequest,
  PromptVerifyResult,
} from '@yimiliya/dsh-prompt-optimizer/types'
