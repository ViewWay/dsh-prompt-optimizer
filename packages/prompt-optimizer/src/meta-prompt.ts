/**
 * Meta-prompt construction and response parsing for one optimization round.
 * The protocol between this module and the model is the three-marker envelope
 * defined by {@link OPTIMIZED_MARKER}, {@link CHANGES_MARKER}, and
 * {@link AC_MARKER}; domain priors condition the system prompt on the draft's
 * technical domain, distilling the role-library idea of the FlowPilot project
 * navigation workflow into per-domain question lists.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import type { SkillHint } from './skills.ts'

/** Starts the rewritten-prompt section of the model response. */
export const OPTIMIZED_MARKER = '<<<OPTIMIZED_PROMPT>>>'
/** Starts the change-account section of the model response. */
export const CHANGES_MARKER = '<<<CHANGES>>>'
/** Starts the acceptance-criterion section of the model response. */
export const AC_MARKER = '<<<AC>>>'

/** Upper bound on change bullets kept from one response. */
const MAX_CHANGES = 6
/** Upper bound on acceptance criteria kept from one response. */
const MAX_ACCEPTANCE = 4
/** Upper bound on domains whose guidance joins one system prompt. */
const MAX_PRIOR_DOMAINS = 2

/** One domain prior: bilingual match keywords plus the guidance to surface. */
interface DomainPrior {
  /** Stable domain identity, for tests and diagnostics. */
  readonly id: string
  /** Case-insensitive substrings that vote for this domain. */
  readonly keywords: readonly string[]
  /** Guidance lines appended to the system prompt when this domain matches. */
  readonly guidance: readonly string[]
}

/**
 * Domain priors distilled from a role library: each block names the questions
 * a domain-aware specialist would surface that a generic rewriter would not.
 */
const DOMAIN_PRIORS: readonly DomainPrior[] = [
  {
    id: 'embedded',
    keywords: ['嵌入式', '单片机', '寄存器', '中断', '固件', '外设', '串口', '板子', '硬件',
      'mcu', 'register', 'interrupt', 'firmware', 'peripheral', 'uart', 'i2c', 'spi', 'gpio', 'pcb', 'schematic'],
    guidance: [
      'Ask for the exact chip or module model, board revision, and toolchain when unstated.',
      'Ask whether the target is bare-metal or runs an RTOS, and which datasheet or reference manual governs.',
      'Surface timing, voltage-level, and bus-speed constraints; a wrong assumption here bricks hardware.',
      'Ask how the result will be flashed or probed (debugger, bootloader, logs over UART) and how the user observes success.',
    ],
  },
  {
    id: 'systems',
    keywords: ['内核', '编译', '链接', '启动', '内存管理', '构建系统', '性能剖析', '运行时',
      'kernel', 'compiler', 'linker', 'boot', 'allocator', 'runtime', 'profiling', 'toolchain', 'syscall', 'driver'],
    guidance: [
      'Ask for the exact OS/distribution or runtime version and architecture the work targets.',
      'Surface reproduction steps and a way to measure before and after (benchmark, trace, counter) when performance is implied.',
      'Ask whether a behavior change must stay compatible with existing callers or configs.',
      'Prefer asking for the failing observation (log, panic, metric) over letting the task guess at root cause.',
    ],
  },
  {
    id: 'frontend',
    keywords: ['前端', '页面', '组件', '样式', '交互', '弹窗',
      'frontend', 'ui', 'component', 'css', 'layout', 'button', 'form', 'responsive', 'react', 'vue', 'svelte'],
    guidance: [
      'Ask which framework and version the project uses when unstated, and whether a design mockup or spec exists.',
      'Surface state, accessibility, and keyboard-interaction expectations for interactive elements.',
      'Ask how the change behaves across viewport sizes and themes when the draft implies responsive UI.',
      'Ask for the observable definition of done: which screen, which action, which visible result.',
    ],
  },
  {
    id: 'backend',
    keywords: ['接口', '服务端', '数据库', '鉴权', '并发', '队列', '缓存', '部署',
      'api', 'backend', 'server', 'database', 'sql', 'auth', 'queue', 'cache', 'deploy', 'endpoint', 'migration', 'concurrency'],
    guidance: [
      'Ask for the runtime, framework, and datastore versions the service builds on.',
      'Surface the API contract: method, path, request and response shapes, and error cases worth handling.',
      'Ask about data migrations, idempotency, and what happens to in-flight requests during the change.',
      'Ask how correctness will be checked: a curl/repro command, a test, or an observable log line.',
    ],
  },
  {
    id: 'data-ml',
    keywords: ['训练', '推理', '模型', '数据集', '特征', '精度',
      'train', 'inference', 'model', 'dataset', 'feature', 'accuracy', 'pytorch', 'transformers', 'embedding', 'fine-tune'],
    guidance: [
      'Ask for the data location, scale, and schema before any pipeline work.',
      'Surface the metric that defines success and the baseline it must beat, with numbers when available.',
      'Ask for the compute environment (GPUs, memory limits) and seed or reproducibility expectations.',
      'Ask whether evaluation is a held-out split, a runnable script, or a human judgment, and make that explicit.',
    ],
  },
]

