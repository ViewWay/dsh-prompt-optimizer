/**
 * Meta-prompt construction and response parsing for one optimization round.
 * The protocol between this module and the model is the three-marker envelope
 * defined by {@link OPTIMIZED_MARKER}, {@link CHANGES_MARKER}, and
 * {@link AC_MARKER}; domain priors condition the system prompt on the draft's
 * technical domain, distilling the role-library idea of the FlowPilot project
 * navigation workflow into per-domain question lists.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import type { ModelTier, PromptCandidateScores, PromptClarification, PromptInterviewQuestion, PromptOptimizeDirection } from './types.ts'
import type { SkillHint, SkillParameter } from './skills.ts'
import { modelTierBlock } from './model-tier.ts'

/** Starts the rewritten-prompt section of the model response. */
export const OPTIMIZED_MARKER = '<<<OPTIMIZED_PROMPT>>>'
/** Starts the change-account section of the model response. */
export const CHANGES_MARKER = '<<<CHANGES>>>'
/** Starts the acceptance-criterion section of the model response. */
export const AC_MARKER = '<<<AC>>>'
/** Starts the clarifying-questions section of an interview response. */
export const QUESTIONS_MARKER = '<<<QUESTIONS>>>'
/** Starts the scoring block of a judge response. */
export const JUDGE_MARKER = '<<<JUDGE>>>'

/** Upper bound on change bullets kept from one response. */
const MAX_CHANGES = 6
/** Upper bound on acceptance criteria kept from one response. */
const MAX_ACCEPTANCE = 4
/** Upper bound on domains whose guidance joins one system prompt. */
const MAX_PRIOR_DOMAINS = 2
/** Upper bound on clarifying questions one interview round may carry. */
const MAX_QUESTIONS = 3
/** Upper bound on candidate options one clarifying question may carry. */
const MAX_OPTIONS = 4
/** Option-line marker meaning the question expects a free-text answer. */
const FREE_TEXT_OPTION = '(free text)'

/**
 * Fixed English guidance each rewrite direction carries. Enum-keyed so a
 * request can only pick a curated steer, never inject free instructions into
 * the system prompt.
 */
const DIRECTION_GUIDANCE: Readonly<Record<PromptOptimizeDirection, string>> = {
  concise: 'concise — cut boilerplate and merge overlapping constraints; keep every hard fact and acceptance criterion, and make the rewrite as short as it can be while staying executable.',
  detailed: 'detailed — expand thin spots with the concrete sub-steps, inputs, and edge cases the draft implies; add nothing the draft cannot support.',
  technical: 'technical — use precise domain terminology and name the exact commands, versions, and formats the draft implies, so an engineer can execute without follow-up questions.',
  structured: 'structured — reorganize the rewrite into clearly labeled sections (goal, context, constraints, steps, expected output); keep the content otherwise equivalent.',
  acceptance: 'acceptance — make the ending acceptance criteria concrete and verifiable, each with a runnable check command in backticks where one plausibly exists; never invent success thresholds.',
}

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
 * Detect the draft's strongest-matching technical domain id.
 * Deterministic: the same draft text always yields the same id.
 * @param text - complete draft text to classify.
 * @returns the highest keyword-hit domain's stable id, or undefined for a generic draft.
 */
export function detectDomainId(text: string): string | undefined {
  const haystack = text.toLowerCase()
  const matched = DOMAIN_PRIORS
    .map(prior => ({ prior, hits: prior.keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0) }))
    .filter(entry => entry.hits > 0)
    .sort((left, right) => right.hits - left.hits || left.prior.id.localeCompare(right.prior.id))[0]
  return matched?.prior.id
}

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
  /**
   * Capability tier of the route the rewritten prompt will run on; absent or
   * `standard` adds no tier guidance.
   */
  readonly tier?: ModelTier
  /** Interview answers the rewrite must fold in as first-class requirements. */
  readonly clarifications?: readonly PromptClarification[]
  /** Acceptance criteria the user defined up front; the rewrite must satisfy and restate every one. */
  readonly goalCriteria?: readonly string[]
  /** Direction the rewrite should push toward; absent applies the plain rules. */
  readonly direction?: PromptOptimizeDirection
}

/** Clarification block appended to a system prompt when the user answered interview questions. */
function clarificationBlock(clarifications: readonly PromptClarification[]): readonly string[] {
  if (clarifications.length === 0) return []
  return [
    '',
    'The user already answered clarifying questions about this draft. Their answers are authoritative requirements:',
    '- Fold each answer into the rewrite at the place it belongs (constraints, inputs, success criteria), not as a Q&A appendix.',
    '- Never contradict, soften, or drop an answer; when an answer conflicts with the draft, the answer wins.',
  ]
}

