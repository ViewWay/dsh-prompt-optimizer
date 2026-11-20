/**
 * Experimental draft-prompt optimization: one meta-prompted LLM rewrite per
 * request, logged as an ignorable `plugin:prompt-optimizer/llm-request`
 * record before dispatch. The
 * service never touches the loop; the Remote consumer owns the draft.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { BlockAssembler, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-prompt-optimizer': { kind: 'dsh-prompt-optimizer' }
  }
}

import type { ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createHash } from 'node:crypto'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { fileURLToPath } from 'node:url'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { FileSystem, FsDirEntry } from '@deepseek-ai/dsh-fs'
import type { SkillRegistry, SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {
  ModelTier,
  PromptCandidate,
  PromptCandidatesRequest,
  PromptCandidatesResult,
  PromptContextCheckRequest,
  PromptContextCheckResult,
  PromptDistillRequest,
  PromptDistillResult,
  PromptClarification,
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
} from './types.ts'
import {
  candidateUserInput,
  critiqueSystemPrompt,
  critiqueUserInput,
  detectDomainPriors,
  distillationSystemPrompt,
  distillationUserInput,
  interviewSystemPrompt,
  interviewUserInput,
  judgeSystemPrompt,
  judgeUserInput,
  optimizerSystemPrompt,
  optimizerSystemPromptForSystem,
  optimizerUserInput,
  parseInterviewResponse,
  parseJudgeResponse,
  parseOptimizerResponse,
  parseSkillDefinition,
  paretoFlags,
  roleEvolutionSystemPrompt,
  roleEvolutionUserInput,
} from './meta-prompt.ts'
import type { PromptRoleRef, RoundConditioning } from './meta-prompt.ts'
import { recommendRoles as rankRoles } from './recommend.ts'
import { classifyModelTier, declineToOptimize } from './model-tier.ts'
import { analyzeSections, analyzeSkills, estimateTokens } from './context-check.ts'
import { enrichSkillHint, MAX_DETAIL_HINTS, selectSkillHints } from './skills.ts'
import type { SkillHint } from './skills.ts'
import { screenVerifyCommand } from './verify-policy.ts'

export type * from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  // Plugin records, not SessionEventMap events: a host that does not share
  // this package's compiled-in types refuses the whole session log on any
  // unknown required event type; ignorable `plugin:` records always load.
  interface PluginRecordMap {
    /** Log-only pre-dispatch record of one draft-optimization model request. */
    'plugin:prompt-optimizer/llm-request': PromptOptimizerLlmRequestEventData
    /** Log-only record of one executed acceptance-criterion check command. */
    'plugin:prompt-optimizer/verify': PromptOptimizerVerifyEventData
    /** Log-only record of one completed role-definition evolution. */
    'plugin:prompt-optimizer/role-evolved': PromptOptimizerRoleEvolvedEventData
    /** Log-only record of one round the precheck declined to rewrite. */
    'plugin:prompt-optimizer/skipped': PromptOptimizerSkippedEventData
    /** Log-only record of one completed intent-clarification interview round. */
    'plugin:prompt-optimizer/interview': PromptOptimizerInterviewEventData
    /** Log-only record of one completed skill distillation write. */
    'plugin:prompt-optimizer/distilled': PromptOptimizerDistilledEventData
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental draft-prompt optimization service. */
    promptOptimizer: PromptOptimizer
  }
}

/** Exact model-visible request recorded before one optimization dispatch. */
export interface PromptOptimizerLlmRequestEventData {
  /** Exact auxiliary LLM route. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** UTF-8 byte size of the optimized draft text. */
  readonly inputBytes: number
  /** Rejected earlier results quoted in `messages`, oldest first. */
  readonly previousAttempts: number
  /** What the text was optimized as: `draft` or `system`. */
  readonly target: PromptOptimizeTarget
  /** Round index within the optimization: 1 = rewrite, 2 = system critique. */
  readonly round: number
  /** Slug of the role that styled the round; absent for a generic rewrite. */
  readonly role?: string
  /** Number of installed-skill hints the round's system prompt carried. */
  readonly skillsHinted?: number
  /** Self-describing output language the round's rules pinned; absent when the draft's language is kept. */
  readonly language?: string
  /** Rewrite direction the round applied; absent when the plain rules governed it. */
  readonly direction?: PromptOptimizeDirection
  /** Capability tier of the round's route. */
  readonly tier?: ModelTier
  /** Number of interview answers the round's input carried; absent for a plain round. */
  readonly clarifications?: number
  /** True for a candidates round's judge dispatch: the round scores candidates, it does not rewrite. */
  readonly judge?: boolean
}

/** One round the precheck declined to rewrite, recorded instead of a dispatch. */
export interface PromptOptimizerSkippedEventData {
  /** Stable reason the precheck declined the round. */
  readonly reason: PromptSkipReason
  /** Capability tier of the route the round would have dispatched on. */
  readonly tier: ModelTier
  /** What the text was optimized as; always `draft` for a decline. */
  readonly target: PromptOptimizeTarget
  /** UTF-8 byte size of the declined draft text. */
  readonly inputBytes: number
}

/** One completed intent-clarification interview round, recorded after parsing. */
export interface PromptOptimizerInterviewEventData {
  /** Exact auxiliary LLM route. */
  readonly route: { readonly provider: string; readonly model: string }
  /** UTF-8 byte size of the interviewed draft text. */
  readonly inputBytes: number
  /** Number of clarifying questions the round produced. */
  readonly questions: number
}

/** One executed acceptance-criterion check command, recorded after completion. */
export interface PromptOptimizerVerifyEventData {
  /** Criterion statement the command verifies. */
  readonly criterion: string
  /** Fully substituted command that ran. */
  readonly command: string
  /** True exactly when the command exited 0. */
  readonly passed: boolean
  /** Exit code the command reported; null on signal death or timeout. */
  readonly exitCode: number | null
  /** True when the verify deadline ended the run. */
  readonly timedOut: boolean
  /** Combined stdout and stderr, truncated to the output cap. */
  readonly output: string
  /** Wall time from dispatch to completion. */
  readonly durationMs: number
}

/** One completed skill distillation write, recorded after the write. */
export interface PromptOptimizerDistilledEventData {
  /** Kebab-case skill name of the written definition. */
  readonly name: string
  /** Directory the definition was written into. */
  readonly targetDir: string
  /** UTF-8 byte size of the written definition. */
  readonly bytes: number
}

/** One completed role-definition evolution, recorded after the write. */
export interface PromptOptimizerRoleEvolvedEventData {
  /** Slug of the role whose definition was rewritten. */
  readonly role: string
  /** UTF-8 byte size of the written definition. */
  readonly bytes: number
}

/** Deployment-tunable execution controls for one optimization round. */
export interface Config {
  /** Maximum UTF-8 bytes accepted for the draft text. */
  readonly maxInputBytes: number
  /** Output-token cap for the optimization request, independent of conversation requests. */
  readonly maxOutputTokens: number
  /** End-to-end deadline for one model dispatch in milliseconds. */
  readonly timeoutMs: number
  /** Deadline for one acceptance-criterion check command in milliseconds. */
  readonly verifyTimeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
  /** Whether domain-detection priors condition the system prompt on the draft's technical domain. */
  readonly domainPriors: boolean
  /** Optional absolute directory of `<slug>.md` role definitions enabling role-styled rewrites; defaults to the role library bundled with this package. */
  readonly rolesDir?: string
  /** Optional role slug styling every request that carries no explicit `role`. */
  readonly defaultRole?: string
  /** Whether installed-skill hints join the meta-prompt when skills match the draft. */
  readonly skillAware: boolean
  /** Whether the decline-to-optimize precheck may skip rounds it cannot improve. */
  readonly skipCheck: boolean
  /** Whether local optimization metrics are recorded and aggregated. */
  readonly metrics: boolean
  /** Optional absolute directory distillation writes `<name>/SKILL.md` into; defaults to the session project's `.dsh/skills`. */
  readonly distillDir?: string
}

/** Longest check command accepted by {@link PromptOptimizer.verify}. */
const VERIFY_COMMAND_MAX_CHARS = 2000
/** Longest combined command output kept in a verify result or event. */
const VERIFY_OUTPUT_MAX_CHARS = 4000
/** Longest library entry title accepted by {@link PromptOptimizer.savePrompt}. */
const LIBRARY_TITLE_MAX_CHARS = 120
/** Largest library entry text accepted by {@link PromptOptimizer.savePrompt}, in UTF-8 bytes. */
const LIBRARY_TEXT_MAX_BYTES = 64 * 1024
/** Most recent entries {@link PromptOptimizer.listPrompts} returns. */
const LIBRARY_MAX_ENTRIES = 100
/** Most rejected earlier results one optimize request may replay. */
const MAX_PREVIOUS_ATTEMPTS = 5
/** Most interview answers one optimize request may carry. */
const MAX_CLARIFICATIONS = 6
/** Smallest candidate count one candidates round accepts. */
const CANDIDATE_MIN = 2
/** Largest candidate count one candidates round accepts. */
const CANDIDATE_MAX = 4
/** Candidate count used when a request carries none. */
const CANDIDATE_DEFAULT = 3
/** Completed optimizations of one normalized draft after which distillation is suggested. */
const REPEAT_DISTILL_THRESHOLD = 3
/** Most draft-fingerprint rows kept on disk; the oldest beyond the cap are pruned on write. */
const REPEATS_MAX_ROWS = 500
/** Longest distilled SKILL.md accepted from one round. */
const SKILL_MAX_CHARS = 8000
/** Most skill bodies one context scan deep-reads. */
const MAX_SCANNED_SKILLS = 16
/** Metric kinds a client may report; host-written kinds are never accepted from the wire. */
const CLIENT_METRIC_KINDS: readonly PromptMetricKind[] = ['adopted', 'rejected', 'decline-overridden']
/** Most metric rows kept on disk; the oldest beyond the cap are pruned on write. */
const METRICS_MAX_ROWS = 2_000
/** Most metric rows one summary aggregates over, newest first. */
const METRICS_AGGREGATE_ROWS = 1_000
/** Every rewrite direction a request may steer a round toward. */
const DIRECTIONS: readonly PromptOptimizeDirection[] = ['concise', 'detailed', 'technical', 'structured', 'acceptance']
/** Slug shape a role id must have before the directory listing is consulted. */
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
/** Filenames that count as role definitions: `<slug>.md` exactly. */
const ROLE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/
/** Most role definition files one roles directory may hold. */
const ROLES_MAX_ENTRIES = 500
/** Longest role definition text accepted for one round. */
const ROLE_MAX_CHARS = 8000
/** Longest output-language name accepted on one optimize request. */
const LANGUAGE_MAX_CHARS = 40
/**
 * Absolute path of the role library bundled inside this package (`roles/`),
 * used whenever the deployment configures no `rolesDir` of its own. Resolved
 * from the module URL so it holds identically for `src/` tests and `lib/`
 * installs.
 */
