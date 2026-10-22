/**
 * Public request, result, and log-event contracts for the experimental
 * prompt optimizer. Wire-safe plain data only: the Remote controller and the
 * browser client both consume these shapes unchanged.
 * @module dsh-prompt-optimizer/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Optimization target: a chat draft (one round) or a standing system prompt (rewrite plus critique round). */
export type PromptOptimizeTarget = 'draft' | 'system'

/** One selectable professional role from the configured roles directory. */
export interface PromptRoleSummary {
  /** Role slug matching a `<slug>.md` definition file in the configured roles directory. */
  readonly id: string
  /** Human-facing role name parsed from the definition's first heading; the slug when no heading exists. */
  readonly name: string
}

/** One recommended role with the evidence that surfaced it. */
export interface PromptRoleRecommendation {
  /** Recommended role slug. */
  readonly id: string
  /** Human-facing role name. */
  readonly name: string
  /** Deterministic keyword-overlap score against the request context. */
  readonly score: number
  /** Context tokens that matched this role, most valuable first. */
  readonly matched: readonly string[]
}

/** Wire request for context-based role recommendations. */
export interface PromptRoleRecommendRequest {
  /** Session whose pending inbox joins the recommendation context. */
  readonly sessionId: SessionId
  /** Draft text to recommend for; absent when only the inbox context applies. */
  readonly text?: string
}

/** Wire request for one optimization round over a conversation draft. */
export interface PromptOptimizeRequest {
  /** Session whose draft is being optimized; owns the request log and route fallback. */
  readonly sessionId: SessionId
  /** Complete current draft text, exactly as the composer holds it. */
  readonly text: string
  /** Previously rejected optimized texts, oldest first; a later round must differ from every entry. */
  readonly previousAttempts?: readonly string[]
  /** What the text is: `draft` (default) optimizes a chat message, `system` a standing system prompt with a critique round. */
  readonly target?: PromptOptimizeTarget
  /** Role slug whose definition styles the rewrite; absent for a generic rewrite. */
  readonly role?: string
  /**
   * Self-describing name of the language the rewrite must be written in (for
   * example `中文`); absent keeps the draft's language.
   */
  readonly language?: string
}

/** One draft acceptance criterion the rewritten prompt should be judged against. */
export interface PromptAcceptanceCriterion {
  /** Criterion statement in the draft's language. */
  readonly text: string
  /** `mechanical` when a runnable check command verifies it; `llm` when only judgment can. */
  readonly kind: 'mechanical' | 'llm'
  /** Runnable check command for a `mechanical` criterion; absent for `llm`. */
  readonly commandTemplate?: string
}

/** One completed optimization round ready for preview. */
export interface PromptOptimizeResult {
  /** Rewritten prompt text; never empty for a completed round. */
  readonly optimizedText: string
  /** Short per-change accounts in the draft's language; empty when the model listed none. */
  readonly changes: readonly string[]
  /** Draft acceptance criteria for the rewritten prompt; empty when the model listed none. */
  readonly acceptance: readonly PromptAcceptanceCriterion[]
  /** Critique-round revisions from `system` targets; absent for `draft` targets. */
  readonly critique?: readonly string[]
  /** Exact provider route that produced the result. */
  readonly provider: string
  /** Exact model id that produced the result. */
  readonly model: string
  /** Role slug that styled the round; absent when no role was requested. */
  readonly role?: string
  /** Usage from the stream's `usage` chunk; absent until one arrives. */
  readonly usage?: TokenUsage
}

/** Wire request to execute one acceptance criterion's check command in the Session's workspace. */
export interface PromptVerifyRequest {
  /** Session whose workspace the command runs in; owns the verify log. */
  readonly sessionId: SessionId
  /** Criterion statement the command verifies, for the log record. */
  readonly criterion: string
  /** Fully substituted check command to execute. */
  readonly command: string
}

/** Outcome of one executed check command. */
export interface PromptVerifyResult {
  /** True exactly when the command exited 0. */
  readonly passed: boolean
  /** Exit code the command reported; null when it died to a signal or timed out. */
  readonly exitCode: number | null
  /** True when the verify deadline, not the command, ended the run. */
  readonly timedOut: boolean
  /** Combined stdout and stderr, truncated to the service's output cap. */
  readonly output: string
  /** Wall time from dispatch to completion. */
  readonly durationMs: number
}

/** Wire request to save one adopted optimization result into the prompt library. */
export interface PromptLibrarySaveRequest {
  /** Session that produced the entry; recorded as provenance. */
  readonly sessionId: SessionId
  /** Human-facing library title; non-empty. */
  readonly title: string
  /** Complete optimized text to store; non-empty. */
  readonly text: string
}

/** One persisted library entry. */
export interface PromptLibraryEntry {
  /** Stable library id of the entry. */
  readonly id: string
  /** Human-facing title. */
  readonly title: string
  /** Stored prompt text. */
  readonly text: string
  /** ISO timestamp of the save. */
  readonly createdAt: string
  /** Session that produced the entry, as provenance. */
  readonly sourceSessionId: SessionId
}

/** Settings section this plugin's bundle page edits over the `prompt-optimizer` namespace. */
export interface PromptOptimizerSettings {
  /** Role slug applied to every request carrying no explicit `role`; absent for no default. */
  readonly defaultRole?: string
}