/**
 * Detect the draft's technical domains and collect their guidance lines,
 * highest keyword-hit domain first, at most {@link MAX_PRIOR_DOMAINS} domains.
 * Deterministic: the same draft text always yields the same lines.
 * @param text - complete draft text to classify.
 * @returns guidance lines to append to the system prompt; empty for a generic draft.
 */
export function detectDomainPriors(text: string): readonly string[] {
  const haystack = text.toLowerCase()
  const matched = DOMAIN_PRIORS
    .map(prior => ({ prior, hits: prior.keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0) }))
    .filter(entry => entry.hits > 0)
    .sort((left, right) => right.hits - left.hits || left.prior.id.localeCompare(right.prior.id))
    .slice(0, MAX_PRIOR_DOMAINS)
  return matched.flatMap(entry => entry.prior.guidance)
}

/** Response-envelope contract every optimizer round states verbatim. */
const ENVELOPE_LINES: readonly string[] = [
  '',
  'Respond with exactly this format and nothing else:',
  OPTIMIZED_MARKER,
  '(the rewritten prompt)',
  CHANGES_MARKER,
  '- (change 1)',
  '- (change 2)',
  AC_MARKER,
  '- (acceptance criterion, with a `check command` in backticks when one exists)',
]

/** Domain-guidance block appended to a system prompt when priors matched. */
function priorBlock(domainPriors: readonly string[]): readonly string[] {
  return domainPriors.length === 0
    ? []
    : ['', 'Domain guidance for this draft (surface as questions or constraints exactly where the draft lacks them):',
      ...domainPriors.map(line => `- ${line}`)]
}

/** One loaded professional role conditioning an optimization round. */
export interface PromptRoleRef {
  /** Role slug matching the configured roles directory file. */
  readonly id: string
  /** Human-facing role name parsed from the definition's first heading. */
  readonly name: string
  /** Complete role definition text, verbatim. */
  readonly text: string
}

/**
 * Conditioners one optimization system prompt carries. Every field is
 * optional; an empty conditioning produces the plain generic rewrite prompt.
 */
export interface RoundConditioning {
  /** Guidance lines from {@link detectDomainPriors}; empty for a generic draft. */
  readonly domainPriors?: readonly string[]
  /** Loaded role styling the round; absent for a generic rewrite. */
  readonly role?: PromptRoleRef
  /** Selected installed-skill hints; absent when none matched the draft. */
  readonly skills?: readonly SkillHint[]
  /**
   * Self-describing language name the rewrite must be written in (for example
   * `中文`); absent keeps the draft's language.
   */
  readonly language?: string
}

/** Role block appended to a system prompt when a role conditions the round. */
function roleBlock(role: PromptRoleRef, instruction: string): readonly string[] {
  return [
    '',
    `Professional role for this round: ${role.name} (${role.id}). ${instruction}`,
    'Treat the definition below as the only authority on the role; never invent role facts beyond it.',
    '--- role definition start ---',
    role.text,
    '--- role definition end ---',
  ]
}