const BUNDLED_ROLES_DIR = fileURLToPath(new URL('../roles', import.meta.url))

/** Persisted library row; the storage schema validates this plain shape. */
interface LibraryRow {
  id: string
  title: string
  text: string
  createdAt: string
  sourceSessionId: string
}

/** Persisted metric row; the storage schema validates this plain shape. */
interface MetricRow {
  id: string
  createdAt: string
  kind: string
  provider: string
  model: string
  tier: string
  count: number
}

/**
 * Local optimization metrics: append-only outcome rows (never draft content)
 * in their own domain so the library schema never migrates underneath them.
 */
const metricsDomainSpec = defineDomain({
  name: 'prompt_optimizer_metrics',
  version: 1,
  tables: {
    metrics: domainTable<string, MetricRow>(zod.object({
      id: zod.string(),
      createdAt: zod.string(),
      kind: zod.string(),
      provider: zod.string(),
      model: zod.string(),
      tier: zod.string(),
      count: zod.number(),
    })),
  },
})

/** Persisted repeat-fingerprint row; the storage schema validates this plain shape. */
interface RepeatRow {
  id: string
  createdAt: string
  fingerprint: string
}

/**
 * Draft-repeat fingerprints: append-only normalized-draft hashes (never draft
 * content) powering the "third time — distill it" suggestion.
 */
const repeatsDomainSpec = defineDomain({
  name: 'prompt_optimizer_repeats',
  version: 1,
  tables: {
    repeats: domainTable<string, RepeatRow>(zod.object({
      id: zod.string(),
      createdAt: zod.string(),
      fingerprint: zod.string(),
    })),
  },
})

/** Durable prompt library: adopted optimization results keyed by their id. */
const libraryDomainSpec = defineDomain({
  name: 'prompt_optimizer',
  version: 1,
  tables: {
    prompts: domainTable<string, LibraryRow>(zod.object({
      id: zod.string(),
      title: zod.string(),
      text: zod.string(),
      createdAt: zod.string(),
      sourceSessionId: zod.string(),
    })),
  },
})

/** Credential-shaped patterns scrubbed from verify output before it is kept or shown. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[bpars]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/**
 * Replace common credential shapes (bearer tokens, AWS key ids, GitHub/Slack/
 * OpenAI-style tokens, JWTs) with `[REDACTED]` so check-command output never
 * echoes a secret into a result or the session log.
 * @param text - complete `command + stdout + stderr` text.
 * @returns the text with every matching secret replaced.
 */
function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((scrubbed, pattern) => scrubbed.replaceAll(pattern, '[REDACTED]'), text)
}

/**
 * Redact credential shapes, then clip combined check-command output to
 * {@link VERIFY_OUTPUT_MAX_CHARS}.
 * @param text - complete `command + stdout + stderr` text.
 * @returns the redacted head of the text, marked when truncation occurred.
 */
function truncateVerifyOutput(text: string): string {
  const redacted = redactSecrets(text)
  return redacted.length <= VERIFY_OUTPUT_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, VERIFY_OUTPUT_MAX_CHARS)}\n… (truncated)`
}

/**
 * Parse a role display name from a definition's first `#` heading, dropping a
 * trailing parenthesized English name.
 * @param text - complete role definition text.
 * @returns the parsed role name, or undefined when no heading line exists.
 */
function roleNameOf(text: string): string | undefined {
  const heading = text.split('\n', 1)[0]?.trim() ?? ''
  if (!heading.startsWith('#')) return undefined
  const name = heading.replace(/^#+\s+/, '').replace(/[（(][^（()）]*[)）]\s*$/, '').trim()
  return name === '' ? undefined : name
}

/** Terminal finish kinds accepted for one optimization round. */
type OptimizationFinish = Extract<FinishReason, { kind: 'stop' | 'max-tokens' }>

/**
 * Read the saved default-model selection as an auxiliary route, dropping the
 * reasoning effort: the one-shot rewrite follows the title-call precedent of
 * minimal-effort auxiliary requests. The service is optional at this call
 * site, mirroring `ctx.get('configEditor')` lookups elsewhere.
 * @param ctx - runtime context, possibly without the default-model service.
 * @returns provider/model pair, or undefined when the service is absent or
 * holds no complete selection.
 */
function defaultModelRoute(ctx: Context): { provider: string; model: string } | undefined {
  const service = ctx.get('agentDefaultModel')
  if (service === undefined) return undefined
  const selection = service.currentSelection()
  if (selection.provider === '' || selection.model === '') return undefined
  return { provider: selection.provider, model: selection.model }
}

/**
 * Read the Session's current model selection through the `modelSelection`
 * projection: `pending` while the composer's pick awaits its next request,
 * else the projection's last-used route. A provider added inside the agent
 * serves optimization as soon as the composer selects it.
 * @param ctx - runtime context, optionally carrying the projection registry.
 * @param session - live session owning the draft.
 * @returns the selected provider/model pair, or undefined when neither the
 * registry nor the `modelSelection` unit is composed.
 */
function sessionSelectionRoute(ctx: Context, session: Session): { provider: string; model: string } | undefined {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return undefined
  const state = projections.stateOf(session, 'modelSelection')
  const selection = state === undefined ? undefined : state.pending ?? state.lastUsed
  if (selection === undefined || selection === null) return undefined
  return { provider: selection.provider, model: selection.model }
}

/**
 * Resolve the explicit pair, the Session's current model selection (`pending`
 * pick from the `modelSelection` projection, else its last-used route), the
 * route captured from the Session's last main-loop request header, or the
 * user's saved default model, in that order, so a fresh session can be
 * optimized before its first message and a provider added inside the agent
 * serves the round as soon as the composer selects it.
 * @param ctx - runtime context, optionally carrying auxiliary services.
 * @param config - validated service configuration.
 * @param session - live session owning the draft.
 * @param defaultRoute - saved default-model pair, when one is available.
 * @returns provider/model route for the auxiliary call.
 * @throws when no route source is available.
 */
function resolveRoute(
  ctx: Context,
  config: Config,
  session: Session,
  defaultRoute: { provider: string; model: string } | undefined,
): { provider: string; model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const selection = sessionSelectionRoute(ctx, session)
  if (selection !== undefined) {
    return selection
  }
  const header = session.requestHeader()?.config
  if (header !== undefined) {
    return { provider: header.provider, model: header.model }
  }
  if (defaultRoute !== undefined) {
    return defaultRoute
  }
  fail('PROMPT_OPTIMIZER_NO_ROUTE', 'prompt-optimizer: no model route is available; pick a model in the composer or configure provider and model together')
}

/**
 * Normalize a requested output-language name: whitespace is trimmed, an empty
 * name means "keep the draft's language", and an oversized name fails loudly
 * instead of silently degrading every round's system prompt.
 * @param language - raw request field.
 * @returns the trimmed name, or undefined to keep the draft's language.
 * @throws when the trimmed name exceeds {@link LANGUAGE_MAX_CHARS}.
 */
function normalizeLanguage(language: string | undefined): string | undefined {
  if (language === undefined) return undefined
  const trimmed = language.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > LANGUAGE_MAX_CHARS) {
    fail('PROMPT_OPTIMIZER_BAD_LANGUAGE', `prompt-optimizer: language "${trimmed}" exceeds the ${String(LANGUAGE_MAX_CHARS)}-character cap`)
  }
  return trimmed
}

/**
 * Normalize the interview answers one request carries: trimmed, count- and
 * byte-capped, and every pair non-empty, so a malformed replay cannot degrade
 * the round's system prompt.
 * @param clarifications - raw request field.
 * @param maxBytes - byte cap the answers' combined size must respect.
 * @returns the normalized answers; empty for a plain round.
 * @throws when a pair is empty, the count exceeds the cap, or the combined
 * size exceeds `maxBytes`.
 */
function normalizeClarifications(
  clarifications: readonly PromptClarification[] | undefined,
  maxBytes: number,
): readonly PromptClarification[] {
  if (clarifications === undefined) return []
  if (clarifications.length > MAX_CLARIFICATIONS) {
    fail('PROMPT_OPTIMIZER_CLARIFICATIONS_TOO_MANY', `prompt-optimizer: at most ${String(MAX_CLARIFICATIONS)} interview answers may be carried`)
  }
  const normalized = clarifications.map(pair => ({ question: pair.question.trim(), answer: pair.answer.trim() }))
  if (normalized.some(pair => pair.question === '' || pair.answer === '')) {
    fail('PROMPT_OPTIMIZER_BAD_CLARIFICATION', 'prompt-optimizer: every interview answer needs a non-empty question and answer')
  }
  const bytes = normalized.reduce((total, pair) => total + Buffer.byteLength(`${pair.question}\n${pair.answer}`, 'utf8'), 0)
  if (bytes > maxBytes) {
    fail('PROMPT_OPTIMIZER_CLARIFICATIONS_TOO_LARGE', `prompt-optimizer: interview answers total ${String(bytes)} bytes, exceeding maxInputBytes ${String(maxBytes)}`)
  }
  return normalized
}

/**
 * Build the no-adapter failure body: the requested id, the routes the app
 * currently serves, and the exact-match rule. Route keys are matched
 * character-for-character, so gateway-deployed models (LiteLLM, vLLM,
 * Ollama, …) fail here on any id drift such as a mistyped capital letter.
 * @param ctx - runtime context carrying the llm registry.
 * @param provider - route key the resolved optimization route requested.
 * @returns the actionable failure message.
 */
