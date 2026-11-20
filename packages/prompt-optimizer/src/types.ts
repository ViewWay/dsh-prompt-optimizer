/**
 * Public request, result, and log-event contracts for the experimental
 * prompt optimizer. Wire-safe plain data only: the Remote controller and the
 * browser client both consume these shapes unchanged.
 * @module @yimiliya/dsh-prompt-optimizer/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Optimization target: a chat draft (one round) or a standing system prompt (rewrite plus critique round). */
export type PromptOptimizeTarget = 'draft' | 'system'

/**
 * Direction the next rewrite should push toward. Fixed set — no free text —
 * so a request can never smuggle arbitrary instructions into the system
 * prompt.
 */
export type PromptOptimizeDirection = 'concise' | 'detailed' | 'technical' | 'structured' | 'acceptance'

/**
 * Capability tier of the model the rewrite targets, decided from the resolved
 * route: `reasoning` models plan internally (elaborate prompting scaffolding
 * adds noise), `local-small` models behind self-hosted gateways need every
 * invariant spelled out, `standard` covers the remaining chat models.
 */
export type ModelTier = 'reasoning' | 'local-small' | 'standard'

/** Why a round was declined instead of rewritten; the client localizes the advice. */
export type PromptSkipReason = 'reasoning-short-clear'

/** One clarifying question the interviewer round asked, with its clickable candidates. */
export interface PromptInterviewQuestion {
  /** Question text in the draft's language, answerable by the user in one click or a short sentence. */
  readonly text: string
  /** Up to four short concrete candidate answers; empty when the question needs free text. */
  readonly options: readonly string[]
}

/** One user-answered clarifying question, folded into a rewrite as a first-class requirement. */
export interface PromptClarification {
  /** The question text exactly as the interview round asked it. */
  readonly question: string
  /** The user's answer, verbatim. */
  readonly answer: string
}

/** Wire request to interview the user about one draft before rewriting it. */
export interface PromptInterviewRequest {
  /** Session whose draft is being interviewed; owns the request log and route fallback. */
  readonly sessionId: SessionId
  /** Complete current draft text, exactly as the composer holds it. */
  readonly text: string
  /**
   * Self-describing name of the language the questions must be written in (for
   * example `中文`); absent keeps the draft's language.
   */
  readonly language?: string
}

/** Outcome of one interview round: the clarifying questions for the draft. */
export interface PromptInterviewResult {
  /** Parsed clarifying questions; empty when the model found nothing worth asking. */
  readonly questions: readonly PromptInterviewQuestion[]
  /** Exact provider route that produced the questions. */
  readonly provider: string
  /** Exact model id that produced the questions. */
  readonly model: string
  /** Capability tier of the route that produced the questions. */
  readonly tier?: ModelTier
  /** Usage from the stream's `usage` chunk; absent until one arrives. */
  readonly usage?: TokenUsage
}

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

/** Wire request to rewrite one role definition from a completed round's materials. */
export interface PromptRoleEvolveRequest {
  /** Session that produced the round; owns the evolution log and route fallback. */
  readonly sessionId: SessionId
  /** Role slug whose `<slug>.md` definition styled the round and is rewritten. */
  readonly role: string
  /** Complete draft text the round optimized. */
  readonly draft: string
  /** Complete optimized text the round produced. */
  readonly optimized: string
  /** True commits the pending preview for this session and role; absent/false returns a preview without writing. */
  readonly confirm?: boolean
}

/** Outcome of one role-definition evolution. */
export interface PromptRoleEvolveResult {
  /** Role slug whose definition was rewritten. */
  readonly role: string
  /** Human-facing role name parsed from the new definition's first heading. */
  readonly name: string
  /** UTF-8 byte size of the previewed or written definition. */
  readonly bytes: number
  /** The previewed definition awaiting confirmation; present only on preview results. */
  readonly pendingDefinition?: string
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
  /** Direction the next rewrite should push toward; absent applies the plain rules. */
  readonly direction?: PromptOptimizeDirection
  /** True bypasses the decline-to-optimize precheck and forces a rewrite round. */
  readonly force?: boolean
  /** Interview answers to fold into the rewrite as first-class requirements; absent for a plain round. */
  readonly clarifications?: readonly PromptClarification[]
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
  /** Direction the round applied; absent when the plain rules governed it. */
  readonly direction?: PromptOptimizeDirection
  /** Names of the installed-skill hints that conditioned the round; absent when none matched. */
  readonly skills?: readonly string[]
  /** Capability tier of the route that produced (or would produce) the result. */
  readonly tier?: ModelTier
  /** True when the precheck declined to rewrite; `optimizedText` then equals the draft verbatim. */
  readonly skipped?: boolean
  /** Stable reason the precheck declined; present exactly when `skipped` is true. */
  readonly skipReason?: PromptSkipReason
  /** True when this is at least the third optimization of the same normalized draft — the panel then offers distilling it into a skill. */
  readonly suggestDistill?: boolean
  /** Present when this Session's standing system prompt was optimized for a different model than the current route. */
  readonly systemPromptStale?: { readonly from: string; readonly to: string }
  /** Usage from the stream's `usage` chunk; absent until one arrives. */
  readonly usage?: TokenUsage
}