/** Goal-criteria block appended to a system prompt when the user defined done up front. */
function goalCriteriaBlock(criteria: readonly string[]): readonly string[] {
  if (criteria.length === 0) return []
  return [
    '',
    'The user defined done up front. These acceptance criteria are authoritative — build the rewrite to satisfy them, and restate every one of them in the rewrite\'s own acceptance list (appending a runnable check command in backticks where one plausibly exists):',
    ...criteria.map(criterion => `- ${criterion}`),
  ]
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

/** Longest rendered `params:` segment one hint line carries. */
const PARAMS_SEGMENT_MAX_CHARS = 80

/**
 * Render one hint's parameter descriptors as a `params:` segment, clipped
 * with an explicit ellipsis marker when the whole segment exceeds
 * {@link PARAMS_SEGMENT_MAX_CHARS}.
 * @param parameters - parsed descriptors; absent or empty renders nothing.
 * @returns `params: name=description, …` or an empty string.
 */
function parameterSegment(parameters: readonly SkillParameter[] | undefined): string {
  if (parameters === undefined || parameters.length === 0) return ''
  const segment = `params: ${parameters.map(parameter => `${parameter.name}=${parameter.description}`).join(', ')}`
  return segment.length <= PARAMS_SEGMENT_MAX_CHARS
    ? segment
    : `${segment.slice(0, PARAMS_SEGMENT_MAX_CHARS)}…`
}

/**
 * Render one skill hint as its bullet line plus, for deep-read hints, one
 * indented digest line quoting the head of the skill body.
 * @param hint - ranked (and possibly enriched) skill hint.
 * @returns the exact meta-prompt lines for the hint.
 */
function renderSkillHint(hint: SkillHint): string {
  const params = parameterSegment(hint.parameters)
  const line = `- ${hint.name} — ${hint.description} [${hint.sourceLabel}]${params === '' ? '' : `; ${params}`}`
  return hint.detail === undefined || hint.detail === ''
    ? line
    : `${line}\n    ${hint.detail}`
}

/** Skill-hint block appended to a system prompt when skills matched the draft. */
function skillBlock(skills: readonly SkillHint[]): readonly string[] {
  if (skills.length === 0) return []
  return [
    '',
    'Installed skills for this agent that match the draft (name — description [origin]):',
    'When a listed skill clearly serves the task, weave it into the rewrite: name the skill by its exact name at the exact step where the agent should load it, with one phrase saying what to use it for.',
    'Reference a listed skill only by its exact name; never invent, rename, or guess skill names. When none clearly applies, mention no skill at all.',
    'When a hint lists params, the rewrite may reference only those exact parameter names; never invent parameters.',
    ...skills.map(hint => renderSkillHint(hint)),
  ]
}

/** Direction block appended to a system prompt when the user steered the round. */
function directionBlock(direction: PromptOptimizeDirection): readonly string[] {
  return [
    '',
    'Rewrite direction the user requested (apply on top of the rules above):',
    `- ${DIRECTION_GUIDANCE[direction]}`,
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
  const { domainPriors = [], role, skills = [], language, direction, tier, clarifications = [], goalCriteria } = conditioning
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
    ...(tier === undefined ? [] : modelTierBlock(tier)),
    ...clarificationBlock(clarifications),
    ...goalCriteriaBlock(goalCriteria ?? []),
    ...(role === undefined ? [] : roleBlock(role, DRAFT_ROLE_INSTRUCTION)),
    ...skillBlock(skills),
    ...(direction === undefined ? [] : directionBlock(direction)),
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
  const { domainPriors = [], role, skills = [], language, direction, tier, clarifications = [], goalCriteria } = conditioning
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
    ...(tier === undefined ? [] : modelTierBlock(tier)),
    ...clarificationBlock(clarifications),
    ...goalCriteriaBlock(goalCriteria ?? []),
    ...(role === undefined ? [] : roleBlock(role, SYSTEM_ROLE_INSTRUCTION)),
    ...skillBlock(skills),
    ...(direction === undefined ? [] : directionBlock(direction)),
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
  const { domainPriors = [], role, skills = [], language, direction, tier, clarifications = [], goalCriteria } = conditioning
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
    ...(tier === undefined ? [] : modelTierBlock(tier)),
    ...clarificationBlock(clarifications),
    ...goalCriteriaBlock(goalCriteria ?? []),
    ...(role === undefined ? [] : roleBlock(role, SYSTEM_ROLE_INSTRUCTION)),
    ...skillBlock(skills),
    ...(direction === undefined ? [] : directionBlock(direction)),
    ...ENVELOPE_LINES,
  ].join('\n')
}

/**
 * The interviewer system prompt: turn the draft's ambiguity into at most
 * {@link MAX_QUESTIONS} high-leverage clarifying questions the user answers in
 * one click or a short sentence — the questions a domain specialist asks
 * before accepting the task, distilled from the same priors that condition
 * the rewrite.
 * @param conditioning - round conditioners; priors surface as questions, the
 * language pins the questions' language.
 * @returns exact system prompt text for one interview round.
 */
export function interviewSystemPrompt(conditioning: RoundConditioning = {}): string {
  const { domainPriors = [], language } = conditioning
  return [
    'You are an intent clarification specialist. The user gives you a draft prompt they intend to send to a coding agent. Interview the user: ask the questions whose answers would most change the rewrite.',
    '',
    'Rules:',
    languageRule(language),
    '2. Never answer the prompt, never perform the task, never evaluate the draft — only ask.',
    `3. Ask ${String(MAX_QUESTIONS)} or fewer questions. Ask none when the draft already pins down goal, inputs, and success — an empty answer is correct for a complete draft.`,
    '4. Each question must be answerable by the user in one click or one short sentence: a missing constraint (version, scope, environment), an unstated input or output, the observable definition of done, or an ignored edge case.',
    '5. Never ask about anything the draft already states; never offer an option the draft contradicts.',
    `6. Under each question, list at most ${String(MAX_OPTIONS)} short concrete candidate answers as bullets the user can pick verbatim. When candidates cannot be enumerated, list exactly '${FREE_TEXT_OPTION}' instead.`,
    ...priorBlock(domainPriors),
    '',
    'Respond with exactly this format and nothing else:',
    QUESTIONS_MARKER,
    'Q: (question text)',
    '- (candidate answer 1)',
    '- (candidate answer 2)',
    'Q: (another question)',
    `- ${FREE_TEXT_OPTION}`,
  ].join('\n')
}

/**
 * The goal-mode interviewer system prompt: the acceptance-first variant of
 * {@link interviewSystemPrompt}. The first question is always the observable
 * definition of done; the remaining rules match the plain interview.
 * @param conditioning - round conditioners; priors surface as questions, the
 * language pins the questions' language.
 * @returns exact system prompt text for one acceptance-first interview round.
 */
export function goalInterviewSystemPrompt(conditioning: RoundConditioning = {}): string {
  const { domainPriors = [], language } = conditioning
  return [
    'You are an acceptance-first intent clarification specialist. The user gives you a draft prompt they intend to send to a coding agent. Interview the user: the first question always pins down what "done" observably means.',
    '',
    'Rules:',
    languageRule(language),
    '2. Never answer the prompt, never perform the task, never evaluate the draft — only ask.',
    `3. The FIRST question is always the acceptance question: what observable outcome proves this task is done — a command that exits 0, an output shape, a measurable threshold, a human judgment point. Offer at most ${String(MAX_OPTIONS)} concrete candidate answers a user can pick verbatim.`,
    `4. After the acceptance question, ask at most ${String(MAX_QUESTIONS - 1)} further questions whose answers would most change the rewrite. Ask none when the draft already pins them.`,
    '5. Never ask about anything the draft already states; never offer an option the draft contradicts.',
    `6. Under each question, list at most ${String(MAX_OPTIONS)} short concrete candidate answers as bullets the user can pick verbatim. When candidates cannot be enumerated, list exactly '${FREE_TEXT_OPTION}' instead.`,
    ...priorBlock(domainPriors),
    '',
    'Respond with exactly this format and nothing else:',
    QUESTIONS_MARKER,
    'Q: (question text)',
    '- (candidate answer 1)',
    '- (candidate answer 2)',
    'Q: (another question)',
    `- ${FREE_TEXT_OPTION}`,
  ].join('\n')
}

/**
 * Frame one draft as the interview round's user input.
 * @param text - complete draft text to interview about.
 * @returns exact user input for the interview round.
 */
export function interviewUserInput(text: string): string {
  return ['Interview the user about the following draft prompt:', '', text].join('\n')
}

/**
 * Parse one interview response into its clarifying questions. The
 * {@link QUESTIONS_MARKER} line and the {@link FREE_TEXT_OPTION} marker are
 * format chrome, not content, and are dropped; later sections of a rewrite
 * envelope never appear because the interview prompt pins this exact format.
 * @param response - complete assembled interview response.
 * @returns at most {@link MAX_QUESTIONS} questions, each with at most
 * {@link MAX_OPTIONS} concrete options; empty when nothing was asked.
 */
export function parseInterviewResponse(response: string): readonly PromptInterviewQuestion[] {
  const markerStart = response.indexOf(QUESTIONS_MARKER)
  const body = markerStart === -1 ? response : response.slice(markerStart + QUESTIONS_MARKER.length)
  const questions: PromptInterviewQuestion[] = []
  let current: { text: string; options: string[] } | undefined
  const flush = (): void => {
    if (current !== undefined && current.text !== '') {
      questions.push({ text: current.text, options: current.options })
    }
    current = undefined
  }
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('Q:')) {
      flush()
      current = { text: line.replace(/^Q:\s*/, '').trim(), options: [] }
      if (questions.length >= MAX_QUESTIONS) break
      continue
    }
    if (current === undefined) continue
    const option = line.replace(/^[-*]\s+/, '').trim()
    if (option === '' || option === FREE_TEXT_OPTION) continue
    if (current.options.length < MAX_OPTIONS) current.options.push(option)
  }
  flush()
  return questions.slice(0, MAX_QUESTIONS)
}