function noAdapterMessage(ctx: Context, provider: string): string {
  const routes = ctx.llm.listProviders().map(info => JSON.stringify(info.id))
  const available = routes.length === 0
    ? 'the app currently registers no model providers'
    : `available providers: ${routes.join(', ')}`
  return `prompt-optimizer: provider ${JSON.stringify(provider)} has no active model adapter in this app; ${available}. provider ids match the route keys in model settings exactly — pick an available model in the composer, or configure provider and model together (gateway-deployed models like LiteLLM/vLLM/Ollama need the exact configured id)`
}

/**
 * Throw one typed service failure.
 * @param code - stable PROMPT_OPTIMIZER_* failure code carried on `error.code`.
 * @param message - localized-enough actionable failure text.
 * @returns never; always throws.
 */
function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  throw error
}

/**
 * Whether one thrown value is a typed {@link fail} failure from this module,
 * so a catch-all wrapper can pass it through instead of re-wrapping it.
 * @param error - value thrown by an inner call.
 * @returns true exactly when the value carries a PROMPT_OPTIMIZER_* code.
 */
function isTypedFailure(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code?.startsWith('PROMPT_OPTIMIZER_') === true
}

/**
 * Classify one terminal finish reason. Operational failures throw; every
 * other accepted kind is returned for interpretation.
 * @param finish - terminal finish reason from the assembled stream.
 * @returns the accepted finish reason.
 * @throws on a provider or caller abort, or an impossible finish variant.
 */
function terminalFinish(finish: FinishReason): OptimizationFinish {
  switch (finish.kind) {
    case 'stop':
    case 'max-tokens':
      return finish
    case 'tool-calls':
      fail('PROMPT_OPTIMIZER_TOOL_CALLS', 'prompt-optimizer: the rewrite model requested tools, which the one-shot optimization prompt never allows')
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      throw error
    }
    /* v8 ignore next -- closed FinishReason union exhaustiveness guard */
    default: return assertNever(finish, 'FinishReason')
  }
}

/**
 * Join the text content of assembled blocks; reasoning and other block kinds
 * stay out of the optimization result.
 * @param blocks - assembled content blocks in stream order.
 * @returns the complete response text.
 */
function responseText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Sum token usage over every round one multi-round call dispatched. Optional
 * counters join the sum only when at least one round reported them.
 * @param usages - per-round usage chunks; undefined entries are skipped.
 * @returns the summed usage, or undefined when no round reported one.
 */
function sumTokenUsage(usages: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = usages.filter((usage): usage is TokenUsage => usage !== undefined)
  if (present.length === 0) return undefined
  const sumOf = (pick: (usage: TokenUsage) => number | undefined): number | undefined => {
    const defined = present.map(pick).filter((value): value is number => value !== undefined)
    return defined.length === 0 ? undefined : defined.reduce((total, value) => total + value, 0)
  }
  const inputTokens = present.reduce((total, usage) => total + usage.inputTokens, 0)
  const outputTokens = present.reduce((total, usage) => total + usage.outputTokens, 0)
  const totalTokens = sumOf(usage => usage.totalTokens)
  const cacheReadTokens = sumOf(usage => usage.cacheReadTokens)
  const cacheWriteTokens = sumOf(usage => usage.cacheWriteTokens)
  const reasoningTokens = sumOf(usage => usage.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  }
}

/**
 * One-round draft optimizer registered as `ctx.promptOptimizer`.
 */
export default class PromptOptimizer extends Service {
  static inject = ['llm', 'sessions']
  static Config: z<Config> = z.object({
    maxInputBytes: z.natural().min(1).default(64 * 1024),
    maxOutputTokens: z.natural().min(1).default(2048),
    timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
    verifyTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    provider: z.string(),
    model: z.string(),
    domainPriors: z.boolean().default(true),
    rolesDir: z.string(),
    defaultRole: z.string(),
    skillAware: z.boolean().default(true),
    skipCheck: z.boolean().default(true),
    metrics: z.boolean().default(true),
    distillDir: z.string(),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'promptOptimizer')
    const hasProvider = config.provider !== undefined
    const hasModel = config.model !== undefined
    if (hasProvider !== hasModel) {
      throw new Error('prompt-optimizer: provider and model must be supplied together')
    }
  }

