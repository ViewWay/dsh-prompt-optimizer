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
  PromptLibraryDeleteRequest,
  PromptLibraryEntry,
  PromptLibrarySaveRequest,
  PromptOptimizeDirection,
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
} from './types.ts'
import {
  critiqueSystemPrompt,
  critiqueUserInput,
  detectDomainPriors,
  optimizerSystemPrompt,
  optimizerSystemPromptForSystem,
  optimizerUserInput,
  parseOptimizerResponse,
  roleEvolutionSystemPrompt,
  roleEvolutionUserInput,
} from './meta-prompt.ts'
import type { PromptRoleRef, RoundConditioning } from './meta-prompt.ts'
import { recommendRoles as rankRoles } from './recommend.ts'
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
        fail('PROMPT_OPTIMIZER_NO_ADAPTER', `prompt-optimizer: provider "${options.route.provider}" has no active model adapter in this app; pick an available model in the composer or configure provider and model together`)
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
    const requestedRole = request.role ?? this.config.defaultRole
    const role = requestedRole === undefined ? undefined : await this.loadRole(requestedRole, signal)
    const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    const priors = this.config.domainPriors ? detectDomainPriors(request.text) : []
    const language = normalizeLanguage(request.language)
    const rankingContext = [request.text, this.inboxText(session)].filter(part => part !== '').join('\n')
    const skills = await this.resolveSkillHints(session, rankingContext, signal)
    signal.throwIfAborted()
    const conditioning: RoundConditioning = {
      domainPriors: priors,
      skills,
      ...(role !== undefined ? { role } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(direction !== undefined ? { direction } : {}),
    }
    const first = await this.dispatchRound(session, {
      route,
      target,
      round: 1,
      system: target === 'system' ? optimizerSystemPromptForSystem(conditioning) : optimizerSystemPrompt(conditioning),
      input: optimizerUserInput(request.text, previousAttempts),
      inputBytes,
      previousAttempts,
      sessionId: request.sessionId,
      role,
      skillsHinted: skills.length,
      language,
      direction,
    }, signal)
    if (first.parsed.optimizedText === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_RESULT', 'prompt-optimizer: the model returned an empty rewrite')
    }
    if (target === 'draft') {
      return {
        optimizedText: first.parsed.optimizedText,
        changes: first.parsed.changes,
        acceptance: first.parsed.acceptance,
        provider: route.provider,
        model: route.model,
        ...(role !== undefined ? { role: role.id } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(skills.length > 0 ? { skills: skills.map(hint => hint.name) } : {}),
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
      ...(role !== undefined ? { role: role.id } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(skills.length > 0 ? { skills: skills.map(hint => hint.name) } : {}),
      ...(usage !== undefined ? { usage } : {}),
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
            fail('PROMPT_OPTIMIZER_NO_ADAPTER', `prompt-optimizer: provider "${route.provider}" has no active model adapter in this app; pick an available model in the composer or configure provider and model together`)
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
}

/** Branded session identity re-export for standalone consumers of the service. */
export type { SessionId }
