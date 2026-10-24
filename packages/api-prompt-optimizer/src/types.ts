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
  PromptLibraryEntry,
  PromptLibrarySaveRequest,
  PromptOptimizeRequest,
  PromptOptimizeResult,
  PromptOptimizeTarget,
  PromptRoleEvolveRequest,
  PromptRoleEvolveResult,
  PromptRoleRecommendation,
  PromptRoleRecommendRequest,
  PromptRoleSummary,
  PromptVerifyRequest,
  PromptVerifyResult,
} from '@yimiliya/dsh-prompt-optimizer/types'