/** Draft-role instruction: frame the task for the specialist. */
const DRAFT_ROLE_INSTRUCTION = 'Rewrite the draft as a task addressed to this specialist: '
  + "adopt the role's vocabulary, fold its working method and output format into the task's constraints "
  + 'and expected output, and keep its hard limits as constraints the response must respect.'

/** System-role instruction: turn the standing instructions into the specialist. */
const SYSTEM_ROLE_INSTRUCTION = 'Rewrite the draft into the standing instructions that turn the agent into '
  + "this specialist: follow the role definition's structure, scope, and hard limits so every future turn "
  + 'behaves as the role.'

/** Skill-hint block appended to a system prompt when skills matched the draft. */
function skillBlock(skills: readonly SkillHint[]): readonly string[] {
  if (skills.length === 0) return []
  return [
    '',
    'Installed skills for this agent that match the draft (name — description):',
    'Reference a listed skill only by its exact name and only when it clearly serves the task; never invent, rename, or guess skill names. When none applies, mention no skill.',
    ...skills.map(hint => `- ${hint.name} — ${hint.description}`),
  ]
}

/**
 * Rule 1 for one round: pin the output language when the request named one,
 * else keep the draft's language.
 * @param language - self-describing language name, or undefined.
 * @returns the exact rule-1 line for the system prompt.
 */
function languageRule(language: string | undefined): string {
  return language === undefined
    ? '1. Keep the draft\'s language. A Chinese draft stays Chinese; an English draft stays English.'
    : `1. Write the rewrite in ${language}. Keep code identifiers, file paths, commands, and quoted text unchanged.`
}

/**
 * Phrase naming the language change bullets and acceptance criteria are
 * written in.
 * @param language - self-describing language name, or undefined.
 * @returns `the draft's language` or the requested language name.
 */
function writtenIn(language: string | undefined): string {
  return language === undefined ? 'the draft\'s language' : language
}

/**
 * The optimizer system prompt: rewrite, never answer, never invent, and
 * condition on the draft's domain, an optional role, optional installed-skill
 * hints, and an optional output language.
 * @param conditioning - round conditioners; defaults produce the generic prompt.
 * @returns exact system prompt text for every optimization round.
 */
export function optimizerSystemPrompt(conditioning: RoundConditioning = {}): string {
  const { domainPriors = [], role, skills = [], language } = conditioning
  return [
    'You are a prompt optimization specialist. The user gives you a draft prompt they intend to send to a coding agent. Rewrite the draft into a clear, well-structured prompt.',
    '',
    'Rules:',
    languageRule(language),
    '2. Never answer the prompt and never start performing the task. Only rewrite it.',
    '3. Never invent facts, file paths, versions, error text, or requirements the draft does not state or trivially imply.',
    '4. Preserve every concrete detail the user supplied.',
    '5. State the goal explicitly and early; separate context, task, constraints, and expected output when the draft benefits from structure.',
    '6. Add only clearly implied missing elements, such as verification steps for a change request or an explicit completion condition.',
    '7. Keep the rewrite as short as the task allows; no filler or boilerplate.',
    `8. List each meaningful change as one short bullet in ${writtenIn(language)}, at most ${String(MAX_CHANGES)} bullets.`,
    `9. End with ${String(MAX_ACCEPTANCE)} or fewer acceptance criteria: one-line, verifiable conditions the finished task must satisfy, in ${writtenIn(language)}. `
      + 'Append a runnable check command in backticks when one exists; otherwise state the judgment point. Never invent success thresholds.',
    ...priorBlock(domainPriors),
    ...(role === undefined ? [] : roleBlock(role, DRAFT_ROLE_INSTRUCTION)),
    ...skillBlock(skills),
    ...ENVELOPE_LINES,
  ].join('\n')
}

/**
 * The optimizer system prompt for a standing SYSTEM prompt target: the draft
 * governs a coding agent across a whole session, so the rewrite must produce
 * timeless, self-contained, checkable standing instructions instead of a
 * one-shot task message.
 * @param conditioning - round conditioners; defaults produce the generic prompt.
 * @returns exact system prompt text for a system-target rewrite round.
 */