/**
 * Frame one draft as a candidates round's user input: after the first
 * candidate, every later candidate sees its already-generated siblings and is
 * told to make different trade-offs, so N candidates spread across the
 * rewrite space instead of clustering on one phrasing.
 * @param text - complete draft text to optimize.
 * @param clarifications - interview answers folded in as authoritative requirements.
 * @param siblings - earlier candidates of the same round, generation order.
 * @returns exact user input for one candidate round.
 */
export function candidateUserInput(
  text: string,
  clarifications: readonly PromptClarification[],
  siblings: readonly { readonly label: string; readonly text: string }[],
  precedent: string | undefined = undefined,
): string {
  const earlier = siblings.map(sibling => `--- sibling candidate ${sibling.label} ---\n${sibling.text}`).join('\n\n')
  const answers = clarifications.map(pair => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n')
  return [
    siblings.length === 0
      ? ''
      : `This round already produced the sibling candidates below. Produce a meaningfully different alternative — different structure and different trade-offs (for example more explicit structure and invariants, or tighter concision) — never a near-copy of any sibling:\n\n${earlier}\n`,
    clarifications.length === 0
      ? ''
      : `The user answered these clarifying questions; each answer is an authoritative requirement of the rewrite:\n\n${answers}\n`,
    precedent === undefined
      ? ''
      : `A previously adopted rewrite of a similar draft in this domain (reference only — never copy verbatim; the draft's own facts and the user's answers always win):\n\n${precedent}\n`,
    'Optimize the following draft prompt:',
    '',
    text,
  ].filter(part => part !== '').join('\n')
}

/**
 * The judge system prompt: score every labeled candidate rewrite of one draft
 * on three independent 0–10 dimensions and name the single best pick, so the
 * user compares scored alternatives instead of trusting one rewrite.
 * @returns exact system prompt text for one judge round.
 */
export function judgeSystemPrompt(): string {
  return [
    'You are a prompt-judging specialist. You receive one draft prompt and several labeled candidate rewrites of it. Score every candidate and name the best one.',
    '',
    'Rules:',
    "1. Score each candidate on three dimensions, each an integer 0–10: faithfulness (preserves the draft's stated facts and intent, adds nothing), completeness (pins the constraints, inputs, and success criteria the draft implies), clarity (clear and immediately executable for the receiving agent).",
    '2. Score the dimensions independently and use the range; give identical scores only when the candidates are genuinely equal on that dimension.',
    '3. Judge only against the draft and the user\'s answers; never reward invented facts, and never penalize a candidate for omitting something the draft never stated.',
    '4. Write each rationale as one short line in the draft\'s language.',
    '5. End with exactly one BEST line naming the candidate you would hand the user — the highest total, ties broken by clarity.',
    '',
    'Respond with exactly this format and nothing else:',
    JUDGE_MARKER,
    'A: faithfulness=8 completeness=7 clarity=9 — (one short rationale)',
    'B: faithfulness=7 completeness=9 clarity=8 — (one short rationale)',
    'BEST: A',
  ].join('\n')
}

/**
 * Frame the draft, the user's answers, and every labeled candidate as the
 * judge round's user input.
 * @param text - complete original draft text.
 * @param clarifications - interview answers that conditioned the candidates.
 * @param candidates - labeled candidate rewrites, generation order.
 * @returns exact user input for the judge round.
 */
export function judgeUserInput(
  text: string,
  clarifications: readonly PromptClarification[],
  candidates: readonly { readonly label: string; readonly text: string }[],
): string {
  const answers = clarifications.map(pair => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n')
  const labeled = candidates.map(candidate => `--- candidate ${candidate.label} ---\n${candidate.text}`).join('\n\n')
  return [
    'Judge these candidate rewrites of one draft prompt.',
    '',
    '--- original draft ---',
    text,
    '',
    ...(clarifications.length === 0
      ? []
      : ['--- the user\'s authoritative answers ---', answers, '']),
    labeled,
    '',
    'Output only the scoring block in the required format.',
  ].join('\n')
}

/** One parsed judge line: a labeled candidate's scores, clamped to 0–10 integers. */
interface ParsedJudgeScore {
  readonly label: string
  readonly scores: PromptCandidateScores
}

/**
 * Parse one judge response into per-label scores and the BEST pick. Lines for
 * labels outside `labels` are ignored; out-of-range or fractional scores are
 * clamped to integers 0–10; a BEST naming an unscored or unknown label is
 * dropped. Everything outside {@link JUDGE_MARKER} is ignored.
 * @param response - complete assembled judge response.
 * @param labels - candidate labels the round generated, generation order.
 * @returns the parsed scores plus the valid BEST label when one appeared.
 */
export function parseJudgeResponse(response: string, labels: readonly string[]): {
  readonly scores: readonly ParsedJudgeScore[]
  readonly best: string | undefined
} {
  const markerStart = response.indexOf(JUDGE_MARKER)
  const body = markerStart === -1 ? response : response.slice(markerStart + JUDGE_MARKER.length)
  const known = new Set(labels)
  const clamp = (value: number): number => Math.max(0, Math.min(10, Math.trunc(value)))
  const scores: ParsedJudgeScore[] = []
  let best: string | undefined
  const seen = new Set<string>()
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    const scoreMatch = /^([A-Za-z]):\s*faithfulness=(-?\d+(?:\.\d+)?)\s+completeness=(-?\d+(?:\.\d+)?)\s+clarity=(-?\d+(?:\.\d+)?)/.exec(line)
    if (scoreMatch !== null) {
      const label = scoreMatch[1]!
      if (!known.has(label) || seen.has(label)) continue
      seen.add(label)
      scores.push({
        label,
        scores: {
          faithfulness: clamp(Number(scoreMatch[2])),
          completeness: clamp(Number(scoreMatch[3])),
          clarity: clamp(Number(scoreMatch[4])),
        },
      })
      continue
    }
    const bestMatch = /^BEST:\s*([A-Za-z])\s*$/.exec(line)
    if (bestMatch !== null) best = bestMatch[1]
  }
  return { scores, best: best !== undefined && known.has(best) && seen.has(best) ? best : undefined }
}

/**
 * Mark which scored candidates sit on the Pareto frontier: a candidate is
 * dominated when some scored sibling matches or beats it on every dimension
 * and strictly beats it on at least one. Unscored entries are never on the
 * frontier.
 * @param scores - per-candidate scores aligned with the candidate list; undefined for unscored.
 * @returns one flag per entry, true exactly on the frontier.
 */
export function paretoFlags(scores: readonly (PromptCandidateScores | undefined)[]): readonly boolean[] {
  const dims: (keyof PromptCandidateScores)[] = ['faithfulness', 'completeness', 'clarity']
  return scores.map((self, index) => {
    if (self === undefined) return false
    return !scores.some((other, otherIndex) => {
      if (otherIndex === index || other === undefined) return false
      const ge = dims.every(dim => other[dim] >= self[dim])
      const gt = dims.some(dim => other[dim] > self[dim])
      return ge && gt
    })
  })
}

/**
 * The distillation system prompt: condense one completed round (draft plus its
 * optimized result and the user's authoritative answers) into one durable
 * agent-skill file — the recurring intent, the constraints the rewrite pinned,
 * and how to reproduce this kind of prompt — so the third time the user drafts
 * the same thing, the skill answers instead of another rewrite.
 * @returns exact system prompt text for one distillation round.
 */
export function distillationSystemPrompt(): string {
  return [
    'You are a skill distiller. The user gives you one draft prompt, its optimized rewrite, and the answers the user gave while clarifying the draft. Produce one agent skill file that captures this recurring prompt shape as durable, reusable instructions.',
    '',
    'Rules:',
    "1. Output only the skill file: YAML frontmatter, then the markdown body. No preamble, no closing remarks, no code fences around the whole file.",
    '2. Frontmatter keys, exactly two lines: `name:` a kebab-case id (lowercase letters, digits, single hyphens) naming the prompt shape, and `description:` one line (at most 200 characters) saying what task shape this skill covers and when to reach for it.',
    '3. Body structure, in this order: a `# ` title; a short "When to use" section; a "Captured requirements" checklist distilling every constraint, input, and success criterion the optimized prompt and the answers pinned; an "Output shape" section stating the expected deliverable; and a compact worked example distilled from the given materials.',
    '4. Progressive disclosure: keep the body under 120 lines; the checklist carries the load, never retell the draft verbatim.',
    '5. Reference at most one level deep: the body may mention files by relative path inside the skill directory, but assume none exist — never depend on them.',
    '6. Never invent facts, tools, thresholds, or requirements the materials do not support; never mention this plugin, the rewrite, or the distillation.',
    '7. Write the body in the language the optimized result is written in; keep the `name` value and code identifiers in their original form.',
  ].join('\n')
}

/**
 * Frame the round's materials as the distillation round's user input.
 * @param draft - complete original draft text.
 * @param optimized - complete optimized text the round produced.
 * @param clarifications - interview answers the round carried.
 * @returns exact user input for the distillation round.
 */
export function distillationUserInput(
  draft: string,
  optimized: string,
  clarifications: readonly PromptClarification[],
): string {
  const answers = clarifications.map(pair => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n')
  return [
    'Distill the completed optimization round below into one agent skill file.',
    '',
    '--- original draft ---',
    draft,
    '',
    '--- optimized result ---',
    optimized,
    ...(clarifications.length === 0
      ? []
      : ['', '--- the user\'s authoritative answers ---', answers]),
    '',
    'Output only the skill file in the required format.',
  ].join('\n')
}

/** One parsed skill definition: frontmatter identity plus the full file text. */
export interface ParsedSkillDefinition {
  /** Kebab-case `name:` frontmatter value. */
  readonly name: string
  /** One-line `description:` frontmatter value. */
  readonly description: string
  /** Complete definition file text, frontmatter included. */
  readonly definition: string
}

/** Kebab-case skill-name grammar mirrored from the harness skill registry. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Longest description line accepted from produced frontmatter. */
const SKILL_DESCRIPTION_MAX_CHARS = 200

/**
 * Parse one model response into a validated skill definition. The frontmatter
 * block must carry `name:` (kebab-case) and `description:` (one line); quoted
 * values are unwrapped; anything that fails the shape rejects the round.
 * @param response - complete assembled distillation response.
 * @returns the parsed definition.
 * @throws when no frontmatter block exists or name/description fail validation.
 */
export function parseSkillDefinition(response: string): ParsedSkillDefinition {
  const fenced = response.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
  const match = /^---\n([\s\S]*?)\n---/.exec(fenced.trimStart())
  if (match === null) {
    throw new Error('the skill definition must start with a YAML frontmatter block')
  }
  const frontmatter = match[1]!
  const unquote = (value: string): string => {
    const trimmed = value.trim()
    return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed
  }
  const nameLine = frontmatter.split('\n').find(line => /^name:\s*/.test(line))
  const descriptionLine = frontmatter.split('\n').find(line => /^description:\s*/.test(line))
  const name = nameLine === undefined ? '' : unquote(nameLine.replace(/^name:\s*/, ''))
  const description = descriptionLine === undefined ? '' : unquote(descriptionLine.replace(/^description:\s*/, ''))
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('the skill definition needs a kebab-case `name:` frontmatter value')
  }
  if (description === '' || description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    throw new Error(`the skill definition needs a one-line \`description:\` frontmatter value of at most ${String(SKILL_DESCRIPTION_MAX_CHARS)} characters`)
  }
  return { name, description, definition: fenced.trim() }
}

/**
 * The skill-merge system prompt: fuse two near-duplicate agent skill files
 * into one definition that keeps every distinct requirement either file
 * pinned, so the merged skill replaces the pair without losing a constraint.
 * @returns exact system prompt text for one skill-merge round.
 */
export function skillMergeSystemPrompt(): string {
  return [
    'You are a skill definition merger. The user gives you two agent skill files that largely repeat each other. Produce one merged skill file that replaces the pair.',
    '',
    'Rules:',
    '1. Output only the merged skill file: YAML frontmatter, then the markdown body. No preamble, no closing remarks, no code fences around the whole file.',
    '2. Keep the first definition\'s `name:` value verbatim; its `description:` may widen to cover what the second file added, still one line within the same length cap.',
    '3. Merge by union: every requirement, input, constraint, and success criterion either file pinned appears exactly once in the merged body. Never drop, soften, or invent requirements.',
    '4. Where the two files phrase the same requirement differently, keep the more specific phrasing.',
    '5. Keep the merged body under 120 lines and one reference level deep, mirroring a well-formed skill file.',
    '6. Write the body in the language the two definitions are written in; keep the `name` value and code identifiers in their original form.',
  ].join('\n')
}

/**
 * Frame the two near-duplicate skill definitions as the merge round's user input.
 * @param left - complete first definition text (the one the merge keeps the name of).
 * @param right - complete second definition text.
 * @returns exact user input for the merge round.
 */
export function skillMergeUserInput(left: string, right: string): string {
  return [
    'Merge the two near-duplicate skill files below into one definition that replaces the pair.',
    '',
    '--- first definition (keeps its name) ---',
    left,
    '',
    '--- second definition ---',
    right,
    '',
    'Output only the merged skill file in the required format.',
  ].join('\n')
}

/**
 * The skill-evolution system prompt: update one existing distilled skill from
 * a newer completed round of the same prompt shape — keep every requirement
 * that still holds, absorb what the new round pinned better, and keep the
 * definition-file contract intact so the confirm overwrites in place.
 * @returns exact system prompt text for one skill-evolution round.
 */
export function skillEvolutionSystemPrompt(): string {
  return [
    'You are a skill definition maintainer. The user gives you the current definition of one agent skill plus the draft, optimized rewrite, and clarifying answers of a newer round of the same prompt shape. Rewrite the skill definition from these materials.',
    '',
    'Rules:',
    '1. Output only the skill file: YAML frontmatter, then the markdown body. No preamble, no closing remarks, no code fences around the whole file.',
    '2. Keep the current `name:` value verbatim; the `description:` may widen or tighten to match the shape the materials demonstrate, still one line within the same length cap.',
    '3. Keep every requirement of the current definition that the materials do not contradict — evolution never drops pinned constraints; fold in every requirement the optimized rewrite and the answers pin that the current definition lacks.',
    '4. Where the current definition and the materials phrase the same requirement differently, keep the more specific and the more checkable phrasing.',
    '5. Keep the body structure and progressive disclosure of a well-formed skill file: under 120 lines, one reference level deep.',
    '6. Never invent facts, tools, thresholds, or requirements the materials do not support; never mention this plugin, the rewrite, or the evolution.',
    '7. Write the body in the language the current definition is written in; keep the `name` value and code identifiers in their original form.',
  ].join('\n')
}

/**
 * Frame the evolution materials (current definition plus the newer round) as
 * the round's user input.
 * @param definition - complete current skill definition text.
 * @param draft - complete draft text the newer round optimized.
 * @param optimized - complete optimized text the newer round produced.
 * @param clarifications - interview answers the newer round carried.
 * @returns exact user input for the skill-evolution round.
 */
export function skillEvolutionUserInput(
  definition: string,
  draft: string,
  optimized: string,
  clarifications: readonly PromptClarification[],
): string {
  const answers = clarifications.map(pair => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n')
  return [
    'Rewrite this skill definition from the newer round below.',
    '',
    '--- current skill definition ---',
    definition,
    '',
    '--- draft the newer round optimized ---',
    draft,
    '',
    '--- optimized result ---',
    optimized,
    ...(clarifications.length === 0
      ? []
      : ['', '--- the user\'s authoritative answers ---', answers]),
    '',
    'Output only the updated skill file in the required format.',
  ].join('\n')
}

/**
 * The section-merge system prompt: fuse two near-duplicate system-prompt
 * sections into one replacement section the user pastes back by hand — the
 * assembled system prompt has no write-back API, so the output is advisory
 * copy, never a rewrite of anything.
 * @returns exact system prompt text for one section-merge round.
 */
export function sectionMergeSystemPrompt(): string {
  return [
    'You are a system-prompt section merger. The user gives you two sections of an assembled system prompt that largely repeat each other. Produce one merged replacement section.',
    '',
    'Rules:',
    '1. Output only the merged section text — no heading marker, no preamble, no closing remarks, no code fences.',
    '2. Merge by union: every instruction, rule, and fact either section stated appears once. Never drop or soften anything; never invent anything.',
    '3. Where the two sections phrase the same rule differently, keep the more specific and the more checkable phrasing.',
    '4. Keep the merged section no longer than the longer input section; prefer tightening duplicated phrasing over appending.',
    '5. Write the merged section in the language the two sections are written in; keep code identifiers and tool names verbatim.',
  ].join('\n')
}

/**
 * Frame the two near-duplicate system-prompt sections as the merge round's
 * user input.
 * @param leftName - first section's name.
 * @param leftText - first section's complete text.
 * @param rightName - second section's name.
 * @param rightText - second section's complete text.
 * @returns exact user input for the section-merge round.
 */
export function sectionMergeUserInput(leftName: string, leftText: string, rightName: string, rightText: string): string {
  return [
    'Merge the two near-duplicate system-prompt sections below into one replacement section.',
    '',
    `--- section "${leftName}" ---`,
    leftText,
    '',
    `--- section "${rightName}" ---`,
    rightText,
    '',
    'Output only the merged section text in the required format.',
  ].join('\n')
}

/**
 * The role-evolution system prompt: rewrite one role definition file from the
 * materials of a completed round (current definition, draft, optimized
 * result), keeping the definition-file contract intact.
 * @returns exact system prompt text for one role-evolution round.
 */
export function roleEvolutionSystemPrompt(): string {
  return [
    'You are a role definition maintainer. The user gives you the current definition of one professional role plus the draft and the optimized prompt of a round that role styled. Rewrite the role definition file based on the given materials.',
    '',
    'Rules:',
    '1. Output only the definition file itself: no preamble, no closing remarks, no code fences, nothing before or after the definition.',
    '2. Keep the first line an H1 heading in the exact format `# 中文名（English）`, preserving the role\'s current Chinese and English names unless the materials clearly refine them.',
    '3. Keep the seven-section structure with these exact headings in this order: `## 角色设定`, `## 背景`, `## 技能`, `## 工作方式`, `## 输出格式`, `## 回答风格`, `## 回答限制`.',
    '4. Absorb the domain vocabulary and task shapes the materials demonstrate into the definition; never invent experiences, credentials, or facts the current definition and the materials do not support.',
    '5. Write the definition in Chinese (the English name in the H1 and unavoidable technical terms excepted).',
    '6. Keep the whole definition between 250 and 900 Chinese characters.',
    '7. Never mention any tool name or command name in the definition.',
  ].join('\n')
}

/**
 * Frame the three evolution materials (current definition, draft, optimized
 * result) as the round's user input.
 * @param definition - complete current role definition text.
 * @param draft - complete draft text the round optimized.
 * @param optimized - complete optimized text the round produced.
 * @returns exact user input for the role-evolution round.
 */
export function roleEvolutionUserInput(definition: string, draft: string, optimized: string): string {
  return [
    'Rewrite this role definition from the materials below.',
    '',
    '--- current role definition ---',
    definition,
    '',
    '--- draft the round optimized ---',
    draft,
    '',
    '--- optimized result ---',
    optimized,
    '',
    'Output the complete rewritten role definition file only.',
  ].join('\n')
}

/**
 * Frame one draft (and optional rejected earlier results, answered clarifying
 * questions, and a same-domain adopted precedent) as the round's user input.
 * @param text - complete draft text to optimize.
 * @param previousAttempts - rejected optimized texts, oldest first.
 * @param clarifications - interview answers folded in as authoritative requirements.
 * @param precedent - best previously adopted rewrite of a similar draft, as reference-only material.
 * @returns exact user input for the round.
 */
export function optimizerUserInput(
  text: string,
  previousAttempts: readonly string[],
  clarifications: readonly PromptClarification[] = [],
  precedent: string | undefined = undefined,
): string {
  const earlier = previousAttempts.map((attempt, index) =>
    `--- rejected result ${String(index + 1)} ---\n${attempt}`).join('\n\n')
  const answers = clarifications.map(pair => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n')
  return [
    previousAttempts.length === 0
      ? ''
      : `The user rejected these earlier rewrites; produce a meaningfully different revision:\n\n${earlier}\n`,
    clarifications.length === 0
      ? ''
      : `The user answered these clarifying questions; each answer is an authoritative requirement of the rewrite:\n\n${answers}\n`,
    precedent === undefined
      ? ''
      : `A previously adopted rewrite of a similar draft in this domain (reference only — never copy verbatim; the draft's own facts and the user's answers always win):\n\n${precedent}\n`,
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