/** Per-dimension judge scores for one candidate rewrite; each an integer 0–10. */
export interface PromptCandidateScores {
  /** How faithfully the candidate preserves the draft's stated facts and intent, adding nothing. */
  readonly faithfulness: number
  /** How completely it pins the constraints, inputs, and success criteria the draft implies. */
  readonly completeness: number
  /** How clear and immediately executable it is for the receiving agent. */
  readonly clarity: number
}

/** One generated candidate rewrite from a candidates round, with its judge outcome. */
export interface PromptCandidate {
  /** Stable candidate label: `A`, `B`, `C`, `D`. */
  readonly label: string
  /** Rewritten prompt text; never empty for a completed candidate. */
  readonly optimizedText: string
  /** Short per-change accounts in the draft's language; empty when the model listed none. */
  readonly changes: readonly string[]
  /** Draft acceptance criteria; empty when the model listed none. */
  readonly acceptance: readonly PromptAcceptanceCriterion[]
  /** Judge scores; absent when the judge round scored no candidate. */
  readonly scores?: PromptCandidateScores
  /** Sum of the three judge scores; present exactly when `scores` is. */
  readonly total?: number
  /** True when no scored sibling dominates this candidate on every dimension. */
  readonly pareto: boolean
  /** True for the single candidate the round recommends. */
  readonly recommended: boolean
}

/** Wire request for one N-candidate round: N differentiated rewrites plus an LLM-judge scoring pass. */
export interface PromptCandidatesRequest {
  /** Session whose draft is being optimized; owns the request log and route fallback. */
  readonly sessionId: SessionId
  /** Complete current draft text, exactly as the composer holds it. */
  readonly text: string
  /** How many candidates to generate; default 3, allowed 2–4. */
  readonly count?: number
  /** Role slug whose definition styles every candidate; absent for a generic rewrite. */
  readonly role?: string
  /**
   * Self-describing name of the language every candidate must be written in (for
   * example `中文`); absent keeps the draft's language.
   */
  readonly language?: string
  /** Direction every candidate pushes toward; absent applies the plain rules. */
  readonly direction?: PromptOptimizeDirection
  /** True bypasses the decline-to-optimize precheck and forces the rounds. */
  readonly force?: boolean
  /** Interview answers folded into every candidate as first-class requirements. */
  readonly clarifications?: readonly PromptClarification[]
}

/** Outcome of one N-candidate round. */
export interface PromptCandidatesResult {
  /** Generated candidates in generation order; empty exactly when `skipped` is true. */
  readonly candidates: readonly PromptCandidate[]
  /** Index into `candidates` of the recommended pick. */
  readonly recommended: number
  /** True when the judge round failed or produced no readable scores; candidates then carry none. */
  readonly judgeFailed?: boolean
  /** Failure message of a degraded judge round; present exactly when `judgeFailed` is true. */
  readonly judgeError?: string
  /** Exact provider route that produced the candidates. */
  readonly provider: string
  /** Exact model id that produced the candidates. */
  readonly model: string
  /** Names of the installed-skill hints that conditioned the rounds; absent when none matched. */
  readonly skills?: readonly string[]
  /** Capability tier of the route that produced the candidates. */
  readonly tier?: ModelTier
  /** True when the precheck declined the rounds; `candidates` is then empty. */
  readonly skipped?: boolean
  /** Stable reason the precheck declined; present exactly when `skipped` is true. */
  readonly skipReason?: PromptSkipReason
  /** True when this is at least the third optimization of the same normalized draft — the panel then offers distilling it into a skill. */
  readonly suggestDistill?: boolean
  /** Present when this Session's standing system prompt was optimized for a different model than the current route. */
  readonly systemPromptStale?: { readonly from: string; readonly to: string }
  /** Usage summed over every round the call dispatched; absent until one arrives. */
  readonly usage?: TokenUsage
}

/** Wire request to distill one completed round into a durable agent skill file. */
export interface PromptDistillRequest {
  /** Session that produced the round; owns the evolution log and the distill target fallback. */
  readonly sessionId: SessionId
  /** Complete draft text the round optimized. */
  readonly draft: string
  /** Complete optimized text the round produced. */
  readonly optimized: string
  /** Interview answers the round carried; they condition what the skill must preserve. */
  readonly clarifications?: readonly PromptClarification[]
  /** True commits the pending preview for this session and writes the skill file; absent/false returns a preview without writing. */
  readonly confirm?: boolean
}