export function optimizerSystemPromptForSystem(conditioning: RoundConditioning = {}): string {
  const { domainPriors = [], role, skills = [], language } = conditioning
  return [
    'You are a prompt optimization specialist. The user gives you a draft SYSTEM prompt: the standing instruction block that governs a coding agent across a whole session, not a single chat message. Rewrite the draft into a clear, well-structured system prompt.',
    '',
    'Rules:',
    languageRule(language),
    '2. Never answer any task the draft mentions and never start performing it. Only rewrite the standing instructions.',
    '3. Never invent facts, tool names, policies, or requirements the draft does not state or trivially imply.',
    '4. Preserve every concrete detail the user supplied.',
    '5. Express a stable role in short scannable sections: identity and mission, scope of responsibility, standing behavior rules, output and interaction conventions, and hard guardrails.',
    '6. Every rule must be timeless and self-contained: phrased so it holds for every future turn, with no reference to this draft or to one specific task. Anything that belongs to a single task belongs in user prompts instead — strip it and say so in the changes.',
    '7. Prefer checkable phrasing ("always run the tests before claiming done") over vague adjectives ("be careful", "high quality").',
    `8. List each meaningful change as one short bullet in ${writtenIn(language)}, at most ${String(MAX_CHANGES)} bullets.`,
    `9. End with ${String(MAX_ACCEPTANCE)} or fewer acceptance criteria: one-line, verifiable conditions a reader can check the rewritten SYSTEM prompt against, in ${writtenIn(language)}. `
      + 'Append a runnable check command in backticks when one exists (for example a grep over the rewritten text); otherwise state the judgment point.',
    ...priorBlock(domainPriors),
    ...(role === undefined ? [] : roleBlock(role, SYSTEM_ROLE_INSTRUCTION)),
    ...skillBlock(skills),
    ...ENVELOPE_LINES,
  ].join('\n')
}

/**
 * The critique-round system prompt for system targets: audit the first rewrite
 * against the original draft and output a complete improved revision.
 * @param conditioning - round conditioners; defaults produce the generic prompt.
 * @returns exact system prompt text for the critique round.
 */
export function critiqueSystemPrompt(conditioning: RoundConditioning = {}): string {
  const { domainPriors = [], role, skills = [], language } = conditioning
  return [
    'You are a prompt optimization specialist performing a critique round on a rewritten SYSTEM prompt. You receive the original draft and the first rewrite. Audit the rewrite, then output an improved full revision.',
    '',
    'Audit for, and fix:',
    '- ambiguity a future turn could read two ways',
    '- untestable or unverifiable rules',
    '- contradictions with facts the original draft stated',
    '- task-specific content that leaked into standing instructions',
    '- guardrails the original draft implied but the rewrite dropped',
    '',
    'Rules:',
    language === undefined ? '1. Keep the rewrite\'s language.' : `1. Write the revision in ${language}.`,
    '2. Output the COMPLETE improved system prompt, never a delta.',
    '3. Preserve every concrete fact from the original draft.',
    '4. Do not add requirements absent from both texts.',
    `5. List each revision you made as one short bullet, at most ${String(MAX_CHANGES)}; these bullets are the critique record.`,
    `6. End with ${String(MAX_ACCEPTANCE)} or fewer acceptance criteria as before.`,
    ...priorBlock(domainPriors),
    ...(role === undefined ? [] : roleBlock(role, SYSTEM_ROLE_INSTRUCTION)),
    ...skillBlock(skills),
    ...ENVELOPE_LINES,
  ].join('\n')
}

/**
 * Frame one draft (and optional rejected earlier results) as the round's user input.
 * @param text - complete draft text to optimize.
 * @param previousAttempts - rejected optimized texts, oldest first.
 * @returns exact user input for the round.
 */
export function optimizerUserInput(text: string, previousAttempts: readonly string[]): string {
  const earlier = previousAttempts.map((attempt, index) =>
    `--- rejected result ${String(index + 1)} ---\n${attempt}`).join('\n\n')
  return [
    previousAttempts.length === 0
      ? ''
      : `The user rejected these earlier rewrites; produce a meaningfully different revision:\n\n${earlier}\n`,
    'Optimize the following draft prompt:',
    '',
    text,
  ].filter(part => part !== '').join('\n')
}

