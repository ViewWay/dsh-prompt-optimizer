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
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendPluginRecord as appendPluginRecordPeer } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PluginRecordMap, PluginRecordType, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
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
  PromptContextFinding,
  PromptContextFixKind,
  PromptContextFixRequest,
  PromptContextFixResult,
  PromptDistillRequest,
  PromptDistillResult,
  PromptEvalRunRequest,
  PromptEvalRunResult,
  PromptEvalSampleOutcome,
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
  detectDomainId,
  detectDomainPriors,
  distillationSystemPrompt,
  distillationUserInput,
  goalInterviewSystemPrompt,
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
  sectionMergeSystemPrompt,
  sectionMergeUserInput,
  skillEvolutionSystemPrompt,
  skillEvolutionUserInput,
  skillMergeSystemPrompt,
  skillMergeUserInput,
  roleEvolutionSystemPrompt,
  roleEvolutionUserInput,
  SKILL_NAME_PATTERN,
} from './meta-prompt.ts'
import type { PromptRoleRef, RoundConditioning } from './meta-prompt.ts'
import { recommendRoles as rankRoles } from './recommend.ts'
import { classifyModelTier, declineToOptimize } from './model-tier.ts'
import { analyzeSections, analyzeSkills, estimateTokens } from './context-check.ts'
import { isWithin, nearestExistingFile, plainMergeText, referenceOfDetail, splitPairSubject, stripReference } from './context-fix.ts'
import { EVAL_MAX_SAMPLES, selectEvalSamples } from './eval-pack.ts'
import { enrichSkillHint, MAX_DETAIL_HINTS, selectSkillHints } from './skills.ts'
import type { SkillHint } from './skills.ts'
import { screenVerifyCommand } from './verify-policy.ts'

export type * from './types.ts'

/**
 * The installed app runtime bundles its own `@deepseek-ai/dsh-session` inside
 * the app archive, while a profile plugin resolves the peer copy from the
 * profile tree — and a profile whose dependencies pull the harness stack (for
 * example via dsh-agent-teams) always carries that local copy, so plain Node
 * resolution can never reach the runtime's class. The two copies are distinct
 * classes, and appending a record calls a `#`-private method whose brand check
 * rejects the foreign receiver ("Receiver must be an instance of class
 * Session"). Resolve the writer from the bundle the runtime itself uses when
 * reachable, and fall back to the peer import where host and plugin share one
 * copy (source checkouts, dev harness runs).
 */
type PluginRecordWriter = <K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
) => SessionSeq

let sessionRecordWriter: PluginRecordWriter | undefined

function appendPluginRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session | undefined,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): SessionSeq | undefined {
  if (session === undefined) return undefined
  const candidates: PluginRecordWriter[] = sessionRecordWriter === undefined
    ? recordWriterCandidates()
    : [sessionRecordWriter, ...recordWriterCandidates().filter(writer => writer !== sessionRecordWriter)]
  let brandFailure: unknown
  for (const writer of candidates) {
    try {
      const seq = writer(session, type, data)
      sessionRecordWriter = writer
      return seq
    } catch (failure) {
      // A writer from a stale dsh-session copy fails the Session brand check;
      // drop the cache and let the next resolution candidate try.
      if (!isSessionBrandFailure(failure)) throw failure
      brandFailure ??= failure
      sessionRecordWriter = undefined
    }
  }
  throw brandFailure
}

function isSessionBrandFailure(failure: unknown): boolean {
  return failure instanceof Error && failure.message.includes('Receiver must be an instance of class')
}

function recordWriterCandidates(): PluginRecordWriter[] {
  const candidates: PluginRecordWriter[] = []
  const bundled = bundledRuntimeRecordWriter()
  if (bundled !== undefined) candidates.push(bundled)
  const entry = entryRuntimeRecordWriter()
  if (entry !== undefined) candidates.push(entry)
  candidates.push(appendPluginRecordPeer as PluginRecordWriter)
  return candidates
}

/**
 * The dev CLI (`node …/apps/cli/lib/bin.js`) and an npm-installed CLI both run
 * the runtime's own module graph, so a require rooted at the entry script
 * reaches the same in-process dsh-session copy that created the runtime's
 * Session instances — the peer import in a plugin profile does not.
 */
function entryRuntimeRecordWriter(): PluginRecordWriter | undefined {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return undefined
  try {
    const require = createRequire(entry)
    const writer = (require('@deepseek-ai/dsh-session') as { appendPluginRecord?: PluginRecordWriter }).appendPluginRecord
    return typeof writer === 'function' ? writer : undefined
  } catch {
    return undefined
  }
}

function bundledRuntimeRecordWriter(): PluginRecordWriter | undefined {
  const resources = runtimeResourcesDir()
  if (resources === undefined) return undefined
  try {
    const require = createRequire(join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-session/package.json'))
    const writer = (require('@deepseek-ai/dsh-session') as { appendPluginRecord?: PluginRecordWriter }).appendPluginRecord
    return typeof writer === 'function' ? writer : undefined
  } catch {
    return undefined
  }
}

function runtimeResourcesDir(): string | undefined {
  const declared = (process as { resourcesPath?: string }).resourcesPath
  if (typeof declared === 'string' && declared !== '') return declared
  const darwin = /(.+)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath)
  return darwin === null ? undefined : `${darwin[1]}/Contents/Resources`
}

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
    /** Log-only record of one confirmed context-doctor repair write. */
    'plugin:prompt-optimizer/context-fixed': PromptOptimizerContextFixedEventData
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

/** One confirmed context-doctor repair write, recorded after the write. */
export interface PromptOptimizerContextFixedEventData {
  /** Fixable finding kind the repair addressed. */
  readonly kind: PromptContextFixKind
  /** Finding subject the repair addressed. */
  readonly subject: string
  /** UTF-8 byte size of the written proposal. */
  readonly bytes: number
}

/** One repair pending a confirming call, stored per session by the preview phase. */
interface PendingContextFix {
  /** Fixable finding kind the repair addresses. */
  readonly kind: PromptContextFixKind
  /** Finding subject the repair addresses. */
  readonly subject: string
  /** Finding detail shown in the preview the user is confirming. */
  readonly detail: string
  /** Full replacement text a confirming call writes. */
  readonly proposal: string
  /** File the confirm rewrites; undefined never pends (advisory proposals do not). */
  readonly targetFile: string | undefined
  /** duplicate-skill only: the second definition file retired to a stub, and the names the stub carries. */
  readonly retire: { readonly file: string; readonly retiredName: string; readonly mergeInto: string } | undefined
}

/**
 * Tombstone definition written over the retired half of a duplicate-skill
 * merge: the filesystem service has no delete, so the stub keeps the slot
 * parseable, stays far below the duplicate-detection floor, and tells the
 * reader the directory is safe to delete by hand.
 * @param retiredName - registry name of the retired skill.
 * @param mergeInto - registry name of the skill that absorbed it.
 * @returns the tombstone SKILL.md text.
 */