/** Outcome of one skill distillation. */
export interface PromptDistillResult {
  /** Kebab-case skill name parsed from the produced definition. */
  readonly name: string
  /** One-line routing description parsed from the produced definition. */
  readonly description: string
  /** UTF-8 byte size of the previewed or written definition. */
  readonly bytes: number
  /** Directory the confirm phase writes `<name>/SKILL.md` into. */
  readonly targetDir: string
  /** The previewed SKILL.md awaiting confirmation; present only on preview results. */
  readonly pendingDefinition?: string
}

/** One context-doctor finding: a localized kind plus the offending subject. */
export interface PromptContextFinding {
  /** What the finding is about. */
  readonly kind: 'oversized-section' | 'duplicate-section' | 'oversized-skill' | 'duplicate-skill' | 'stale-skill-reference'
  /** Section name, skill name, or `left ≈ right` pair the finding is about. */
  readonly subject: string
  /** Short English detail line; the client renders the kind localized beside it. */
  readonly detail: string
}

/** Wire request to scan the Session's standing context: system prompt plus installed skills. */
export interface PromptContextCheckRequest {
  /** Session whose scoped system prompt and working directory scope the scan. */
  readonly sessionId: SessionId
}

/** Outcome of one context scan. */
export interface PromptContextCheckResult {
  /** System-prompt sizing; undefined when no system-prompt service is composed. */
  readonly systemPrompt?: {
    /** Summed section characters. */
    readonly totalChars: number
    /** Rough token estimate of the assembled sections. */
    readonly estimatedTokens: number
    /** Per-section sizing in canonical order. */
    readonly sections: readonly { readonly name: string; readonly chars: number; readonly share: number }[]
  }
  /** Skill catalog sizing. */
  readonly skills: {
    /** Skills the registry listed for the session's working directory. */
    readonly count: number
    /** Those the model may invoke. */
    readonly modelInvocable: number
    /** Bodies deep-read for findings. */
    readonly scannedBodies: number
    /** Summed characters of the scanned bodies. */
    readonly totalBodyChars: number
  }
  /** Findings in scan order; empty when the context is clean. */
  readonly findings: readonly PromptContextFinding[]
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

/** Wire request to delete one stored entry from the prompt library. */
export interface PromptLibraryDeleteRequest {
  /** Session requesting the deletion. */
  readonly sessionId: SessionId
  /** Library id of the entry to remove. */
  readonly id: string
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

/**
 * Kind of one local metric row. Host-written kinds record what a round did
 * (`declined`, `interviewed`, `clarified`, `verify-passed`, `verify-failed`);
 * the three client-reported kinds record what the user then decided.
 */
export type PromptMetricKind =
  | 'declined'
  | 'interviewed'
  | 'clarified'
  | 'verify-passed'
  | 'verify-failed'
  | 'candidates-generated'
  | 'judge-score'
  | 'distilled'
  | 'adopted'
  | 'rejected'
  | 'decline-overridden'

/** Wire request to record one user-decision metric the host cannot observe itself. */
export interface PromptMetricReportRequest {
  /** Session reporting the decision; recorded as provenance. */
  readonly sessionId: SessionId
  /** One of `adopted`, `rejected`, `decline-overridden` — the only client-reportable kinds. */
  readonly kind: PromptMetricKind
  /** Exact provider route of the round the decision is about. */
  readonly provider: string
  /** Exact model id of the round the decision is about. */
  readonly model: string
  /** Capability tier of that route; absent stores `standard`. */
  readonly tier?: ModelTier
}

/** Aggregate over the persisted metric rows; the client renders it as the local-metrics card. */
export interface PromptMetricsSummary {
  /** Rounds whose result the user applied to the draft. */
  readonly adopted: number
  /** Rounds whose result the user rejected by rerunning. */
  readonly rejected: number
  /** Rounds the decline precheck talked the user out of. */
  readonly declined: number
  /** Declines the user overrode with Optimize anyway. */
  readonly declineOverridden: number
  /** Clarifying questions all interview rounds asked. */
  readonly interviewQuestions: number
  /** Rewrite rounds that carried interview answers. */
  readonly clarifiedRounds: number
  /** Acceptance-check commands that exited 0. */
  readonly verifyPassed: number
  /** Acceptance-check commands that exited nonzero, timed out, or died. */
  readonly verifyFailed: number
  /** Candidate rounds run: each generated N candidates plus one judge pass. */
  readonly candidatesRounds: number
  /** Candidate rounds whose judge produced a recommended score. */
  readonly judgedRounds: number
  /** Completed rounds distilled into a durable agent skill file. */
  readonly distills: number
  /** Mean total score (0–30) of the recommended candidate across judged rounds; null before any. */
  readonly judgeAverage: number | null
  /** `adopted / (adopted + rejected)` over the aggregated rows; null before either kind exists. */
  readonly adoptionRate: number | null
  /** `verifyPassed / (verifyPassed + verifyFailed)`; null before either kind exists. */
  readonly verifyPassRate: number | null
  /** Metric rows the aggregate considered, oldest dropped first. */
  readonly rows: number
}