/**
 * Frame the critique round's user input: the original draft and the first
 * rewrite the critique must audit and improve.
 * @param text - complete original draft text.
 * @param rewrite - optimized text the first round produced.
 * @returns exact user input for the critique round.
 */
export function critiqueUserInput(text: string, rewrite: string): string {
  return [
    'Audit and revise this rewritten SYSTEM prompt.',
    '',
    '--- original draft ---',
    text,
    '',
    '--- first rewrite ---',
    rewrite,
    '',
    'Output the improved complete system prompt in the required format.',
  ].join('\n')
}

/** One parsed acceptance criterion: text plus how it can be verified. */
export interface ParsedAcceptanceCriterion {
  /** Criterion statement in the draft's language. */
  readonly text: string
  /** `mechanical` when a backticked check command was supplied; `llm` otherwise. */
  readonly kind: 'mechanical' | 'llm'
  /** The check command extracted from the criterion; present only for `mechanical`. */
  readonly commandTemplate?: string
}

/**
 * Parse one acceptance-criterion line: the first backtick span, when present,
 * becomes the check command and is removed from the criterion text.
 * @param line - raw criterion line without the bullet marker.
 * @returns the parsed criterion, or undefined for an empty line.
 */
function parseAcceptanceLine(line: string): ParsedAcceptanceCriterion | undefined {
  const commandStart = line.indexOf('`')
  if (commandStart === -1) {
    const text = line.trim()
    return text === '' ? undefined : { text, kind: 'llm' }
  }
  const commandEnd = line.indexOf('`', commandStart + 1)
  if (commandEnd === -1) {
    const text = line.trim()
    return text === '' ? undefined : { text, kind: 'llm' }
  }
  const command = line.slice(commandStart + 1, commandEnd)
  const text = `${line.slice(0, commandStart)}${line.slice(commandEnd + 1)}`.replace(/\s{2,}/g, ' ').trim()
  return { text, kind: 'mechanical', commandTemplate: command }
}

/**
 * Parse one model response into the optimized text, its change accounts, and
 * its acceptance criteria. A response without {@link OPTIMIZED_MARKER} is
 * treated entirely as optimized text; missing later sections carry no changes
 * and no criteria. Whitespace around every section is trimmed away.
 * @param response - complete assembled model response.
 * @returns parsed sections; `optimizedText` is empty only for an empty response.
 */
export function parseOptimizerResponse(response: string): {
  optimizedText: string
  changes: readonly string[]
  acceptance: readonly ParsedAcceptanceCriterion[]
} {
  const optimizedStart = response.indexOf(OPTIMIZED_MARKER)
  const body = optimizedStart === -1 ? response : response.slice(optimizedStart + OPTIMIZED_MARKER.length)
  const changesStart = body.indexOf(CHANGES_MARKER)
  const acceptanceStart = body.indexOf(AC_MARKER)
  const changesEnd = acceptanceStart === -1 ? body.length : acceptanceStart
  const optimizedText = (changesStart === -1 ? body.slice(0, changesEnd) : body.slice(0, changesStart)).trim()
  const changesBlock = changesStart === -1 ? '' : body.slice(changesStart + CHANGES_MARKER.length, changesEnd)
  const changes = changesBlock
    .split('\n')
    .map(line => line.trim().replace(/^[-*]\s+/, ''))
    .filter(line => line.length > 0)
    .slice(0, MAX_CHANGES)
  const acceptanceBlock = acceptanceStart === -1 ? '' : body.slice(acceptanceStart + AC_MARKER.length)
  const acceptance = acceptanceBlock
    .split('\n')
    .map(line => line.trim().replace(/^[-*]\s+/, ''))
    .map(line => parseAcceptanceLine(line))
    .filter((criterion): criterion is ParsedAcceptanceCriterion => criterion !== undefined)
    .slice(0, MAX_ACCEPTANCE)
  return { optimizedText, changes, acceptance }
}