function retiredSkillDefinition(retiredName: string, mergeInto: string): string {
  return [
    '---',
    `name: ${retiredName}`,
    `description: Retired - merged into ${mergeInto}; this directory can be deleted.`,
    '---',
    '',
    '# Retired',
    '',
    `Merged into \`${mergeInto}\`; use that skill instead.`,
    '',
  ].join('\n')
}

/**
 * Pin a merged skill definition's frontmatter `name:` to the first skill's
 * registry name: the merged file lives in that skill's directory, so a
 * model-renamed value would break the catalog mapping.
 * @param definition - merged definition file text, frontmatter included.
 * @param name - canonical registry name to pin.
 * @returns the definition with its first frontmatter `name:` line rewritten.
 */
function canonicalSkillName(definition: string, name: string): string {
  return definition.replace(/^(---\n[\s\S]*?)^name:.*$/m, `$1name: ${name}`)
}

/** Normalized one-way fingerprint of a draft: trimmed, lowercased, whitespace-collapsed, then SHA-256. */
function draftFingerprint(draft: string): string {
  return createHash('sha256').update(draft.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex')
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
  /** Whether adopted results persist as same-domain precedents that later rounds reference. */
  readonly precedents: boolean
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
/** Most acceptance criteria one goal-mode request may carry. */
const MAX_GOAL_CRITERIA = 4
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
/** Most system-prompt track rows kept on disk, across every session. */
const TRACKS_MAX_ROWS = 200
/** Most draft-to-skill link rows kept on disk; the oldest beyond the cap are pruned on write. */
const SKILL_LINKS_MAX_ROWS = 200
/** Precedents kept per domain, ranked by judge total then recency. */
const PRECEDENTS_PER_DOMAIN = 3
/** Most precedent rows kept on disk across every domain; the lowest-ranked beyond the cap are pruned on write. */
const PRECEDENTS_MAX_ROWS = 100
/** Sample count an evidence run carries when the request names none. */
const EVAL_DEFAULT_SAMPLES = 3
/** Metric kinds a client may report; host-written kinds are never accepted from the wire. */
const CLIENT_METRIC_KINDS: readonly PromptMetricKind[] = ['adopted', 'rejected', 'decline-overridden']
/** Most metric rows kept on disk; the oldest beyond the cap are pruned on write. */
const METRICS_MAX_ROWS = 2_000
/** Most metric rows one summary aggregates over, newest first. */
const METRICS_AGGREGATE_ROWS = 1_000
/** Every rewrite direction a request may steer a round toward. */
const DIRECTIONS: readonly PromptOptimizeDirection[] = ['concise', 'detailed', 'technical', 'structured', 'acceptance']
/** Finding kinds the repair flow accepts. */
const CONTEXT_FIX_KINDS: readonly PromptContextFixKind[] = ['stale-skill-reference', 'duplicate-skill', 'duplicate-section']
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

/** Persisted system-prompt track row; the storage schema validates this plain shape. */
interface SystemTrackRow {
  id: string
  sessionId: string
  provider: string
  model: string
  tier: string
  createdAt: string
}

/**
 * Per-session system-prompt optimization tracks: the latest route each
 * session's standing system prompt was tuned on, powering the model-switch
 * staleness reminder. Never prompt content.
 */
const systemTracksDomainSpec = defineDomain({
  name: 'prompt_optimizer_system_tracks',
  version: 1,
  tables: {
    tracks: domainTable<string, SystemTrackRow>(zod.object({
      id: zod.string(),
      sessionId: zod.string(),
      provider: zod.string(),
      model: zod.string(),
      tier: zod.string(),
      createdAt: zod.string(),
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

/** Persisted draft-to-skill link row; the storage schema validates this plain shape. */
interface SkillLinkRow {
  id: string
  createdAt: string
  fingerprint: string
  name: string
  targetDir: string
}

/**
 * Draft-to-skill links: the latest normalized-draft fingerprint each
 * distilled skill was born from (never draft content), powering the
 * "update that skill instead of distilling a fresh one" suggestion.
 */
const skillLinksDomainSpec = defineDomain({
  name: 'prompt_optimizer_skill_links',
  version: 1,
  tables: {
    links: domainTable<string, SkillLinkRow>(zod.object({
      id: zod.string(),
      createdAt: zod.string(),
      fingerprint: zod.string(),
      name: zod.string(),
      targetDir: zod.string(),
    })),
  },
})

/** Persisted same-domain precedent row; the storage schema validates this plain shape. */
interface PrecedentRow {
  id: string
  createdAt: string
  domain: string
  text: string
  /** Judge total (0–30) when the adopted candidate was judged; absent otherwise. */
  judgeTotal?: number | undefined
}

/**
 * Same-domain precedents: adopted optimization results (full text — unlike
 * the metrics domain, this one carries content by design) that later rounds
 * in the same technical domain reference as prior art.
 */
const precedentsDomainSpec = defineDomain({
  name: 'prompt_optimizer_precedents',
  version: 1,
  tables: {
    precedents: domainTable<string, PrecedentRow>(zod.object({
      id: zod.string(),
      createdAt: zod.string(),
      domain: zod.string(),
      text: zod.string(),
      judgeTotal: zod.number().optional(),
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
/** Provider/model pair as recorded by the agent-loop's `modelSelection` projection. */
interface ModelSelectionRoute { provider: string; model: string }

/** State of the agent-loop's `modelSelection` projection (map entry typed outside this tree). */
interface ModelSelectionProjectionState {
  pending?: ModelSelectionRoute | null
  lastUsed?: ModelSelectionRoute | null
}

/** State of the agent-loop's `inbox` projection: messages pending per delivery lane. */
interface InboxProjectionState {
  'next-turn': readonly { readonly content: readonly ContentBlock[] }[]
  'next-step': readonly { readonly content: readonly ContentBlock[] }[]
}

function sessionSelectionRoute(ctx: Context, session: Session | undefined): { provider: string; model: string } | undefined {
  if (session === undefined) return undefined
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return undefined
  const state = projections.stateOf(session, 'modelSelection') as ModelSelectionProjectionState | null | undefined
  const selection = state?.pending ?? state?.lastUsed
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
  session: Session | undefined,
  defaultRoute: { provider: string; model: string } | undefined,
): { provider: string; model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const selection = sessionSelectionRoute(ctx, session)
  if (selection !== undefined) {
    return selection
  }
  const header = session?.requestHeader()?.config
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
 * Normalize the acceptance criteria one goal-mode request carries: trimmed,
 * count- and byte-capped, every entry non-empty — they are authoritative, so
 * a malformed replay must fail loudly instead of quietly degrading the round.
 * @param criteria - raw request field.
 * @param maxBytes - byte cap the criteria's combined size must respect.
 * @returns the normalized criteria; empty for a plain round.
 * @throws when an entry is empty, the count exceeds the cap, or the combined
 * size exceeds `maxBytes`.
 */
function normalizeGoalCriteria(
  criteria: readonly string[] | undefined,
  maxBytes: number,
): readonly string[] {
  if (criteria === undefined) return []
  if (criteria.length > MAX_GOAL_CRITERIA) {
    fail('PROMPT_OPTIMIZER_BAD_GOAL_CRITERIA', `prompt-optimizer: at most ${String(MAX_GOAL_CRITERIA)} acceptance criteria may be carried`)
  }
  const normalized = criteria.map(criterion => criterion.trim())
  if (normalized.some(criterion => criterion === '')) {
    fail('PROMPT_OPTIMIZER_BAD_GOAL_CRITERIA', 'prompt-optimizer: every acceptance criterion needs to be non-empty')
  }
  const bytes = normalized.reduce((total, criterion) => total + Buffer.byteLength(criterion, 'utf8'), 0)
  if (bytes > maxBytes) {
    fail('PROMPT_OPTIMIZER_BAD_GOAL_CRITERIA', `prompt-optimizer: acceptance criteria total ${String(bytes)} bytes, exceeding maxInputBytes ${String(maxBytes)}`)
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
    precedents: z.boolean().default(true),
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
  private async dispatchRound(session: Session | undefined, options: {
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
   * @throws bounds fail, the deadline or
   * cancellation fires, or a stream ends in an operational failure.
   */
  async optimize(request: PromptOptimizeRequest, signal: AbortSignal): Promise<PromptOptimizeResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
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
    const goalCriteria = normalizeGoalCriteria(request.goalCriteria, this.config.maxInputBytes)
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
      ...(goalCriteria.length > 0 ? { goalCriteria } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(direction !== undefined ? { direction } : {}),
    }
    const precedent = await this.roundPrecedent(request.text, tier)
    const first = await this.dispatchRound(session, {
      route,
      target,
      round: 1,
      system: target === 'system' ? optimizerSystemPromptForSystem(conditioning) : optimizerSystemPrompt(conditioning),
      input: optimizerUserInput(request.text, previousAttempts, clarifications, precedent),
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
    const suggestions = await this.repeatSuggestions(session, request.text)
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
        ...(suggestions.suggestDistill === true ? { suggestDistill: true } : {}),
      ...(suggestions.suggestEvolve !== undefined ? { suggestEvolve: suggestions.suggestEvolve } : {}),
        ...(await this.systemPromptStaleness(session, route)),
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
    await this.recordSystemTrack(session, route, tier)
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
      ...(suggestions.suggestDistill === true ? { suggestDistill: true } : {}),
      ...(suggestions.suggestEvolve !== undefined ? { suggestEvolve: suggestions.suggestEvolve } : {}),
      ...(await this.systemPromptStaleness(session, route)),
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
   * @throws bounds fail, the decline precheck fires
   * without `force`, a rewrite round returns empty, or the deadline or
   * cancellation fires.
   */
  async optimizeCandidates(request: PromptCandidatesRequest, signal: AbortSignal): Promise<PromptCandidatesResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
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
    const goalCriteria = normalizeGoalCriteria(request.goalCriteria, this.config.maxInputBytes)
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
      ...(goalCriteria.length > 0 ? { goalCriteria } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(direction !== undefined ? { direction } : {}),
    }
    const precedent = await this.roundPrecedent(request.text, tier)
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
          precedent,
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
    const suggestions = await this.repeatSuggestions(session, request.text)
    return {
      candidates,
      recommended: recommendedIndex,
      ...(judgeError !== undefined ? { judgeFailed: true, judgeError } : {}),
      ...(suggestions.suggestDistill === true ? { suggestDistill: true } : {}),
      ...(suggestions.suggestEvolve !== undefined ? { suggestEvolve: suggestions.suggestEvolve } : {}),
      ...(await this.systemPromptStaleness(session, route)),
      provider: route.provider,
      model: route.model,
      tier,
      ...(skills.length > 0 ? { skills: skills.map(hint => hint.name) } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
  }

  /**
   * Run the bundled evidence pack on the Session's current route: every
   * selected sample goes through one rewrite round plus one judge round that
   * scores the raw draft against the rewrite, so the settings card can show
   * whether optimization measurably helps this route — and re-run the
   * comparison after a model switch makes the standing guidance stale. A
   * failed judge degrades that sample to unscored instead of failing the run.
   * @param request - session and optional sample count (default 3, allowed 1–6).
   * @param signal - caller cancellation.
   * @returns per-sample outcomes with the improved and judged totals.
   * @throws the count is out of bounds, or a
   * rewrite round fails.
   */
  async runEvalPack(request: PromptEvalRunRequest, signal: AbortSignal): Promise<PromptEvalRunResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    const count = request.count ?? EVAL_DEFAULT_SAMPLES
    if (!Number.isInteger(count) || count < 1 || count > EVAL_MAX_SAMPLES) {
      fail('PROMPT_OPTIMIZER_BAD_EVAL_COUNT', `prompt-optimizer: count must be an integer between 1 and ${String(EVAL_MAX_SAMPLES)}`)
    }
    const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    const tier = classifyModelTier(route.provider, route.model)
    const outcomes: PromptEvalSampleOutcome[] = []
    const usages: (TokenUsage | undefined)[] = []
    for (const sample of selectEvalSamples(count)) {
      signal.throwIfAborted()
      const inputBytes = Buffer.byteLength(sample.draft, 'utf8')
      const rewrite = await this.dispatchRound(session, {
        route,
        target: 'draft',
        round: 1,
        system: optimizerSystemPrompt({
          ...(this.config.domainPriors ? { domainPriors: detectDomainPriors(sample.draft) } : {}),
          tier,
        }),
        input: optimizerUserInput(sample.draft, []),
        inputBytes,
        previousAttempts: [],
        sessionId: request.sessionId,
        role: undefined,
        skillsHinted: 0,
        language: undefined,
        direction: undefined,
        tier,
        clarifications: 0,
        judge: false,
      }, signal)
      if (rewrite.parsed.optimizedText === '') {
        fail('PROMPT_OPTIMIZER_EMPTY_RESULT', `prompt-optimizer: the evidence rewrite for sample "${sample.id}" came back empty`)
      }
      usages.push(rewrite.usage)
      let rawTotal: number | undefined
      let optimizedTotal: number | undefined
      try {
        signal.throwIfAborted()
        const judgeRound = await this.dispatchRound(session, {
          route,
          target: 'draft',
          round: 2,
          system: judgeSystemPrompt(),
          input: judgeUserInput(sample.draft, [], [
            { label: 'A', text: sample.draft },
            { label: 'B', text: rewrite.parsed.optimizedText },
          ]),
          inputBytes,
          previousAttempts: [],
          sessionId: request.sessionId,
          role: undefined,
          skillsHinted: 0,
          language: undefined,
          direction: undefined,
          tier,
          clarifications: 0,
          judge: true,
        }, signal)
        usages.push(judgeRound.usage)
        const parsed = parseJudgeResponse(judgeRound.parsed.optimizedText, ['A', 'B'])
        const totalOf = (scores: { faithfulness: number; completeness: number; clarity: number } | undefined): number | undefined =>
          scores === undefined ? undefined : scores.faithfulness + scores.completeness + scores.clarity
        rawTotal = totalOf(parsed.scores.find(entry => entry.label === 'A')?.scores)
        optimizedTotal = totalOf(parsed.scores.find(entry => entry.label === 'B')?.scores)
      } catch {
        signal.throwIfAborted()
        // A failed judge degrades the sample to unscored instead of failing the run.
      }
      outcomes.push({
        id: sample.id,
        domain: sample.domain,
        ...(rawTotal !== undefined ? { rawTotal } : {}),
        ...(optimizedTotal !== undefined ? { optimizedTotal } : {}),
        improved: rawTotal !== undefined && optimizedTotal !== undefined && optimizedTotal > rawTotal,
      })
    }
    const improved = outcomes.filter(outcome => outcome.improved).length
    const judged = outcomes.filter(outcome => outcome.rawTotal !== undefined && outcome.optimizedTotal !== undefined).length
    await this.recordMetric('eval-run', route, tier, outcomes.length)
    if (improved > 0) {
      await this.recordMetric('eval-win', route, tier, improved)
    }
    const usage = sumTokenUsage(usages)
    return {
      samples: outcomes,
      improved,
      judged,
      provider: route.provider,
      model: route.model,
      tier,
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
   * @throws bounds fail, the deadline or
   * cancellation fires, or the stream ends in an operational failure.
   */
  async interview(request: PromptInterviewRequest, signal: AbortSignal): Promise<PromptInterviewResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
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
      system: request.mode === 'goal' ? goalInterviewSystemPrompt(conditioning) : interviewSystemPrompt(conditioning),
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
    appendPluginRecord(session, 'plugin:prompt-optimizer/verify', { criterion: request.criterion, command: redactSecrets(command), ...verified })
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
   * @throws `rolesDir` is unset (the bundled
   * library is read-only), the role is not listed, the model round fails, a
   * confirm arrives without a pending preview, or the produced definition
   * fails validation.
   */
  async evolveRole(request: PromptRoleEvolveRequest, signal: AbortSignal): Promise<PromptRoleEvolveResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
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
  private inboxText(session: Session | undefined): string {
    if (session === undefined) return ''
    const inbox = this.ctx.get('sessionProjections')?.stateOf(session, 'inbox') as InboxProjectionState | null | undefined
    if (inbox == null) return ''
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
  private async resolveSkillHints(session: Session | undefined, context: string, signal: AbortSignal): Promise<readonly SkillHint[]> {
    if (!this.config.skillAware) return []
    const registry = this.ctx.get('skills')
    if (registry === undefined) {
      fail('PROMPT_OPTIMIZER_NO_SKILLS', 'prompt-optimizer: skillAware is enabled but no skill registry is composed; mount @deepseek-ai/dsh-skill or set skillAware: false')
    }
    const cwd = session === undefined ? undefined : this.ctx.get('workingDirectory')?.get(session)
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
    if (request.precedent !== undefined) {
      if (request.kind !== 'adopted') {
        fail('PROMPT_OPTIMIZER_BAD_METRIC_PRECEDENT', 'prompt-optimizer: only an adopted report may carry precedent materials')
      }
      if (request.precedent.draft.trim() === '' || request.precedent.optimizedText.trim() === '') {
        fail('PROMPT_OPTIMIZER_BAD_METRIC_PRECEDENT', 'prompt-optimizer: precedent materials need non-empty draft and optimized text')
      }
    }
    if (this.config.metrics) {
      await this.appendMetric(request.kind, request.provider, request.model, request.tier ?? 'standard', 1)
    }
    if (request.precedent !== undefined && this.config.precedents) {
      const judged = request.precedent.judgeTotal
      await this.recordPrecedent(
        request.precedent.draft,
        request.precedent.optimizedText,
        judged !== undefined && judged >= 0 && judged <= 30 ? judged : undefined,
      )
    }
    signal.throwIfAborted()
  }

  /** Precedent domain handle, opened once on first use. */
  private precedents: Promise<Domain<typeof precedentsDomainSpec>> | undefined

  /**
   * Open the precedents domain once, failing loudly when the deployment
   * composed no storage-domain service.
   * @returns the opened domain shared by every precedent read and write.
   */
  private openPrecedents(): Promise<Domain<typeof precedentsDomainSpec>> {
    const domains = this.ctx.get('storageDomain')
    if (domains === undefined) {
      fail('PROMPT_OPTIMIZER_NO_LIBRARY', 'prompt-optimizer: no storage-domain service is composed; add dsh-storage-domain to persist precedents')
    }
    this.precedents ??= domains.open(precedentsDomainSpec)
    return this.precedents
  }

  /**
   * Record one adopted result as a same-domain precedent, keeping only the
   * {@link PRECEDENTS_PER_DOMAIN} best-ranked rows per domain (judge total
   * first, recency second) and the global row cap. Best-effort: a storage
   * failure degrades to a warning and never fails the report.
   * @param draft - complete draft text the adopted round optimized.
   * @param optimizedText - complete adopted optimized text.
   * @param judgeTotal - judge total (0–30) when the adopted candidate was judged.
   */
  private async recordPrecedent(draft: string, optimizedText: string, judgeTotal: number | undefined): Promise<void> {
    try {
      const table = (await this.openPrecedents()).table('precedents')
      const id = randomUUID()
      const row: PrecedentRow = { id, createdAt: new Date().toISOString(), domain: this.domainKeyOf(draft), text: optimizedText, ...(judgeTotal !== undefined ? { judgeTotal } : {}) }
      await table.put(id, row)
      const rank = (entry: PrecedentRow): number => (entry.judgeTotal ?? -1) * 1e13 + Date.parse(entry.createdAt)
      const all = [...table.entries()].map(([, entry]) => entry)
      for (const domain of new Set(all.map(entry => entry.domain))) {
        const ranked = all.filter(entry => entry.domain === domain).sort((left, right) => rank(right) - rank(left))
        for (const dropped of ranked.slice(PRECEDENTS_PER_DOMAIN)) {
          await table.delete(dropped.id)
        }
      }
      const remaining = [...table.entries()].map(([, entry]) => entry).sort((left, right) => rank(right) - rank(left))
      for (const dropped of remaining.slice(PRECEDENTS_MAX_ROWS)) {
        await table.delete(dropped.id)
      }
    } catch (error) {
      this.ctx.logger.warn(`prompt optimizer: recording a precedent failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Look up the best same-domain precedent: highest judge total first, most
   * recent second. Best-effort: a storage failure yields no precedent.
   * @param domain - domain bucket the round's draft falls under.
   * @returns the precedent text, or undefined when the domain holds none.
   */
  private async lookupPrecedent(domain: string): Promise<string | undefined> {
    try {
      const table = (await this.openPrecedents()).table('precedents')
      const best = [...table.entries()]
        .map(([, entry]) => entry)
        .filter(entry => entry.domain === domain)
        .sort((left, right) => (right.judgeTotal ?? -1) - (left.judgeTotal ?? -1) || right.createdAt.localeCompare(left.createdAt))[0]
      return best === undefined ? undefined : best.text
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the precedent text one round should reference: precedents on,
   * the route not a context-starved local-small tier, and a persisted
   * same-domain precedent actually existing.
   * @param draft - complete draft text the round will optimize.
   * @param tier - capability tier of the round's route.
   * @returns the precedent text, or undefined when nothing applies.
   */
  private async roundPrecedent(draft: string, tier: ModelTier): Promise<string | undefined> {
    if (!this.config.precedents || tier === 'local-small') return undefined
    return this.lookupPrecedent(this.domainKeyOf(draft))
  }

  /** Domain bucket a draft's precedents live under; `general` when no prior matches or priors are off. */
  private domainKeyOf(draft: string): string {
    if (!this.config.domainPriors) return 'general'
    return detectDomainId(draft) ?? 'general'
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
   * and report whether this completion is a suggestion threshold. Fingerprints
   * are one-way hashes — never draft content. Best-effort by design: a storage
   * failure degrades to no suggestion and never fails the round it observes.
   * @param session - live session that owns the completed round (unused beyond shape parity).
   * @param draft - complete draft text the round optimized.
   * @returns true exactly when this completion is every {@link REPEAT_DISTILL_THRESHOLD}-th of the same normalized draft — the third fires a fresh distillation suggestion, and later multiples re-surface the suggestion (as an update once a link exists).
   */
  private async noteRepeat(session: Session, draft: string): Promise<boolean> {
    void session
    if (!this.config.metrics) return false
    try {
      const fingerprint = draftFingerprint(draft)
      const table = (await this.openRepeats()).table('repeats')
      const id = randomUUID()
      await table.put(id, { id, createdAt: new Date().toISOString(), fingerprint })
      const entries = [...table.entries()].sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
      const excess = entries.length - REPEATS_MAX_ROWS
      for (let index = 0; index < excess; index += 1) {
        await table.delete(entries[index]![0])
      }
      const count = entries.filter(([, row]) => row.fingerprint === fingerprint).length
      return count >= REPEAT_DISTILL_THRESHOLD && count % REPEAT_DISTILL_THRESHOLD === 0
    } catch (error) {
      this.ctx.logger.warn(`prompt optimizer: recording a draft fingerprint failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Resolve the repeat-driven suggestion flags for one completed round: the
   * third completion of the same normalized draft suggests distilling —
   * unless that draft already has a linked distilled skill, in which case the
   * suggestion becomes updating that skill instead.
   * @param session - live session that owns the completed round.
   * @param draft - complete draft text the round optimized.
   * @returns the suggestion flags to spread into the round's result; empty for a non-threshold round.
   */
  private async repeatSuggestions(session: Session | undefined, draft: string): Promise<{
    readonly suggestDistill?: true
    readonly suggestEvolve?: { readonly name: string }
  }> {
    if (session === undefined) return {}
    if (!(await this.noteRepeat(session, draft))) return {}
    const link = await this.lookupSkillLink(draftFingerprint(draft))
    return link === undefined ? { suggestDistill: true } : { suggestEvolve: { name: link.name } }
  }

  /** Draft-to-skill link domain handle, opened once on first use. */
  private skillLinks: Promise<Domain<typeof skillLinksDomainSpec>> | undefined

  /**
   * Open the skill-links domain once, failing loudly when the deployment
   * composed no storage-domain service.
   * @returns the opened domain shared by every link read and write.
   */
  private openSkillLinks(): Promise<Domain<typeof skillLinksDomainSpec>> {
    const domains = this.ctx.get('storageDomain')
    if (domains === undefined) {
      fail('PROMPT_OPTIMIZER_NO_LIBRARY', 'prompt-optimizer: no storage-domain service is composed; add dsh-storage-domain to persist skill links')
    }
    this.skillLinks ??= domains.open(skillLinksDomainSpec)
    return this.skillLinks
  }

  /**
   * Look up the distilled skill one draft fingerprint is linked to. Best-effort
   * by design: a storage failure yields no link and the round falls back to a
   * fresh-distillation suggestion.
   * @param fingerprint - normalized draft fingerprint.
   * @returns the linked skill's name, or undefined when no link exists.
   */
  private async lookupSkillLink(fingerprint: string): Promise<{ readonly name: string } | undefined> {
    if (!this.config.metrics) return undefined
    try {
      const table = (await this.openSkillLinks()).table('links')
      const latest = [...table.entries()]
        .map(([, row]) => row)
        .filter(row => row.fingerprint === fingerprint)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      return latest === undefined || latest.name === '' ? undefined : { name: latest.name }
    } catch {
      return undefined
    }
  }

  /**
   * Record (or replace) the link from one draft fingerprint to the distilled
   * skill a confirming write produced, pruning the oldest rows beyond the cap.
   * Best-effort: a storage failure degrades to a warning and never fails the
   * confirmed write it observes.
   * @param draft - complete draft text the round distilled.
   * @param name - kebab-case skill name the confirm wrote.
   * @param targetDir - directory the confirm wrote into.
   */
  private async recordSkillLink(draft: string, name: string, targetDir: string): Promise<void> {
    if (!this.config.metrics) return
    try {
      const table = (await this.openSkillLinks()).table('links')
      const fingerprint = draftFingerprint(draft)
      for (const [key, row] of table.entries()) {
        if (row.fingerprint === fingerprint) await table.delete(key)
      }
      const id = randomUUID()
      await table.put(id, { id, createdAt: new Date().toISOString(), fingerprint, name, targetDir })
      const entries = [...table.entries()].sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
      const excess = entries.length - SKILL_LINKS_MAX_ROWS
      for (let index = 0; index < excess; index += 1) {
        await table.delete(entries[index]![0])
      }
    } catch (error) {
      this.ctx.logger.warn(`prompt optimizer: recording a skill link failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Read one existing distilled skill's definition for an evolution round.
   * @param fs - filesystem service that resolves and reads.
   * @param targetDir - distillation target directory the skill lives under.
   * @param name - kebab-case skill name the round evolves.
   * @param signal - caller cancellation.
   * @returns the skill's name and complete definition text.
   * @throws when the name is malformed or no definition file reads.
   */
  private async loadSkillForEvolution(fs: FileSystem, targetDir: string, name: string, signal: AbortSignal): Promise<{ readonly name: string; readonly definition: string }> {
    if (!SKILL_NAME_PATTERN.test(name)) {
      fail('PROMPT_OPTIMIZER_EVOLVE_TARGET_NOT_FOUND', `prompt-optimizer: "${name}" is not a kebab-case skill name`)
    }
    let definition: string
    try {
      definition = await fs.readText(await fs.resolve(`${targetDir}/${name}/SKILL.md`, { signal }), signal)
    } catch {
      signal.throwIfAborted()
      fail('PROMPT_OPTIMIZER_EVOLVE_TARGET_NOT_FOUND', `prompt-optimizer: no distilled skill "${name}" reads under ${targetDir}`)
    }
    if (definition.trim() === '') {
      fail('PROMPT_OPTIMIZER_EVOLVE_TARGET_NOT_FOUND', `prompt-optimizer: the distilled skill "${name}" is empty`)
    }
    return { name, definition }
  }

  /** System-prompt track domain handle, opened once on first use. */
  private systemTracks: Promise<Domain<typeof systemTracksDomainSpec>> | undefined

  /**
   * Open the system-track domain once, failing loudly when the deployment
   * composed no storage-domain service.
   * @returns the opened domain shared by every track read and write.
   */
  private openSystemTracks(): Promise<Domain<typeof systemTracksDomainSpec>> {
    const domains = this.ctx.get('storageDomain')
    if (domains === undefined) {
      fail('PROMPT_OPTIMIZER_NO_LIBRARY', 'prompt-optimizer: no storage-domain service is composed; add dsh-storage-domain to persist system-prompt tracks')
    }
    this.systemTracks ??= domains.open(systemTracksDomainSpec)
    return this.systemTracks
  }

  /**
   * Record the route one system-target round tuned the Session's standing
   * system prompt on — the latest row per session, older rows for the session
   * replaced. Best-effort: a storage failure never fails the round.
   * @param session - live session whose system prompt was tuned.
   * @param route - exact route the tuning round ran on.
   * @param tier - capability tier of that route.
   */
  private async recordSystemTrack(session: Session | undefined, route: { readonly provider: string; readonly model: string }, tier: ModelTier): Promise<void> {
    if (!this.config.metrics || session === undefined) return
    try {
      const table = (await this.openSystemTracks()).table('tracks')
      const tracked = [...table.entries()]
      for (const [key, row] of tracked) {
        if (row.sessionId === session.id) await table.delete(key)
      }
      const id = randomUUID()
      await table.put(id, {
        id,
        sessionId: session.id,
        provider: route.provider,
        model: route.model,
        tier,
        createdAt: new Date().toISOString(),
      })
      const entries = [...table.entries()].sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
      const excess = entries.length - TRACKS_MAX_ROWS
      for (let index = 0; index < excess; index += 1) {
        await table.delete(entries[index]![0])
      }
    } catch (error) {
      this.ctx.logger.warn(`prompt optimizer: recording a system-prompt track failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Compare the Session's latest system-prompt track against the current
   * route; a different provider or model means the standing system prompt was
   * tuned for a model the session no longer runs, and the result should carry
   * the staleness notice. Best-effort: a storage failure yields no notice.
   * @param session - live session whose track is compared.
   * @param route - route the current round resolved.
   * @returns the notice object to spread into the round's result.
   */
  private async systemPromptStaleness(session: Session | undefined, route: { readonly provider: string; readonly model: string }): Promise<{
    readonly systemPromptStale?: { readonly from: string; readonly to: string }
  }> {
    if (!this.config.metrics || session === undefined) return {}
    try {
      const table = (await this.openSystemTracks()).table('tracks')
      const latest = [...table.entries()]
        .map(([, row]) => row)
        .filter(row => row.sessionId === session.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      if (latest === undefined || (latest.provider === route.provider && latest.model === route.model)) return {}
      return { systemPromptStale: { from: `${latest.provider}/${latest.model}`, to: `${route.provider}/${route.model}` } }
    } catch {
      return {}
    }
  }

  /** Distillations pending a confirming call, keyed by session id; the flag marks an evolution preview. */
  private readonly pendingDistills = new Map<string, { definition: string; evolved: boolean }>()

  /**
   * Resolve the directory the confirm phase writes `<name>/SKILL.md` into: the
   * configured `distillDir`, else the session project's `.dsh/skills` — a root
   * the harness skill registry lists for that project, so the distilled skill
   * joins the agent's skill catalog immediately.
   * @param session - live session owning the working-directory fallback.
   * @returns the absolute target directory.
   * @throws when neither a configured directory nor a session working directory exists.
   */
  private distillTargetDir(session: Session | undefined): string {
    if (this.config.distillDir !== undefined) {
      return this.config.distillDir
    }
    const cwd = session === undefined ? undefined : this.ctx.get('workingDirectory')?.get(session)
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
    const scanned = await this.scanContext(session, request.sessionId, signal)
    return {
      ...(scanned.systemPrompt !== undefined ? { systemPrompt: scanned.systemPrompt } : {}),
      skills: scanned.skills,
      findings: scanned.findings,
    }
  }

  /**
   * One full context scan in its richer internal shape: the wire sizing the
   * checkup returns, plus the assembled section texts and the scanned skill
   * bodies with their directories, which the repair flow needs to compute and
   * apply fixes.
   * @param session - live session whose scoped context is scanned.
   * @param sessionId - id of the session, for the agent scope lookup.
   * @param signal - caller cancellation.
   * @returns section texts, scanned skill bodies with directories, sizing, and findings.
   */
  private async scanContext(session: Session, sessionId: SessionId, signal: AbortSignal): Promise<{
    readonly sections: readonly { readonly name: string; readonly text: string }[]
    readonly systemPrompt: PromptContextCheckResult['systemPrompt']
    readonly scannedSkills: readonly { readonly name: string; readonly body: string; readonly base: string | undefined }[]
    readonly skills: PromptContextCheckResult['skills']
    readonly findings: readonly PromptContextFinding[]
  }> {
    const cwd = this.ctx.get('workingDirectory')?.get(session)
    const systemPrompt = this.ctx.get('systemPrompt')
    // The agent is the scope key its sections registered under; without one the scan degrades to the global layer.
    const agent = this.ctx.get('agents')?.get(sessionId)
    let sections: { name: string; text: string }[] = []
    let systemPromptStat: PromptContextCheckResult['systemPrompt']
    let sectionFindings: ReturnType<typeof analyzeSections>['findings'] = []
    if (systemPrompt !== undefined) {
      const assembly = await systemPrompt.assemble({ ...(agent !== undefined ? { scope: agent } : {}), signal })
      sections = assembly.sections.map(section => ({ name: section.name, text: section.text }))
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
    let scanned: { name: string; body: string; base: string | undefined }[] = []
    if (registry !== undefined) {
      const summaries = await registry.list({ ...(cwd !== undefined ? { cwd } : {}), signal })
      const invocable = summaries.filter(summary => summary.invocation.modelInvocable)
      scanned = []
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
      sections,
      systemPrompt: systemPromptStat,
      scannedSkills: scanned,
      skills,
      findings: [...sectionFindings, ...skillFindings],
    }
  }

  /** Repairs pending a confirming call, keyed by session id. */
  private readonly pendingContextFixes = new Map<string, PendingContextFix>()

  /**
   * Propose (or, with `confirm`, apply) one repair for a fixable context-doctor
   * finding, in two phases mirroring {@link PromptOptimizer.distillSkill}. A
   * preview call re-scans, verifies the finding still exists, and computes the
   * proposal — deterministically for stale references, over one model round
   * for duplicate merges; a confirming call runs no model round, backs every
   * file it touches up to `.bak` (which the registry never lists), writes the
   * repair, and returns a fresh scan. Skill repairs are writable only inside
   * the distillation target directory — packaged skill trees are read-only,
   * like the bundled role library — and system-prompt sections have no write
   * API at all, so both degrade to advisory copy-only proposals.
   * @param request - session, the finding's kind/subject/detail, and the phase selector.
   * @param signal - caller cancellation.
   * @returns the proposal on previews; the written repair plus fresh findings on confirms.
   * @throws when the session is gone, the finding no longer scans, no storage
   * backs the pending repair, a merge round fails validation, or a write fails.
   */
  async contextFix(request: PromptContextFixRequest, signal: AbortSignal): Promise<PromptContextFixResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      fail('PROMPT_OPTIMIZER_SESSION_UNAVAILABLE', 'prompt-optimizer: no live session backs this draft yet; send one message first')
    }
    if (!CONTEXT_FIX_KINDS.includes(request.kind)) {
      fail('PROMPT_OPTIMIZER_BAD_CONTEXT_FIX_KIND', `prompt-optimizer: "${request.kind}" is not a fixable finding kind; expected one of ${CONTEXT_FIX_KINDS.join(', ')}`)
    }
    if (request.subject.trim() === '' || request.detail.trim() === '') {
      fail('PROMPT_OPTIMIZER_BAD_CONTEXT_FIX_TARGET', 'prompt-optimizer: a repair needs the finding\'s non-empty subject and detail')
    }

    if (request.confirm === true) {
      const pending = this.pendingContextFixes.get(request.sessionId)
      if (pending === undefined || pending.kind !== request.kind || pending.subject !== request.subject || pending.detail !== request.detail) {
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_NOT_PENDING', 'prompt-optimizer: confirm requires a preceding preview of this finding for this session')
      }
      const fs = this.ctx.get('fs')
      if (fs === undefined || pending.targetFile === undefined) {
        fail('PROMPT_OPTIMIZER_NO_FS', 'prompt-optimizer: no filesystem service is composed; add a dsh-fs implementation to write repairs')
      }
      try {
        await this.writeWithBackup(fs, pending.targetFile, pending.proposal, signal)
        if (pending.retire !== undefined) {
          await this.writeWithBackup(fs, pending.retire.file, retiredSkillDefinition(pending.retire.retiredName, pending.retire.mergeInto), signal)
        }
      } catch (error) {
        signal.throwIfAborted()
        if (isTypedFailure(error)) throw error
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FAILED', `prompt-optimizer: writing the repair failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.pendingContextFixes.delete(request.sessionId)
      appendPluginRecord(session, 'plugin:prompt-optimizer/context-fixed', {
        kind: pending.kind,
        subject: pending.subject,
        bytes: Buffer.byteLength(pending.proposal, 'utf8'),
      })
      const rescanned = await this.scanContext(session, request.sessionId, signal)
      return {
        kind: pending.kind,
        subject: pending.subject,
        advisory: false,
        proposal: pending.proposal,
        targetFile: pending.targetFile,
        findings: rescanned.findings,
      }
    }

    // Preview: the repair can only target a finding a fresh scan still reports.
    const scanned = await this.scanContext(session, request.sessionId, signal)
    const finding = scanned.findings.find(entry => entry.kind === request.kind && entry.subject === request.subject && entry.detail === request.detail)
    if (finding === undefined) {
      fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FINDING_GONE', 'prompt-optimizer: a fresh scan no longer reports this finding; rescan the context and pick a current finding')
    }

    if (request.kind === 'stale-skill-reference') {
      const reference = referenceOfDetail(request.detail)
      const skill = scanned.scannedSkills.find(entry => entry.name === request.subject)
      if (skill === undefined) {
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FINDING_GONE', 'prompt-optimizer: a fresh scan no longer reports this finding; rescan the context and pick a current finding')
      }
      const proposal = stripReference(skill.body, reference)
      const fs = this.ctx.get('fs')
      let replacement: string | undefined
      if (fs !== undefined && skill.base !== undefined) {
        try {
          const listed = await fs.listDir(await fs.resolve(skill.base, { signal }), signal)
          replacement = nearestExistingFile(reference, listed.filter(entry => entry.type === 'file').map(entry => entry.name))
        } catch {
          signal.throwIfAborted()
        }
      }
      const targetFile = this.writableSkillFile(session, skill.base)
      const spread: { replacement?: string; targetFile?: string } = {}
      if (replacement !== undefined) spread.replacement = replacement
      if (targetFile !== undefined) {
        spread.targetFile = targetFile
        this.pendingContextFixes.set(request.sessionId, {
          kind: request.kind, subject: request.subject, detail: request.detail, proposal, targetFile, retire: undefined,
        })
      }
      return { kind: request.kind, subject: request.subject, advisory: targetFile === undefined, proposal, ...spread }
    }

    if (request.kind === 'duplicate-skill') {
      const { left, right } = splitPairSubject(request.subject)
      const leftSkill = scanned.scannedSkills.find(entry => entry.name === left)
      const rightSkill = scanned.scannedSkills.find(entry => entry.name === right)
      if (leftSkill === undefined || rightSkill === undefined) {
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FINDING_GONE', 'prompt-optimizer: a fresh scan no longer reports this finding; rescan the context and pick a current finding')
      }
      const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
      const tier = classifyModelTier(route.provider, route.model)
      let merged: string
      try {
        merged = plainMergeText(await this.streamRaw(session, {
          route,
          system: skillMergeSystemPrompt(),
          input: skillMergeUserInput(leftSkill.body, rightSkill.body),
          sessionId: request.sessionId,
          tier,
        }, signal))
      } catch (error) {
        signal.throwIfAborted()
        if (isTypedFailure(error)) throw error
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FAILED', `prompt-optimizer: merging the duplicate skills failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      let canonical: string
      try {
        canonical = canonicalSkillName(parseSkillDefinition(merged).definition, left)
      } catch (error) {
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_INVALID', `prompt-optimizer: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (canonical.length > SKILL_MAX_CHARS) {
        fail('PROMPT_OPTIMIZER_CONTEXT_FIX_INVALID', `prompt-optimizer: the merged skill definition exceeds the ${String(SKILL_MAX_CHARS)}-character cap`)
      }
      const leftTarget = this.writableSkillFile(session, leftSkill.base)
      const rightTarget = this.writableSkillFile(session, rightSkill.base)
      if (leftTarget === undefined || rightTarget === undefined) {
        return { kind: request.kind, subject: request.subject, advisory: true, proposal: canonical }
      }
      this.pendingContextFixes.set(request.sessionId, {
        kind: request.kind, subject: request.subject, detail: request.detail, proposal: canonical, targetFile: leftTarget,
        retire: { file: rightTarget, retiredName: right, mergeInto: left },
      })
      return { kind: request.kind, subject: request.subject, advisory: false, proposal: canonical, targetFile: leftTarget }
    }

    // duplicate-section: advisory only — the assembled system prompt has no write-back API.
    const { left, right } = splitPairSubject(request.subject)
    const leftSection = scanned.sections.find(section => section.name === left)
    const rightSection = scanned.sections.find(section => section.name === right)
    if (leftSection === undefined || rightSection === undefined) {
      fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FINDING_GONE', 'prompt-optimizer: a fresh scan no longer reports this finding; rescan the context and pick a current finding')
    }
    const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
    let merged: string
    try {
      merged = plainMergeText(await this.streamRaw(session, {
        route,
        system: sectionMergeSystemPrompt(),
        input: sectionMergeUserInput(left, leftSection.text, right, rightSection.text),
        sessionId: request.sessionId,
        tier: classifyModelTier(route.provider, route.model),
      }, signal))
    } catch (error) {
      signal.throwIfAborted()
      if (isTypedFailure(error)) throw error
      fail('PROMPT_OPTIMIZER_CONTEXT_FIX_FAILED', `prompt-optimizer: merging the duplicate sections failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (merged === '') {
      fail('PROMPT_OPTIMIZER_CONTEXT_FIX_INVALID', 'prompt-optimizer: the merged section came back empty')
    }
    return { kind: request.kind, subject: request.subject, advisory: true, proposal: merged }
  }

  /**
   * Write one file with a `.bak` backup of its current content — the registry
   * never lists `.bak` files, so the backup leaves every catalog while the
   * original stays recoverable.
   * @param fs - filesystem service that resolves and writes.
   * @param path - file path (unresolved) to rewrite.
   * @param contents - full new contents.
   * @param signal - caller cancellation.
   */
  private async writeWithBackup(fs: FileSystem, path: string, contents: string, signal: AbortSignal): Promise<void> {
    const target = await fs.resolve(path, { signal })
    const existing = await fs.readText(target, signal).catch(() => undefined)
    if (existing !== undefined) {
      await fs.writeText(await fs.resolve(`${path}.bak`, { signal }), existing, undefined, signal)
    }
    await fs.writeText(target, contents, undefined, signal)
  }

  /**
   * Resolve the `SKILL.md` a repair may write, or undefined when the skill is
   * not writable: repairs touch only skills inside the distillation target
   * directory; packaged skill trees stay read-only, like the bundled roles.
   * @param session - live session owning the working-directory fallback.
   * @param base - the skill's own directory, when the registry reported one.
   * @returns the writable `SKILL.md` path, or undefined for an advisory repair.
   */
  private writableSkillFile(session: Session, base: string | undefined): string | undefined {
    if (base === undefined || this.ctx.get('fs') === undefined) return undefined
    let root: string
    try {
      root = this.distillTargetDir(session)
    } catch {
      return undefined
    }
    return isWithin(base, root) ? `${base}/SKILL.md` : undefined
  }

  /**
   * Dispatch one model round whose output is raw text rather than the
   * optimization envelope, logging the request exactly like every other
   * round. The repair merges share it.
   * @param session - live Session that owns the request log.
   * @param options - route, system prompt, user input, session id, and tier.
   * @param signal - caller cancellation.
   * @returns the complete trimmed response text.
   * @throws on deadline, cancellation, a missing adapter, or an operational
   * stream failure.
   */
  private async streamRaw(session: Session, options: {
    readonly route: { readonly provider: string; readonly model: string }
    readonly system: string
    readonly input: string
    readonly sessionId: SessionId
    readonly tier: ModelTier
  }, signal: AbortSignal): Promise<string> {
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
      inputBytes: Buffer.byteLength(options.input, 'utf8'),
      previousAttempts: 0,
      target: 'draft',
      round: 1,
      skillsHinted: 0,
      tier: options.tier,
    })
    callDeadline.signal.throwIfAborted()
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream(llmOptions)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    terminalFinish(assembler.finish)
    return responseText(assembler.blocks()).trim()
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
   * @throws the texts fail bounds, no target directory resolves, the model round fails, or the produced definition fails validation.
   */
  async distillSkill(request: PromptDistillRequest, signal: AbortSignal): Promise<PromptDistillResult> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(request.sessionId)
    if (request.draft.trim() === '' || request.optimized.trim() === '') {
      fail('PROMPT_OPTIMIZER_EMPTY_TEXT', 'prompt-optimizer: a distillation needs the round\'s non-empty draft and optimized text')
    }
    const clarifications = normalizeClarifications(request.clarifications, this.config.maxInputBytes)
    const targetDir = this.distillTargetDir(session)
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      fail('PROMPT_OPTIMIZER_NO_FS', 'prompt-optimizer: no filesystem service is composed; add a dsh-fs implementation to write distilled skills')
    }
    let evolving: { readonly name: string; readonly definition: string } | undefined
    let evolvedConfirm: boolean | undefined
    let definition: string
    if (request.confirm === true) {
      const pending = this.pendingDistills.get(request.sessionId) ?? fail('PROMPT_OPTIMIZER_DISTILL_NOT_PENDING', 'prompt-optimizer: confirm requires a preceding preview for this session')
      definition = pending.definition
      evolvedConfirm = pending.evolved
    } else {
      if (request.evolveOf !== undefined) {
        evolving = await this.loadSkillForEvolution(fs, targetDir, request.evolveOf, signal)
      }
      const route = resolveRoute(this.ctx, this.config, session, defaultModelRoute(this.ctx))
      const messages: Message[] = [createUserMessage({
        content: [{ type: 'text', text: evolving === undefined
          ? distillationUserInput(request.draft, request.optimized, clarifications)
          : skillEvolutionUserInput(evolving.definition, request.draft, request.optimized, clarifications) }],
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
          system: evolving === undefined ? distillationSystemPrompt() : skillEvolutionSystemPrompt(),
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
    if (evolving !== undefined) {
      definition = canonicalSkillName(definition, evolving.name)
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
      this.pendingDistills.set(request.sessionId, { definition, evolved: evolving !== undefined })
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
    await this.recordMetric(evolvedConfirm === true ? 'evolved' : 'distilled', { provider: '', model: '' }, 'standard', 1)
    await this.recordSkillLink(request.draft, parsed.name, targetDir)
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
      evolutions: rowsOf('evolved'),
      evalRuns: rowsOf('eval-run'),
      evalWins: sumOf('eval-win'),
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