  /**
   * Dispatch one model round: log the exact request, stream it, and parse the
   * envelope. Both the draft rewrite and the system critique round run here.
   * @param session - live Session that owns the request log.
   * @param options - route, target, round index, prompts, and bounds.
   * @param signal - caller cancellation.
   * @returns the parsed envelope and the stream's usage when one arrived.
   * @throws when the deadline or cancellation fires, or the stream ends in an
   * operational failure.
   */
  private async dispatchRound(session: Session, options: {
    readonly route: { readonly provider: string; readonly model: string }
    readonly target: PromptOptimizeTarget
    readonly round: number
    readonly system: string
    readonly input: string
    readonly inputBytes: number
    readonly previousAttempts: readonly string[]
    readonly sessionId: SessionId
    readonly role: PromptRoleRef | undefined
    readonly skillsHinted: number
    readonly language: string | undefined
    readonly direction: PromptOptimizeDirection | undefined
    readonly tier: ModelTier
    readonly clarifications: number
    readonly judge: boolean
  }, signal: AbortSignal): Promise<{ parsed: ReturnType<typeof parseOptimizerResponse>; usage: TokenUsage | undefined }> {
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: options.input }],
      source: { kind: 'dsh-prompt-optimizer' },
    })]
    using callDeadline = deadline(signal, this.config.timeoutMs, 'PROMPT_OPTIMIZER_TIMEOUT')
    const maxTokens = this.config.maxOutputTokens
    let call: Awaited<ReturnType<typeof this.ctx.llm.prepareCall>>
    try {
      call = await this.ctx.llm.prepareCall({ ...options.route, maxTokens }, callDeadline.signal)
    } catch (error) {
      callDeadline.signal.throwIfAborted()
      if (error instanceof LlmError && error.code === 'NO_ADAPTER') {
        fail('PROMPT_OPTIMIZER_NO_ADAPTER', noAdapterMessage(this.ctx, options.route.provider))
      }
      throw error
    }
    const llmOptions: GenerateOptions = {
      ...call.config,
      messages,
      system: options.system,
      sessionId: options.sessionId,
      signal: callDeadline.signal,
    }
    appendPluginRecord(session, 'plugin:prompt-optimizer/llm-request', {
      route: options.route,
      system: options.system,
      messages,
      maxTokens,
      inputBytes: options.inputBytes,
      previousAttempts: options.previousAttempts.length,
      target: options.target,
      round: options.round,
      ...(options.role !== undefined ? { role: options.role.id } : {}),
      skillsHinted: options.skillsHinted,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.direction !== undefined ? { direction: options.direction } : {}),
      tier: options.tier,
      ...(options.clarifications > 0 ? { clarifications: options.clarifications } : {}),
      ...(options.judge ? { judge: true } : {}),
    })
    callDeadline.signal.throwIfAborted()
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream(llmOptions)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    terminalFinish(assembler.finish)
    return { parsed: parseOptimizerResponse(responseText(assembler.blocks())), usage: assembler.usage }
  }

  /**
   * Execute one optimization: validate, resolve the route, then one rewrite
   * round for a `draft` target or a rewrite-plus-critique loop for a `system`
   * target, logging every dispatch before it runs.
   * @param request - session, draft text, rejected earlier results, and target.
   * @param signal - caller cancellation.
   * @returns the parsed optimization result with its exact route.
   * @throws when the session is gone, bounds fail, the deadline or
   * cancellation fires, or a stream ends in an operational failure.
   */
  async optimize(request: PromptOptimizeRequest, signal: AbortSignal): Promise<PromptOptimizeResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    const inputBytes = Buffer.byteLength(request.text, 'utf8')
    if (request.text.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_DRAFT', 'prompt-optimizer: draft is empty')
    }
    if (inputBytes > this.config.maxInputBytes) {
      fail('PROMPT_OPTIMIZER_INPUT_TOO_LARGE', `prompt-optimizer: draft is ${inputBytes} bytes, exceeding maxInputBytes ${this.config.maxInputBytes}`)
    }
    const rawTarget: string = request.target ?? 'draft'
    if (rawTarget !== 'draft' && rawTarget !== 'system') {
      fail('PROMPT_OPTIMIZER_BAD_TARGET', `prompt-optimizer: unknown optimization target "${rawTarget}"`)
    }
    const target: PromptOptimizeTarget = rawTarget
    const direction = request.direction
    if (direction !== undefined && !DIRECTIONS.includes(direction)) {
      fail('PROMPT_OPTIMIZER_BAD_DIRECTION', `prompt-optimizer: unknown direction "${direction}"; expected one of ${DIRECTIONS.join(', ')}`)
    }
    const previousAttempts = [...request.previousAttempts ?? []]
    if (previousAttempts.length > MAX_PREVIOUS_ATTEMPTS) {
      fail('PROMPT_OPTIMIZER_ATTEMPTS_TOO_MANY', `prompt-optimizer: at most ${String(MAX_PREVIOUS_ATTEMPTS)} rejected results may be replayed`)
    }
    const replayedBytes = previousAttempts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0)
    if (replayedBytes > this.config.maxInputBytes) {
      fail('PROMPT_OPTIMIZER_ATTEMPTS_TOO_MANY', `prompt-optimizer: replayed rejected results total ${String(replayedBytes)} bytes, exceeding maxInputBytes ${String(this.config.maxInputBytes)}`)
    }
    const clarifications = normalizeClarifications(request.clarifications, this.config.maxInputBytes)
    const requestedRole = request.role ?? this.config.defaultRole
    const role = requestedRole === undefined ? undefined : await this.loadRole(requestedRole, signal)
    const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    const tier = classifyModelTier(route.provider, route.model)
    const priors = this.config.domainPriors ? detectDomainPriors(request.text) : []
    if (this.config.skipCheck && request.force !== true) {
      const skipReason = declineToOptimize({
        tier,
        target,
        draft: request.text,
        domainPriors: priors,
        role: requestedRole,
        direction,
        previousAttempts,
        clarifications,
      })
      if (skipReason !== undefined) {
        appendPluginRecord(session, 'plugin:prompt-optimizer/skipped', {
          reason: skipReason,
          tier,
          target,
          inputBytes,
        })
        await this.recordMetric('declined', route, tier, 1)
        return {
          optimizedText: request.text,
          changes: [],
          acceptance: [],
          provider: route.provider,
          model: route.model,
          tier,
          skipped: true,
          skipReason,
        }
      }
    }
    const language = normalizeLanguage(request.language)
    if (clarifications.length > 0) {
      await this.recordMetric('clarified', route, tier, clarifications.length)
    }
    const rankingContext = [request.text, this.inboxText(session)].filter(part => part !== '').join('\n')
    const skills = await this.resolveSkillHints(session, rankingContext, signal)
    signal.throwIfAborted()
    const conditioning: RoundConditioning = {
      domainPriors: priors,
      skills,
      tier,
      ...(clarifications.length > 0 ? { clarifications } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(direction !== undefined ? { direction } : {}),
    }
    const first = await this.dispatchRound(session, {
      route,
      target,
      round: 1,
      system: target === 'system' ? optimizerSystemPromptForSystem(conditioning) : optimizerSystemPrompt(conditioning),
      input: optimizerUserInput(request.text, previousAttempts, clarifications),
      inputBytes,
      previousAttempts,
      sessionId: request.sessionId,
      role,
      skillsHinted: skills.length,
      language,
      direction,
      tier,
      clarifications: clarifications.length,
      judge: false,
    }, signal)
    if (first.parsed.optimizedText === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_RESULT', 'prompt-optimizer: the model returned an empty rewrite')
    }
    const suggestDistill = await this.noteRepeat(session, request.text)
    if (target === 'draft') {
      return {
        optimizedText: first.parsed.optimizedText,
        changes: first.parsed.changes,
        acceptance: first.parsed.acceptance,
        provider: route.provider,
        model: route.model,
        tier,
        ...(role !== undefined ? { role: role.id } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(skills.length > 0 ? { skills: skills.map(hint => hint.name) } : {}),
        ...(suggestDistill ? { suggestDistill: true } : {}),
        ...(first.usage !== undefined ? { usage: first.usage } : {}),
      }
    }
    const critique = await this.dispatchRound(session, {
      route,
      target,
      round: 2,
      system: critiqueSystemPrompt(conditioning),
      input: critiqueUserInput(request.text, first.parsed.optimizedText),
      inputBytes,
      previousAttempts,
      sessionId: request.sessionId,
      role,
      skillsHinted: skills.length,
      language,
      direction,
      tier,
      clarifications: clarifications.length,
      judge: false,
    }, signal)
    if (critique.parsed.optimizedText === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_RESULT', 'prompt-optimizer: the critique round returned an empty rewrite')
    }
    const usage = critique.usage ?? first.usage
    return {
      optimizedText: critique.parsed.optimizedText,
      changes: first.parsed.changes,
      acceptance: critique.parsed.acceptance.length > 0 ? critique.parsed.acceptance : first.parsed.acceptance,
      critique: critique.parsed.changes,
      provider: route.provider,
      model: route.model,
      tier,
      ...(role !== undefined ? { role: role.id } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(skills.length > 0 ? { skills: skills.map(hint => hint.name) } : {}),
      ...(suggestDistill ? { suggestDistill: true } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
  }

  /**
   * Execute one N-candidate round: N sequential rewrites where every later
   * candidate sees its siblings and must differentiate, then one judge round
   * scoring each candidate on faithfulness, completeness, and clarity. The
   * Pareto frontier over those dimensions and the judge's best pick drive the
   * client's candidate comparison. A judge-round failure degrades to unscored
   * candidates instead of failing the call.
   * @param request - session, draft text, candidate count, and round conditioners.
   * @param signal - caller cancellation.
   * @returns the scored candidates with the recommended index and exact route.
   * @throws when the session is gone, bounds fail, the decline precheck fires
   * without `force`, a rewrite round returns empty, or the deadline or
   * cancellation fires.
   */
  async optimizeCandidates(request: PromptCandidatesRequest, signal: AbortSignal): Promise<PromptCandidatesResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    const inputBytes = Buffer.byteLength(request.text, 'utf8')
    if (request.text.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_DRAFT', 'prompt-optimizer: draft is empty')
    }
    if (inputBytes > this.config.maxInputBytes) {
      fail('PROMPT_OPTIMIZER_INPUT_TOO_LARGE', `prompt-optimizer: draft is ${inputBytes} bytes, exceeding maxInputBytes ${this.config.maxInputBytes}`)
    }
    const count = request.count ?? CANDIDATE_DEFAULT
    if (!Number.isInteger(count) || count < CANDIDATE_MIN || count > CANDIDATE_MAX) {
      fail('PROMPT_OPTIMIZER_BAD_CANDIDATES_COUNT', `prompt-optimizer: count must be an integer between ${String(CANDIDATE_MIN)} and ${String(CANDIDATE_MAX)}`)
    }
    const direction = request.direction
    if (direction !== undefined && !DIRECTIONS.includes(direction)) {
      fail('PROMPT_OPTIMIZER_BAD_DIRECTION', `prompt-optimizer: unknown direction "${direction}"; expected one of ${DIRECTIONS.join(', ')}`)
    }
    const clarifications = normalizeClarifications(request.clarifications, this.config.maxInputBytes)
    const requestedRole = request.role ?? this.config.defaultRole
    const role = requestedRole === undefined ? undefined : await this.loadRole(requestedRole, signal)
    const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    const tier = classifyModelTier(route.provider, route.model)
    const priors = this.config.domainPriors ? detectDomainPriors(request.text) : []
    if (this.config.skipCheck && request.force !== true) {
      const skipReason = declineToOptimize({
        tier,
        target: 'draft',
        draft: request.text,
        domainPriors: priors,
        role: requestedRole,
        direction,
        previousAttempts: [],
        clarifications,
      })
      if (skipReason !== undefined) {
        appendPluginRecord(session, 'plugin:prompt-optimizer/skipped', {
          reason: skipReason,
          tier,
          target: 'draft',
          inputBytes,
        })
        await this.recordMetric('declined', route, tier, 1)
        return {
          candidates: [],
          recommended: 0,
          provider: route.provider,
          model: route.model,
          tier,
          skipped: true,
          skipReason,
        }
      }
    }
    const language = normalizeLanguage(request.language)
    if (clarifications.length > 0) {
      await this.recordMetric('clarified', route, tier, clarifications.length)
    }
    const rankingContext = [request.text, this.inboxText(session)].filter(part => part !== '').join('\n')
    const skills = await this.resolveSkillHints(session, rankingContext, signal)
    signal.throwIfAborted()
    const conditioning: RoundConditioning = {
      domainPriors: priors,
      skills,
      tier,
      ...(clarifications.length > 0 ? { clarifications } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(direction !== undefined ? { direction } : {}),
    }
    const generated: { label: string; optimizedText: string; changes: readonly string[]; acceptance: PromptCandidate['acceptance']; usage: TokenUsage | undefined }[] = []
    for (let index = 0; index < count; index += 1) {
      signal.throwIfAborted()
      const label = String.fromCharCode('A'.charCodeAt(0) + index)
      const round = await this.dispatchRound(session, {
        route,
        target: 'draft',
        round: index + 1,
        system: optimizerSystemPrompt(conditioning),
        input: candidateUserInput(
          request.text,
          clarifications,
          generated.map(candidate => ({ label: candidate.label, text: candidate.optimizedText })),
        ),
        inputBytes,
        previousAttempts: [],
        sessionId: request.sessionId,
        role,
        skillsHinted: skills.length,
        language,
        direction,
        tier,
        clarifications: clarifications.length,
        judge: false,
      }, signal)
      if (round.parsed.optimizedText === '') {
        fail('PROMPT_OPTIMIZER_EMPTY_RESULT', `prompt-optimizer: candidate ${label} came back empty`)
      }
      generated.push({
        label,
        optimizedText: round.parsed.optimizedText,
        changes: round.parsed.changes,
        acceptance: round.parsed.acceptance,
        usage: round.usage,
      })
    }
    let judged: ReturnType<typeof parseJudgeResponse> | undefined
    let judgeError: string | undefined
    let judgeUsage: TokenUsage | undefined
    try {
      signal.throwIfAborted()
      const judgeRound = await this.dispatchRound(session, {
        route,
        target: 'draft',
        round: count + 1,
        system: judgeSystemPrompt(),
        input: judgeUserInput(
          request.text,
          clarifications,
          generated.map(candidate => ({ label: candidate.label, text: candidate.optimizedText })),
        ),
        inputBytes,
        previousAttempts: [],
        sessionId: request.sessionId,
        role,
        skillsHinted: skills.length,
        language,
        direction,
        tier,
        clarifications: clarifications.length,
        judge: true,
      }, signal)
      judged = parseJudgeResponse(judgeRound.parsed.optimizedText, generated.map(candidate => candidate.label))
      judgeUsage = judgeRound.usage
      if (judged.scores.length === 0) {
        judgeError = 'the judge round produced no readable scores'
        judged = undefined
      }
    } catch (error) {
      signal.throwIfAborted()
      judgeError = error instanceof Error ? error.message : String(error)
    }
    const scoresByLabel = new Map((judged?.scores ?? []).map(entry => [entry.label, entry.scores]))
    const flags = paretoFlags(generated.map(candidate => scoresByLabel.get(candidate.label)))
    let recommendedIndex = 0
    if (judged !== undefined) {
      const totalOf = (label: string): number => {
        const scores = scoresByLabel.get(label)!
        return scores.faithfulness + scores.completeness + scores.clarity
      }
      const bestLabel = judged.best
      recommendedIndex = bestLabel === undefined
        ? generated.reduce((best, candidate, index) => totalOf(candidate.label) > totalOf(generated[best]!.label) ? index : best, 0)
        : Math.max(0, generated.findIndex(candidate => candidate.label === bestLabel))
    }
    const candidates: readonly PromptCandidate[] = generated.map((candidate, index) => {
      const scores = scoresByLabel.get(candidate.label)
      return {
        label: candidate.label,
        optimizedText: candidate.optimizedText,
        changes: candidate.changes,
        acceptance: candidate.acceptance,
        ...(scores !== undefined
          ? { scores, total: scores.faithfulness + scores.completeness + scores.clarity }
          : {}),
        pareto: flags[index] === true,
        recommended: index === recommendedIndex,
      }
    })
    await this.recordMetric('candidates-generated', route, tier, count)
    if (judged !== undefined) {
      const recommendedTotal = candidates[recommendedIndex]?.total
      if (recommendedTotal !== undefined) {
        await this.recordMetric('judge-score', route, tier, recommendedTotal)
      }
    }
    const usage = sumTokenUsage([...generated.map(candidate => candidate.usage), judgeUsage])
    const suggestDistill = await this.noteRepeat(session, request.text)
    return {
      candidates,
      recommended: recommendedIndex,
      ...(judgeError !== undefined ? { judgeFailed: true, judgeError } : {}),
      ...(suggestDistill ? { suggestDistill: true } : {}),
      provider: route.provider,
      model: route.model,
      tier,
      ...(skills.length > 0 ? { skills: skills.map(hint => hint.name) } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
  }

  /**
   * Interview the user about one draft: one auxiliary round that turns the
   * draft's ambiguity into at most three clickable clarifying questions,
   * conditioned on the draft's domain priors. The answers later ride into
   * {@link PromptOptimizer.optimize} as authoritative requirements.
   * @param request - session, draft text, and output language.
   * @param signal - caller cancellation.
   * @returns the parsed questions with the exact route that produced them;
   * empty questions mean the model found nothing worth asking.
   * @throws when the session is gone, bounds fail, the deadline or
   * cancellation fires, or the stream ends in an operational failure.
   */
  async interview(request: PromptInterviewRequest, signal: AbortSignal): Promise<PromptInterviewResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    const inputBytes = Buffer.byteLength(request.text, 'utf8')
    if (request.text.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_DRAFT', 'prompt-optimizer: draft is empty')
    }
    if (inputBytes > this.config.maxInputBytes) {
      fail('PROMPT_OPTIMIZER_INPUT_TOO_LARGE', `prompt-optimizer: draft is ${inputBytes} bytes, exceeding maxInputBytes ${this.config.maxInputBytes}`)
    }
    const language = normalizeLanguage(request.language)
    const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    const tier = classifyModelTier(route.provider, route.model)
    const priors = this.config.domainPriors ? detectDomainPriors(request.text) : []
    signal.throwIfAborted()
    const conditioning: RoundConditioning = {
      domainPriors: priors,
      ...(language !== undefined ? { language } : {}),
    }
    const round = await this.dispatchRound(session, {
      route,
      target: 'draft',
      round: 1,
      system: interviewSystemPrompt(conditioning),
      input: interviewUserInput(request.text),
      inputBytes,
      previousAttempts: [],
      sessionId: request.sessionId,
      role: undefined,
      skillsHinted: 0,
      language,
      direction: undefined,
      tier,
      clarifications: 0,
      judge: false,
    }, signal)
    const questions = parseInterviewResponse(round.parsed.optimizedText)
    appendPluginRecord(session, 'plugin:prompt-optimizer/interview', {
      route,
      inputBytes,
      questions: questions.length,
    })
    await this.recordMetric('interviewed', route, tier, questions.length)
    return {
      questions,
      provider: route.provider,
      model: route.model,
      tier,
      ...(round.usage !== undefined ? { usage: round.usage } : {}),
    }
  }

  /**
   * Execute one acceptance criterion's check command in the Session's
   * workspace through the composed shell executor, then record the outcome.
   * @param request - session, criterion statement, and fully substituted command.
   * @param signal - caller cancellation.
   * @returns the command's exit status and truncated combined output.
   * @throws when the session is gone, the command fails validation, or no
   * shell executor is composed; a command that simply exits nonzero resolves
   * as a failed check instead of throwing.
   */
  async verify(request: PromptVerifyRequest, signal: AbortSignal): Promise<PromptVerifyResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    const command = request.command.trim()
    if (command === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_COMMAND', 'prompt-optimizer: a check command is required to verify a criterion')
    }
    if (command.length > VERIFY_COMMAND_MAX_CHARS) {
      fail('PROMPT_OPTIMIZER_COMMAND_TOO_LONG', `prompt-optimizer: check command exceeds ${VERIFY_COMMAND_MAX_CHARS} characters`)
    }
    const verdict = screenVerifyCommand(command)
    if (!verdict.ok) {
      fail('PROMPT_OPTIMIZER_COMMAND_BLOCKED', `prompt-optimizer: check command rejected by safety policy: ${verdict.reason}`)
    }
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      fail('PROMPT_OPTIMIZER_NO_SHELL', 'prompt-optimizer: no shell executor is composed; add a dsh-shell implementation to run check commands')
    }
    const workdir = this.ctx.get('workingDirectory')?.get(session)
    const started = Date.now()
    let exitCode: number | null
    let timedOut: boolean
    let stdout: string
    let stderr: string
    try {
      const result = await (await shell.execute(shell.resolve({
        command,
        timeoutMs: this.config.verifyTimeoutMs,
        signal,
        ...(workdir !== undefined ? { workdir } : {}),
      }))).result()
      exitCode = result.exitCode
      timedOut = result.timedOut
      stdout = result.stdout.text
      stderr = result.stderr.text
    } catch (error) {
      signal.throwIfAborted()
      fail('PROMPT_OPTIMIZER_VERIFY_FAILED', `prompt-optimizer: the check command could not run: ${error instanceof Error ? error.message : String(error)}`)
    }
    const output = truncateVerifyOutput(
      `$ ${command}\n${stdout}${stderr === '' ? '' : `\n${stderr}`}`,
    )
    const verified: PromptVerifyResult = {
      passed: exitCode === 0,
      exitCode,
      timedOut,
      output,
      durationMs: Date.now() - started,
    }
    appendPluginRecord(session, 'plugin:prompt-optimizer/verify', { criterion: request.criterion, command, ...verified })
    // Verify outcomes are model-independent; the route is best-effort provenance only.
    let verifyRoute = { provider: '', model: '' }
    try {
      verifyRoute = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    } catch { /* no route resolves: the metric degrades to a blank route */ }
    await this.recordMetric(verified.passed ? 'verify-passed' : 'verify-failed', verifyRoute, 'standard', 1)
    return verified
  }

  /**
   * Save one adopted optimization result into the durable prompt library.
   * @param request - producing session, human-facing title, and full text.
   * @param signal - caller cancellation.
   * @returns the persisted library entry.
   * @throws when the entry fails validation or no storage domain is composed.
   */
  async savePrompt(request: PromptLibrarySaveRequest, signal: AbortSignal): Promise<PromptLibraryEntry> {
    signal.throwIfAborted()
    const title = request.title.trim()
    if (title === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_TITLE', 'prompt-optimizer: a library entry needs a non-empty title')
    }
    if (title.length > LIBRARY_TITLE_MAX_CHARS) {
      fail('PROMPT_OPTIMIZER_TITLE_TOO_LONG', `prompt-optimizer: library titles are capped at ${LIBRARY_TITLE_MAX_CHARS} characters`)
    }
    if (request.text.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_TEXT', 'prompt-optimizer: a library entry needs non-empty text')
    }
    if (Buffer.byteLength(request.text, 'utf8') > LIBRARY_TEXT_MAX_BYTES) {
      fail('PROMPT_OPTIMIZER_TEXT_TOO_LARGE', `prompt-optimizer: library text exceeds ${String(LIBRARY_TEXT_MAX_BYTES)} bytes`)
    }
    const entry: PromptLibraryEntry = {
      id: randomUUID(),
      title,
      text: request.text,
      createdAt: new Date().toISOString(),
      sourceSessionId: request.sessionId,
    }
    const domain = await this.openLibrary()
    const { sourceSessionId, ...rest } = entry
    await domain.table('prompts').put(entry.id, { ...rest, sourceSessionId })
    signal.throwIfAborted()
    return entry
  }

  /**
   * List the library's most recent entries, newest first.
   * @param signal - caller cancellation.
   * @returns at most {@link LIBRARY_MAX_ENTRIES} entries.
   * @throws when no storage domain is composed.
   */
  async listPrompts(signal: AbortSignal): Promise<readonly PromptLibraryEntry[]> {
    signal.throwIfAborted()
    const domain = await this.openLibrary()
    return [...domain.table('prompts').entries()]
      .map(([, row]) => ({ ...row, sourceSessionId: row.sourceSessionId as SessionId }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, LIBRARY_MAX_ENTRIES)
  }

  /**
   * Delete one stored entry from the durable prompt library.
   * @param request - requesting session and the entry's library id.
   * @param signal - caller cancellation.
   * @throws when the id is empty, no storage domain is composed, or no entry
   * carries the id.
   */
  async deletePrompt(request: PromptLibraryDeleteRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (request.id.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_LIBRARY_ID', 'prompt-optimizer: a library deletion needs a non-empty entry id')
    }
    const domain = await this.openLibrary()
    const removed = await domain.table('prompts').delete(request.id)
    signal.throwIfAborted()
    if (!removed) {
      fail('PROMPT_OPTIMIZER_LIBRARY_ENTRY_NOT_FOUND', `prompt-optimizer: no library entry carries id "${request.id}"`)
    }
  }

  /**
   * List the configured roles directory's selectable role definitions, sorted
   * by slug. Every definition file is read once so each entry carries the
   * display name parsed from its heading.
   * @param signal - caller cancellation.
   * @returns every `<slug>.md` role summary the directory holds; non-slug
   * files such as `README.md` are directory metadata, not roles.
   * @throws when no filesystem service is composed, or the directory cannot
   * be listed or a definition cannot be read.
   */
  async listRoles(signal: AbortSignal): Promise<readonly PromptRoleSummary[]> {
    signal.throwIfAborted()
    const roles = await this.loadAllRoles(signal)
    return roles.map(role => ({ id: role.id, name: role.name }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Recommend roles for the request context: the caller's draft text joined
   * with the pending inbox messages of the Session's live agent when one
   * exists (read through the `inbox` projection), scored by deterministic
   * keyword overlap against every role definition. A draft with no live
   * session ranks on its own, so first-message drafts stay recommendable.
   * No model call runs.
   * @param request - session whose inbox joins the context, plus optional draft text.
   * @param signal - caller cancellation.
   * @returns at most three roles whose overlap score clears the threshold,
   * highest first; empty when nothing matches, no context text exists, or no
   * roles are configured.
   * @throws when the roles directory fails to load.
   */
  async recommendRoles(request: PromptRoleRecommendRequest, signal: AbortSignal): Promise<readonly PromptRoleRecommendation[]> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    const context = [request.text ?? '', session === undefined ? '' : this.inboxText(session)]
      .filter(part => part !== '').join('\n')
    const roles = await this.loadAllRoles(signal)
    if (context.trim() === '') return []
    return rankRoles(context, roles)
  }

  /**
   * Evolve one role definition in two phases over one model round: a preview
   * call (`confirm` absent or false) feeds the current definition plus the
   * round's draft and optimized result to one model round, validates the
   * produced definition, stores it as pending, and returns it in
   * `pendingDefinition` without writing files; a confirming call
   * (`confirm: true`) runs no model round, re-validates the pending
   * definition, then writes the previous version to `<slug>.md.bak` (which
   * never matches the role-file pattern and so never joins a listing) before
   * the new definition replaces `<slug>.md`. Evolution writes only into a
   * configured `rolesDir`; the bundled library is read-only.
   * @param request - producing session, role slug, the round's two texts, and
   * the phase selector.
   * @param signal - caller cancellation.
   * @returns the rewritten role's slug, parsed name, byte size, and — for a
   * preview — the pending definition itself.
   * @throws when the session is gone, `rolesDir` is unset (the bundled
   * library is read-only), the role is not listed, the model round fails, a
   * confirm arrives without a pending preview, or the produced definition
   * fails validation.
   */
  async evolveRole(request: PromptRoleEvolveRequest, signal: AbortSignal): Promise<PromptRoleEvolveResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    if (this.config.rolesDir === undefined) {
      fail('PROMPT_OPTIMIZER_ROLE_EVOLVE_READONLY', 'prompt-optimizer: the bundled role library is read-only; point rolesDir at your own directory of role definitions to evolve them')
    }
    const { fs, entries } = await this.rolesEntries(signal)
    const entry = ROLE_ID_PATTERN.test(request.role)
      ? entries.find(candidate => candidate.name === `${request.role}.md`)
      : undefined
    if (entry === undefined) {
      fail('PROMPT_OPTIMIZER_ROLE_NOT_FOUND', `prompt-optimizer: unknown role "${request.role}"; pick one of the listed roles`)
    }
    const currentText = await this.readRoleText(fs, entry, signal)
    const pendingKey = `${request.sessionId}\u0000${request.role}`
    let definition: string
    if (request.confirm === true) {
      definition = this.pendingEvolutions.get(pendingKey) ?? fail('PROMPT_OPTIMIZER_ROLE_EVOLVE_NOT_PENDING', 'prompt-optimizer: confirm requires a preceding preview for this session and role')
      this.validateRoleDefinition(definition)
    } else {
      const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
      const messages: Message[] = [createUserMessage({
        content: [{ type: 'text', text: roleEvolutionUserInput(currentText, request.draft, request.optimized) }],
        source: { kind: 'dsh-prompt-optimizer' },
      })]
      try {
        using callDeadline = deadline(signal, this.config.timeoutMs, 'PROMPT_OPTIMIZER_TIMEOUT')
        let call: Awaited<ReturnType<typeof this.ctx.llm.prepareCall>>
        try {
          call = await this.ctx.llm.prepareCall({ ...route, maxTokens: this.config.maxOutputTokens }, callDeadline.signal)
        } catch (error) {
          callDeadline.signal.throwIfAborted()
          if (error instanceof LlmError && error.code === 'NO_ADAPTER') {
            fail('PROMPT_OPTIMIZER_NO_ADAPTER', noAdapterMessage(this.ctx, route.provider))
          }
          throw error
        }
        const llmOptions: GenerateOptions = {
          ...call.config,
          messages,
          system: roleEvolutionSystemPrompt(),
          sessionId: request.sessionId,
          signal: callDeadline.signal,
        }
        callDeadline.signal.throwIfAborted()
        const assembler = new BlockAssembler()
        for await (const chunk of call.stream(llmOptions)) {
          callDeadline.signal.throwIfAborted()
          assembler.push(chunk)
        }
        callDeadline.signal.throwIfAborted()
        terminalFinish(assembler.finish)
        definition = responseText(assembler.blocks()).trim()
        this.validateRoleDefinition(definition)
      } catch (error) {
        signal.throwIfAborted()
        if (isTypedFailure(error)) throw error
        fail('PROMPT_OPTIMIZER_ROLE_EVOLVE_FAILED', `prompt-optimizer: evolving role "${request.role}" failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.pendingEvolutions.set(pendingKey, definition)
      return {
        role: request.role,
        name: roleNameOf(definition) ?? request.role,
        bytes: Buffer.byteLength(definition, 'utf8'),
        pendingDefinition: definition,
      }
    }
    try {
      const backupTarget = await fs.resolve(`${entry.target}.bak`, { signal })
      await fs.writeText(backupTarget, currentText, undefined, signal)
      await fs.writeText(entry.target, definition, undefined, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (isTypedFailure(error)) throw error
      fail('PROMPT_OPTIMIZER_ROLE_EVOLVE_FAILED', `prompt-optimizer: evolving role "${request.role}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.pendingEvolutions.delete(pendingKey)
    const bytes = Buffer.byteLength(definition, 'utf8')
    appendPluginRecord(session, 'plugin:prompt-optimizer/role-evolved', { role: request.role, bytes })
    return { role: request.role, name: roleNameOf(definition) ?? request.role, bytes }
  }

  /** Definitions pending a confirming call, keyed `${sessionId}\u0000${role}`. */
  private readonly pendingEvolutions = new Map<string, string>()

  /**
   * Re-run the evolved-definition shape checks both phases share.
   * @param definition - model-produced role definition text.
   * @throws when the definition is empty, lacks its H1 heading, or exceeds the
   * character cap.
   */
  private validateRoleDefinition(definition: string): void {
    if (definition === '' || !definition.startsWith('# ') || definition.length > ROLE_MAX_CHARS) {
      fail('PROMPT_OPTIMIZER_ROLE_EVOLVE_INVALID', 'prompt-optimizer: the rewritten role definition must be non-empty, start with an H1 heading, and stay within the character cap')
    }
  }

  /**
   * Join the pending inbox messages of one live session's agent (read through
   * the `inbox` projection) into one text block for ranking contexts.
   * @param session - live session whose pending messages join the context.
   * @returns concatenated queued text; empty when no projection or no text
   * messages are pending.
   */
  private inboxText(session: Session): string {
    const inbox = this.ctx.get('sessionProjections')?.stateOf(session, 'inbox')
    if (inbox === undefined) return ''
    return [...inbox['next-turn'], ...inbox['next-step']]
      .flatMap(message => message.content)
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  /**
   * Select installed-skill hints for the round's ranking context: the global
   * skill registry, listed with the session's working directory, filtered to
   * model-invocable skills and scored by deterministic keyword overlap.
   * Per-preset skill scoping is deliberately not applied — hints are advisory
   * routing names, and the runtime skill catalog governs which names the
   * agent may actually load.
   * @param session - live session owning the working directory.
   * @param context - draft plus queued inbox text.
   * @param signal - caller cancellation.
   * @returns at most twelve hints; empty when `skillAware` is off or nothing
   * matched the context.
   * @throws when `skillAware` is on but no skill registry is composed, or the
   * registry listing fails.
   */
  private async resolveSkillHints(session: Session, context: string, signal: AbortSignal): Promise<readonly SkillHint[]> {
    if (!this.config.skillAware) return []
    const registry = this.ctx.get('skills')
    if (registry === undefined) {
      fail('PROMPT_OPTIMIZER_NO_SKILLS', 'prompt-optimizer: skillAware is enabled but no skill registry is composed; mount @deepseek-ai/dsh-skill or set skillAware: false')
    }
    const cwd = this.ctx.get('workingDirectory')?.get(session)
    let skills: readonly SkillSummary[]
    try {
      skills = await registry.list({ ...(cwd !== undefined ? { cwd } : {}), signal })
    } catch (error) {
      signal.throwIfAborted()
      if (isTypedFailure(error)) throw error
      fail('PROMPT_OPTIMIZER_SKILLS_READ_FAILED', `prompt-optimizer: the skill registry could not be listed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.detailSkillHints(registry, selectSkillHints(context, skills), cwd, signal)
  }

  /**
    * Deep-read the top-ranked hints through the skill registry and enrich
    * each with its definition's parameter descriptors and body digest; the
    * remaining hints stay summary-only. Best-effort: a definition that fails
    * to load keeps its summary-only hint rather than failing the round.
    * @param registry - the composed skill registry the hints were listed from.
    * @param hints - ranked hints from {@link selectSkillHints}.
    * @param cwd - the session's working directory passed through to the registry.
    * @param signal - caller cancellation.
    * @returns the hints with at most {@link MAX_DETAIL_HINTS} entries enriched.
    */
  private async detailSkillHints(
    registry: Pick<SkillRegistry, 'get'>,
    hints: readonly SkillHint[],
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly SkillHint[]> {
    const enriched = [...hints]
    for (const [index, hint] of hints.slice(0, MAX_DETAIL_HINTS).entries()) {
      try {
        const definition = await registry.get(hint.name, { ...(cwd !== undefined ? { cwd } : {}), signal })
        if (definition !== undefined) enriched[index] = enrichSkillHint(hint, definition)
      } catch {
        signal.throwIfAborted()
      }
    }
    return enriched
  }

  /**
   * Resolve the roles directory — the configured `rolesDir`, else the bundled
   * library — and its definition-file entries.
   * @param signal - caller cancellation.
   * @returns the filesystem service and every slug-named `<slug>.md` entry it
   * listed; other files are directory metadata and never candidates.
   * @throws when no filesystem service is composed, the directory cannot be
   * resolved or listed, or it holds too many files.
   */
  private async rolesEntries(signal: AbortSignal): Promise<{ fs: FileSystem; entries: readonly FsDirEntry[] }> {
    const rolesDir = this.config.rolesDir ?? BUNDLED_ROLES_DIR
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      fail('PROMPT_OPTIMIZER_NO_FS', 'prompt-optimizer: no filesystem service is composed; add a dsh-fs implementation to load role definitions')
    }
    try {
      const dir = await fs.resolve(rolesDir, { signal })
      const listed = await fs.listDir(dir, signal)
      const entries = listed.filter(entry => entry.type === 'file' && ROLE_FILE_PATTERN.test(entry.name))
      // The cap governs role definition files; side files (README, .bak) must not trip it.
      if (entries.length > ROLES_MAX_ENTRIES) {
        fail('PROMPT_OPTIMIZER_ROLES_TOO_MANY', `prompt-optimizer: rolesDir holds ${String(entries.length)} role files, above the ${String(ROLES_MAX_ENTRIES)} cap`)
      }
      return { fs, entries }
    } catch (error) {
      signal.throwIfAborted()
      if (isTypedFailure(error)) throw error
      fail('PROMPT_OPTIMIZER_ROLES_READ_FAILED', `prompt-optimizer: the roles directory could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Read one listed role entry's definition text within the size cap.
   * @param fs - filesystem service that produced the entry.
   * @param entry - listed definition file entry.
   * @param signal - caller cancellation.
   * @returns the complete definition text.
   * @throws when the read fails or the definition exceeds the size cap.
   */
  private async readRoleText(fs: FileSystem, entry: FsDirEntry, signal: AbortSignal): Promise<string> {
    let text: string
    try {
      text = await fs.readText(entry.target, signal)
    } catch (error) {
      signal.throwIfAborted()
      fail('PROMPT_OPTIMIZER_ROLES_READ_FAILED', `prompt-optimizer: role file "${entry.name}" could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (text.length > ROLE_MAX_CHARS) {
      fail('PROMPT_OPTIMIZER_ROLE_TOO_LARGE', `prompt-optimizer: role file "${entry.name}" exceeds the ${String(ROLE_MAX_CHARS)}-character cap`)
    }
    return text
  }

  /**
   * Load one role definition by slug: the slug must be shape-valid and match a
   * listed file exactly, so no request value can ever escape the directory.
   * @param role - role slug requested for the round.
   * @param signal - caller cancellation.
   * @returns the loaded role reference for meta-prompt injection.
   * @throws when the slug is malformed, absent from the directory, or its
   * definition fails the size cap.
   */
  private async loadRole(role: string, signal: AbortSignal): Promise<PromptRoleRef> {
    if (!ROLE_ID_PATTERN.test(role)) {
      fail('PROMPT_OPTIMIZER_ROLE_NOT_FOUND', `prompt-optimizer: unknown role "${role}"`)
    }
    const roles = await this.loadAllRoles(signal)
    const loaded = roles.find(candidate => candidate.id === role)
    if (loaded === undefined) {
      fail('PROMPT_OPTIMIZER_ROLE_NOT_FOUND', `prompt-optimizer: unknown role "${role}"; pick one of the listed roles`)
    }
    return loaded
  }

  /**
   * Load every role definition the configured directory holds, sorted by slug.
   * @param signal - caller cancellation.
   * @returns one loaded reference per `<slug>.md` file.
   * @throws through {@link rolesEntries} and {@link readRoleText} failure codes.
   */
  private async loadAllRoles(signal: AbortSignal): Promise<readonly PromptRoleRef[]> {
    const { fs, entries } = await this.rolesEntries(signal)
    const roles: PromptRoleRef[] = []
    for (const entry of entries) {
      const id = entry.name.slice(0, -'.md'.length)
      const text = await this.readRoleText(fs, entry, signal)
      roles.push({ id, name: roleNameOf(text) ?? id, text })
    }
    return roles.sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Library domain handle, opened once on first use. */
  private library: Promise<Domain<typeof libraryDomainSpec>> | undefined

  /**
   * Open the prompt-library domain once, failing loudly when the deployment
   * composed no storage-domain service.
   * @returns the opened domain shared by every library call.
   */
  private openLibrary(): Promise<Domain<typeof libraryDomainSpec>> {
    const domains = this.ctx.get('storageDomain')
    if (domains === undefined) {
      fail('PROMPT_OPTIMIZER_NO_LIBRARY', 'prompt-optimizer: no storage-domain service is composed; add dsh-storage-domain to persist the prompt library')
    }
    this.library ??= domains.open(libraryDomainSpec)
    return this.library
  }

  /** Metrics domain handle, opened once on first use. */
  private metrics: Promise<Domain<typeof metricsDomainSpec>> | undefined

  /**
   * Open the metrics domain once, failing loudly when the deployment composed
   * no storage-domain service.
   * @returns the opened domain shared by every metrics call.
   */
  private openMetrics(): Promise<Domain<typeof metricsDomainSpec>> {
    const domains = this.ctx.get('storageDomain')
    if (domains === undefined) {
      fail('PROMPT_OPTIMIZER_NO_METRICS', 'prompt-optimizer: no storage-domain service is composed; add dsh-storage-domain to persist local metrics')
    }
    this.metrics ??= domains.open(metricsDomainSpec)
    return this.metrics
  }

  /**
   * Append one row to the metrics table, then prune the oldest rows beyond
   * {@link METRICS_MAX_ROWS} so the append-only table stays bounded.
   * @param kind - metric kind of the row.
   * @param provider - route key the row is about.
   * @param model - model id the row is about.
   * @param tier - capability tier of that route.
   * @param count - magnitude the row carries (questions asked, answers used; 1 for events).
   */
  private async appendMetric(kind: PromptMetricKind, provider: string, model: string, tier: ModelTier, count: number): Promise<void> {
    const table = (await this.openMetrics()).table('metrics')
    const id = randomUUID()
    await table.put(id, { id, createdAt: new Date().toISOString(), kind, provider, model, tier, count })
    const entries = [...table.entries()].sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
    const excess = entries.length - METRICS_MAX_ROWS
    for (let index = 0; index < excess; index += 1) {
      await table.delete(entries[index]![0])
    }
  }

  /**
   * Record one host-observed metric. Best-effort by design: a storage failure
   * degrades to a warning and never fails the round it observes.
   * @param kind - metric kind to record.
   * @param route - route the observed round ran on.
   * @param tier - capability tier of that route.
   * @param count - magnitude the row carries.
   */
  private async recordMetric(kind: PromptMetricKind, route: { readonly provider: string; readonly model: string }, tier: ModelTier, count: number): Promise<void> {
    if (!this.config.metrics) return
    try {
      await this.appendMetric(kind, route.provider, route.model, tier, count)
    } catch (error) {
      this.ctx.logger.warn(`prompt optimizer: recording a ${kind} metric failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Record one user-decision metric the host cannot observe itself: the
   * client reports `adopted`, `rejected`, and `decline-overridden` outcomes
   * for rounds it watched.
   * @param request - session, kind, and the round's route.
   * @param signal - caller cancellation.
   * @throws when the kind is not client-reportable or the route is blank.
   */
  async reportMetric(request: PromptMetricReportRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!CLIENT_METRIC_KINDS.includes(request.kind)) {
      fail('PROMPT_OPTIMIZER_BAD_METRIC_KIND', `prompt-optimizer: clients may only report ${CLIENT_METRIC_KINDS.join(', ')}, not "${request.kind}"`)
    }
    if (request.provider.trim() === '' || request.model.trim() === '') {
      fail('PROMPT_OPTIMIZER_BAD_METRIC_ROUTE', 'prompt-optimizer: a reported metric needs the round\'s provider and model')
    }
    if (!this.config.metrics) return
    await this.appendMetric(request.kind, request.provider, request.model, request.tier ?? 'standard', 1)
    signal.throwIfAborted()
  }

  /** Repeat-fingerprint domain handle, opened once on first use. */
  private repeats: Promise<Domain<typeof repeatsDomainSpec>> | undefined

  /**
   * Open the repeats domain once, failing loudly when the deployment composed
   * no storage-domain service.
   * @returns the opened domain shared by every repeat observation.
   */
  private openRepeats(): Promise<Domain<typeof repeatsDomainSpec>> {
    const domains = this.ctx.get('storageDomain')
    if (domains === undefined) {
      fail('PROMPT_OPTIMIZER_NO_LIBRARY', 'prompt-optimizer: no storage-domain service is composed; add dsh-storage-domain to persist repeat fingerprints')
    }
    this.repeats ??= domains.open(repeatsDomainSpec)
    return this.repeats
  }

  /**
   * Record one completed optimization of a draft as a normalized fingerprint
   * and report whether this is the round the distillation suggestion fires.
   * Fingerprints are one-way hashes — never draft content. Best-effort by
   * design: a storage failure degrades to no suggestion and never fails the
   * round it observes.
   * @param session - live session that owns the completed round (unused beyond shape parity).
   * @param draft - complete draft text the round optimized.
   * @returns true exactly when this completion is the {@link REPEAT_DISTILL_THRESHOLD}-th of the same normalized draft.
   */
  private async noteRepeat(session: Session, draft: string): Promise<boolean> {
    void session
    if (!this.config.metrics) return false
    try {
      const fingerprint = createHash('sha256').update(draft.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex')
      const table = (await this.openRepeats()).table('repeats')
      const id = randomUUID()
      await table.put(id, { id, createdAt: new Date().toISOString(), fingerprint })
      const entries = [...table.entries()].sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
      const excess = entries.length - REPEATS_MAX_ROWS
      for (let index = 0; index < excess; index += 1) {
        await table.delete(entries[index]![0])
      }
      return entries.filter(([, row]) => row.fingerprint === fingerprint).length === REPEAT_DISTILL_THRESHOLD
    } catch (error) {
      this.ctx.logger.warn(`prompt optimizer: recording a draft fingerprint failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Distillations pending a confirming call, keyed by session id. */
  private readonly pendingDistills = new Map<string, string>()

  /**
   * Resolve the directory the confirm phase writes `<name>/SKILL.md` into: the
   * configured `distillDir`, else the session project's `.dsh/skills` — a root
   * the harness skill registry lists for that project, so the distilled skill
   * joins the agent's skill catalog immediately.
   * @param session - live session owning the working-directory fallback.
   * @returns the absolute target directory.
   * @throws when neither a configured directory nor a session working directory exists.
   */
  private distillTargetDir(session: Session): string {
    if (this.config.distillDir !== undefined) {
      return this.config.distillDir
    }
    const cwd = this.ctx.get('workingDirectory')?.get(session)
    if (cwd === undefined) {
      fail('PROMPT_OPTIMIZER_NO_DISTILL_TARGET', 'prompt-optimizer: no distill target; configure distillDir, or run inside a session that owns a working directory')
    }
    return `${cwd}/.dsh/skills`
  }

  /**
   * Scan the Session's standing context — the scoped system prompt's assembled
   * sections plus the installed skills visible to the session's working
   * directory — and surface oversized blocks, near-duplicate content, and
   * stale file references. Deterministic: no model round runs.
   * @param request - session whose context is scanned.
   * @param signal - caller cancellation.
   * @returns sizing for both inputs plus findings; empty findings mean clean.
   * @throws when the session is gone or a listing fails.
   */
  async contextCheck(request: PromptContextCheckRequest, signal: AbortSignal): Promise<PromptContextCheckResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    const cwd = this.ctx.get('workingDirectory')?.get(session)
    const systemPrompt = this.ctx.get('systemPrompt')
    // The agent is the scope key its sections registered under; without one the scan degrades to the global layer.
    const agent = this.ctx.get('agents')?.get(request.sessionId)
    let systemPromptStat: PromptContextCheckResult['systemPrompt']
    let sectionFindings: ReturnType<typeof analyzeSections>['findings'] = []
    if (systemPrompt !== undefined) {
      const assembly = await systemPrompt.assemble({ ...(agent !== undefined ? { scope: agent } : {}), signal })
      const sections = assembly.sections.map(section => ({ name: section.name, text: section.text }))
      const analysis = analyzeSections(sections)
      systemPromptStat = {
        totalChars: sections.reduce((sum, section) => sum + section.text.length, 0),
        estimatedTokens: estimateTokens(sections.map(section => section.text).join('\n')),
        sections: analysis.stats,
      }
      sectionFindings = analysis.findings
    }
    const registry = this.ctx.get('skills')
    let skills: PromptContextCheckResult['skills'] = { count: 0, modelInvocable: 0, scannedBodies: 0, totalBodyChars: 0 }
    let skillFindings: Awaited<ReturnType<typeof analyzeSkills>> = []
    if (registry !== undefined) {
      const summaries = await registry.list({ ...(cwd !== undefined ? { cwd } : {}), signal })
      const invocable = summaries.filter(summary => summary.invocation.modelInvocable)
      const scanned: { name: string; body: string; base: string | undefined }[] = []
      for (const summary of invocable.slice(0, MAX_SCANNED_SKILLS)) {
        try {
          const definition = await registry.get(summary.name, { ...(cwd !== undefined ? { cwd } : {}), signal })
          if (definition !== undefined) {
            scanned.push({
              name: summary.name,
              body: definition.content,
              base: definition.resourceBase?.kind === 'directory' ? definition.resourceBase.path : undefined,
            })
          }
        } catch {
          signal.throwIfAborted()
        }
      }
      const fs = this.ctx.get('fs')
      skillFindings = await analyzeSkills(
        scanned.map(entry => ({ name: entry.name, body: entry.body })),
        async (skill, reference) => {
          const base = scanned.find(entry => entry.name === skill)?.base
          if (base === undefined || fs === undefined) return true
          try {
            const target = await fs.resolve(`${base}/${reference}`, { signal })
            return (await fs.stat(target, signal)) !== undefined
          } catch {
            signal.throwIfAborted()
            return false
          }
        },
      )
      skills = {
        count: summaries.length,
        modelInvocable: invocable.length,
        scannedBodies: scanned.length,
        totalBodyChars: scanned.reduce((sum, entry) => sum + entry.body.length, 0),
      }
    }
    return {
      ...(systemPromptStat !== undefined ? { systemPrompt: systemPromptStat } : {}),
      skills,
      findings: [...sectionFindings, ...skillFindings],
    }
  }

  /**
   * Distill one completed round into a durable agent skill file, in two phases
   * over one model round: a preview call (`confirm` absent or false) feeds the
   * round's draft, optimized result, and interview answers to one model round,
   * validates the produced SKILL.md, stores it as pending, and returns it in
   * `pendingDefinition` without writing files; a confirming call (`confirm:
   * true`) runs no model round, re-validates the pending definition, then
   * writes a pre-existing definition to `SKILL.md.bak` (which the registry
   * never lists) before the new definition replaces `SKILL.md`.
   * @param request - producing session, the round's texts, answers, and the phase selector.
   * @param signal - caller cancellation.
   * @returns the distilled skill's name, description, byte size, and target directory — plus the pending definition on previews.
   * @throws when the session is gone, the texts fail bounds, no target directory resolves, the model round fails, or the produced definition fails validation.
   */
  async distillSkill(request: PromptDistillRequest, signal: AbortSignal): Promise<PromptDistillResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    if (request.draft.trim() === '' || request.optimized.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_TEXT', 'prompt-optimizer: a distillation needs the round\'s non-empty draft and optimized text')
    }
    const clarifications = normalizeClarifications(request.clarifications, this.config.maxInputBytes)
    const targetDir = this.distillTargetDir(session)
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      fail('PROMPT_OPTIMIZER_NO_FS', 'prompt-optimizer: no filesystem service is composed; add a dsh-fs implementation to write distilled skills')
    }
    let definition: string
    if (request.confirm === true) {
      definition = this.pendingDistills.get(request.sessionId) ?? fail('PROMPT_OPTIMIZER_DISTILL_NOT_PENDING', 'prompt-optimizer: confirm requires a preceding preview for this session')
    } else {
      const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
      const messages: Message[] = [createUserMessage({
        content: [{ type: 'text', text: distillationUserInput(request.draft, request.optimized, clarifications) }],
        source: { kind: 'dsh-prompt-optimizer' },
      })]
      try {
        using callDeadline = deadline(signal, this.config.timeoutMs, 'PROMPT_OPTIMIZER_TIMEOUT')
        let call: Awaited<ReturnType<typeof this.ctx.llm.prepareCall>>
        try {
          call = await this.ctx.llm.prepareCall({ ...route, maxTokens: this.config.maxOutputTokens }, callDeadline.signal)
        } catch (error) {
          callDeadline.signal.throwIfAborted()
          if (error instanceof LlmError && error.code === 'NO_ADAPTER') {
            fail('PROMPT_OPTIMIZER_NO_ADAPTER', noAdapterMessage(this.ctx, route.provider))
          }
          throw error
        }
        const llmOptions: GenerateOptions = {
          ...call.config,
          messages,
          system: distillationSystemPrompt(),
          sessionId: request.sessionId,
          signal: callDeadline.signal,
        }
        callDeadline.signal.throwIfAborted()
        const assembler = new BlockAssembler()
        for await (const chunk of call.stream(llmOptions)) {
          callDeadline.signal.throwIfAborted()
          assembler.push(chunk)
        }
        callDeadline.signal.throwIfAborted()
        terminalFinish(assembler.finish)
        definition = responseText(assembler.blocks()).trim()
      } catch (error) {
        signal.throwIfAborted()
        if (isTypedFailure(error)) throw error
        fail('PROMPT_OPTIMIZER_DISTILL_FAILED', `prompt-optimizer: distilling the round failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let parsed: ReturnType<typeof parseSkillDefinition>
    try {
      parsed = parseSkillDefinition(definition)
    } catch (error) {
      fail('PROMPT_OPTIMIZER_DISTILL_INVALID', `prompt-optimizer: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (definition.length > SKILL_MAX_CHARS) {
      fail('PROMPT_OPTIMIZER_DISTILL_INVALID', `prompt-optimizer: the distilled skill definition exceeds the ${String(SKILL_MAX_CHARS)}-character cap`)
    }
    if (request.confirm !== true) {
      this.pendingDistills.set(request.sessionId, definition)
      return {
        name: parsed.name,
        description: parsed.description,
        bytes: Buffer.byteLength(definition, 'utf8'),
        targetDir,
        pendingDefinition: definition,
      }
    }
    const skillFile = await fs.resolve(`${targetDir}/${parsed.name}/SKILL.md`, { signal })
    try {
      const existing = await fs.readText(skillFile, signal).catch(() => undefined)
      if (existing !== undefined) {
        await fs.writeText(await fs.resolve(`${targetDir}/${parsed.name}/SKILL.md.bak`, { signal }), existing, undefined, signal)
      }
      await fs.writeText(skillFile, definition, undefined, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (isTypedFailure(error)) throw error
      fail('PROMPT_OPTIMIZER_DISTILL_FAILED', `prompt-optimizer: writing the distilled skill failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.pendingDistills.delete(request.sessionId)
    const bytes = Buffer.byteLength(definition, 'utf8')
    appendPluginRecord(session, 'plugin:prompt-optimizer/distilled', { name: parsed.name, targetDir, bytes })
    await this.recordMetric('distilled', { provider: '', model: '' }, 'standard', 1)
    return { name: parsed.name, description: parsed.description, bytes, targetDir }
  }

  /**
   * Aggregate the persisted metric rows into the summary the settings page
   * renders: decision counts, question totals, and the two rates that say
   * whether the optimizer is actually helping.
   * @param signal - caller cancellation.
   * @returns the aggregate over the most recent {@link METRICS_AGGREGATE_ROWS}
   * rows; rates are null before their inputs exist.
   */
  async listMetrics(signal: AbortSignal): Promise<PromptMetricsSummary> {
    signal.throwIfAborted()
    const rows = [...(await this.openMetrics()).table('metrics').entries()]
      .map(([, row]) => row)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, METRICS_AGGREGATE_ROWS)
    const rowsOf = (kind: PromptMetricKind): number => rows.reduce((total, row) => row.kind === kind ? total + 1 : total, 0)
    const sumOf = (kind: PromptMetricKind): number => rows.reduce((total, row) => row.kind === kind ? total + row.count : total, 0)
    const adopted = rowsOf('adopted')
    const rejected = rowsOf('rejected')
    const verifyPassed = rowsOf('verify-passed')
    const verifyFailed = rowsOf('verify-failed')
    const judgeRows = rows.filter(row => row.kind === 'judge-score')
    const decided = adopted + rejected
    const verified = verifyPassed + verifyFailed
    return {
      adopted,
      rejected,
      declined: rowsOf('declined'),
      declineOverridden: rowsOf('decline-overridden'),
      interviewQuestions: sumOf('interviewed'),
      clarifiedRounds: rowsOf('clarified'),
      verifyPassed,
      verifyFailed,
      candidatesRounds: rowsOf('candidates-generated'),
      judgedRounds: judgeRows.length,
      distills: rowsOf('distilled'),
      judgeAverage: judgeRows.length === 0
        ? null
        : judgeRows.reduce((total, row) => total + row.count, 0) / judgeRows.length,
      adoptionRate: decided === 0 ? null : adopted / decided,
      verifyPassRate: verified === 0 ? null : verifyPassed / verified,
      rows: rows.length,
    }
  }
}

/** Branded session identity re-export for standalone consumers of the service. */
export type { SessionId }
