/**
 * Deterministic context-to-skill selection and hint enrichment for
 * skill-aware optimization: keyword overlap between the request context
 * (draft plus queued inbox text) and each model-invocable skill's routing
 * text, plus a bilingual gloss bridging CJK draft terms to Latin routing
 * text (and the mirror direction), followed by best-effort parsing of a
 * deep-read skill definition's parameter descriptors and body digest. No
 * model call — the same context always yields the same hints, mirroring
 * {@link recommendRoles}.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { tokenize } from './recommend.ts'

/** Most skill hints one optimization round injects. */
const MAX_SKILL_HINTS = 12
/** Minimum score a skill needs before it is worth hinting. */
const MIN_SKILL_SCORE = 2
/** Score one bilingual gloss bridge contributes when a concept crosses languages. */
const GLOSS_HIT_SCORE = 2
/** Longest description carried into the meta-prompt, marked when clipped. */
const DESCRIPTION_MAX_CHARS = 160
/** Most parameter descriptors one hint carries. */
const MAX_PARAMETERS = 4
/** Most hints one round deep-reads through the registry for enrichment. */
export const MAX_DETAIL_HINTS = 3
/** Longest one-parameter description kept, marked when clipped. */
const PARAMETER_DESCRIPTION_MAX_CHARS = 24
/** Longest body digest one deep-read hint carries, marked when clipped. */
const DETAIL_MAX_CHARS = 200

/** One bilingual concept pair bridging CJK draft terms and Latin skill text. */
interface GlossEntry {
  /** CJK synonyms a draft may carry for the concept. */
  readonly zh: readonly string[]
  /** Latin single-word synonyms skill routing text may carry. */
  readonly en: readonly string[]
}

/**
 * Bilingual concept gloss closing the CJK↔Latin vocabulary gap: a Chinese
 * draft almost never contains the Latin words an English-described skill
 * routes on, so pure token overlap selects nothing and the rewrite never
 * learns about matching skills. Each entry scores a skill when one side of
 * the concept appears in the draft and the other side appears in the skill's
 * name or routing text. Curated and deterministic — still no model call.
 */
const SKILL_GLOSS: readonly GlossEntry[] = [
  { zh: ['前端', '网页', '页面', '界面', '登录页'], en: ['frontend', 'web', 'ui', 'page'] },
  { zh: ['样式', '布局', '响应式', '主题'], en: ['css', 'layout', 'responsive', 'style', 'theme'] },
  { zh: ['组件', '弹窗', '表单', '交互'], en: ['component', 'modal', 'dialog', 'form', 'interactive'] },
  { zh: ['接口', '后端', '服务端', '鉴权'], en: ['api', 'backend', 'server', 'endpoint', 'auth'] },
  { zh: ['数据库', '缓存', '迁移', '队列'], en: ['database', 'sql', 'cache', 'migration', 'queue'] },
  { zh: ['部署', '发布', '上线', '托管'], en: ['deploy', 'release', 'publish', 'hosting'] },
  { zh: ['测试', '单测', '覆盖率'], en: ['test', 'testing', 'tdd', 'coverage'] },
  { zh: ['调试', '排查', '报错', '崩溃', '回归'], en: ['debug', 'diagnose', 'crash', 'regression'] },
  { zh: ['日志'], en: ['log', 'logging'] },
  { zh: ['性能', '剖析', '提速', '内存'], en: ['performance', 'profiling', 'benchmark', 'memory'] },
  { zh: ['嵌入式', '单片机', '固件', '外设'], en: ['embedded', 'firmware', 'mcu', 'peripheral'] },
  { zh: ['串口', '中断', '寄存器', '引脚'], en: ['uart', 'serial', 'interrupt', 'register', 'gpio'] },
  { zh: ['文档', '注释', '说明'], en: ['docs', 'documentation', 'comment', 'readme'] },
  { zh: ['重构', '代码审查', '评审'], en: ['refactor', 'review', 'lint'] },
  { zh: ['安全', '漏洞', '注入', '加密'], en: ['security', 'vulnerability', 'cve', 'injection', 'crypto'] },
  { zh: ['脚本', '自动化', '命令行'], en: ['script', 'cli', 'automation', 'shell'] },
  { zh: ['图表', '可视化', '大屏'], en: ['chart', 'visualization', 'diagram', 'graph'] },
  { zh: ['截图', '录屏', '抓屏'], en: ['screenshot', 'capture'] },
  { zh: ['视频', '音频', '语音', '转录'], en: ['video', 'audio', 'speech', 'transcript'] },
  { zh: ['容器', '镜像', '编排'], en: ['docker', 'container', 'k8s', 'kubernetes'] },
  { zh: ['分支', '提交', '合并'], en: ['git', 'branch', 'commit', 'merge'] },
  { zh: ['提示词', '提示工程'], en: ['prompt', 'prompt-engineering'] },
  { zh: ['移动端', '安卓'], en: ['mobile', 'android', 'ios'] },
  { zh: ['爬虫', '抓取'], en: ['scraper', 'crawler', 'scraping'] },
  { zh: ['搜索', '检索'], en: ['search', 'retrieval'] },
]

/** Whole Latin word (identifier charset) extracted from lowercased text. */
const LATIN_WORD_PATTERN = /[a-z][a-z0-9_-]+/g

/**
 * Collect the whole Latin words of lowercased text into a membership set.
 * @param text - already-lowercased name or routing text.
 * @returns every distinct Latin word the text carries.
 */
function wordSetOf(text: string): Set<string> {
  return new Set(text.match(LATIN_WORD_PATTERN) ?? [])
}

/**
 * Whole-word membership with regular-plural tolerance: a term matches when
 * the set carries it or its simple `s`-plural form.
 * @param words - Latin word set from {@link wordSetOf} or {@link tokenize}.
 * @param word - gloss term to look up.
 */
function wordSetHas(words: ReadonlySet<string>, word: string): boolean {
  return words.has(word) || words.has(`${word}s`)
}

/**
 * Score the bilingual gloss hits for one skill: {@link GLOSS_HIT_SCORE} per
 * concept whose CJK side appears in the draft while its Latin side appears in
 * the skill's name or routing words, or the mirror direction. Latin terms
 * compare whole-word with plural tolerance so `comment` matches `comments`
 * but never `commentsSection`; CJK terms compare as substrings, matching the
 * bigram style of {@link tokenize}.
 * @param context - complete context text (draft plus queued messages).
 * @param contextWords - Latin tokens of the context from {@link tokenize}.
 * @param name - lowercased skill name.
 * @param routing - lowercased description plus `whenToUse` guidance.
 * @returns the gloss contribution to the skill's score; zero for no bridge.
 */
function glossScoreOf(context: string, contextWords: ReadonlySet<string>, name: string, routing: string): number {
  const nameWords = wordSetOf(name)
  const routingWords = wordSetOf(routing)
  let score = 0
  for (const entry of SKILL_GLOSS) {
    const draftZh = entry.zh.some(term => context.includes(term))
    const draftEn = entry.en.some(term => wordSetHas(contextWords, term))
    if (!draftZh && !draftEn) continue
    const skillZh = entry.zh.some(term => routing.includes(term))
    const skillEn = entry.en.some(term => wordSetHas(nameWords, term) || wordSetHas(routingWords, term))
    if ((draftZh && skillEn) || (draftEn && skillZh)) score += GLOSS_HIT_SCORE
  }
  return score
}

/** One parameter descriptor parsed from a skill's frontmatter metadata. */
export interface SkillParameter {
  /** Exact parameter name; the only form the rewrite may reference. */
  readonly name: string
  /** One-line parameter purpose, clipped when long. */
  readonly description: string
}

/** One selected skill hint injected into an optimization system prompt. */
export interface SkillHint {
  /** Exact skill name; the only form the rewrite may reference. */
  readonly name: string
  /** Clipped one-line routing description. */
  readonly description: string
  /** Coarse origin bucket for the skill's discovery source. */
  readonly sourceLabel: string
  /** Parameter descriptors from a deep-read definition; absent when none. */
  readonly parameters?: readonly SkillParameter[]
  /** Body digest from a deep-read definition; absent when only summarized. */
  readonly detail?: string
}

/**
 * Clip one skill description for meta-prompt injection.
 * @param description - complete routing description.
 * @returns the head of the description, marked when truncation occurred.
 */
function clipDescription(description: string): string {
  return description.length <= DESCRIPTION_MAX_CHARS
    ? description
    : `${description.slice(0, DESCRIPTION_MAX_CHARS)}…`
}

/**
 * Map one discovery source onto the coarse origin bucket the meta-prompt
 * labels hints with: project-scoped roots, user-scoped roots, bundled
 * catalog, runtime registration, and anything else as custom.
 * @param source - discovery source from the skill summary.
 * @returns the lowercase origin label appended to rendered hints.
 */
export function sourceLabelOf(source: string): string {
  if (source === 'project-dsh' || source === 'project-agents') return 'project'
  if (source === 'user-dsh' || source === 'user-agents') return 'user'
  if (source === 'bundled') return 'bundled'
  if (source === 'runtime') return 'runtime'
  return 'custom'
}

/** Structural minimum {@link skillParametersOf} and {@link enrichSkillHint} read. */
export type SkillDefinitionLike = Readonly<Pick<SkillDefinition, 'content' | 'metadata'>>

/**
 * Parse parameter descriptors from a skill definition's frontmatter
 * metadata, convention key `parameters`. Accepted shapes: an array of
 * `{ name, description? }` (or `desc`), an array of plain parameter-name
 * strings, or a record mapping parameter name to description. Deterministic
 * and total: unrecognized shapes yield no parameters.
 * @param definition - deep-read skill definition carrying frontmatter.
 * @returns at most {@link MAX_PARAMETERS} descriptors, frontmatter order,
 * each description clipped; empty when the convention is absent or invalid.
 */
export function skillParametersOf(definition: SkillDefinitionLike): readonly SkillParameter[] {
  const raw = definition.metadata?.parameters
  const entries: { name: string; description: string }[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') entries.push({ name: item, description: '' })
      else if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>
        const name = record.name
        if (typeof name !== 'string' || name.trim() === '') continue
        const description = record.description ?? record.desc
        entries.push({ name: name.trim(), description: typeof description === 'string' ? description : '' })
      }
    }
  } else if (typeof raw === 'object' && raw !== null) {
    for (const [name, description] of Object.entries(raw as Record<string, unknown>)) {
      if (name.trim() === '') continue
      entries.push({ name: name.trim(), description: typeof description === 'string' ? description : '' })
    }
  }
  return entries.slice(0, MAX_PARAMETERS).map(parameter => ({
    name: parameter.name,
    description: parameter.description.length <= PARAMETER_DESCRIPTION_MAX_CHARS
      ? parameter.description
      : `${parameter.description.slice(0, PARAMETER_DESCRIPTION_MAX_CHARS)}…`,
  }))
}

/**
 * Collapse a deep-read skill body into one digest line for meta-prompt
 * injection: whitespace flattened to single spaces, clipped with an explicit
 * ellipsis marker when longer than {@link DETAIL_MAX_CHARS}.
 * @param content - complete markdown body of the skill definition.
 * @returns the flattened head of the body, marked when truncation occurred.
 */
export function digestOf(content: string): string {
  const flattened = content.replace(/\s+/g, ' ').trim()
  return flattened.length <= DETAIL_MAX_CHARS
    ? flattened
    : `${flattened.slice(0, DETAIL_MAX_CHARS)}…`
}

/**
 * Enrich one selected hint with a deep-read definition's parameter
 * descriptors and body digest. Pure: the definition's own summary fields are
 * ignored, so enrichment never rewrites the ranked name or description.
 * @param hint - ranked summary hint to enrich.
 * @param definition - deep-read definition the registry returned for it.
 * @returns the hint plus `parameters` and `detail`; fields stay absent when
 * the definition declares no parameters or an empty body.
 */
export function enrichSkillHint(hint: SkillHint, definition: SkillDefinitionLike): SkillHint {
  const parameters = skillParametersOf(definition)
  const detail = digestOf(definition.content)
  return {
    ...hint,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(detail !== '' ? { detail } : {}),
  }
}

/**
 * Score every model-invocable skill against the context tokens: a token
 * matching the skill's name counts three, one in the routing description or
 * `whenToUse` guidance counts one, and each bilingual gloss concept that
 * crosses languages between draft and skill counts
 * {@link GLOSS_HIT_SCORE}. Deterministic: equal scores break by name
 * order. Skills the model cannot invoke are never hinted, so a hint always
 * names a skill the runtime agent can load.
 * @param context - complete context text (draft plus queued messages).
 * @param skills - every skill the resolved registry listed.
 * @returns the top hints at or above {@link MIN_SKILL_SCORE}, highest score
 * first, each carrying the exact name, a clipped description, and the
 * coarse origin label.
 */
export function selectSkillHints(context: string, skills: readonly SkillSummary[]): readonly SkillHint[] {
  const tokens = tokenize(context)
  if (tokens.length === 0) return []
  const contextWords = new Set(tokens)
  const scored: { hint: SkillHint; score: number }[] = []
  for (const skill of skills) {
    if (!isModelInvocable(skill)) continue
    const name = skill.name.toLowerCase()
    const routing = `${skill.description} ${skill.whenToUse ?? ''}`.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (name.includes(token)) score += 3
      else if (routing.includes(token)) score += 1
    }
    score += glossScoreOf(context, contextWords, name, routing)
    if (score >= MIN_SKILL_SCORE) {
      scored.push({ hint: { name: skill.name, description: clipDescription(skill.description), sourceLabel: sourceLabelOf(skill.source) }, score })
    }
  }
  return scored
    .sort((left, right) => right.score - left.score || left.hint.name.localeCompare(right.hint.name))
    .slice(0, MAX_SKILL_HINTS)
    .map(entry => entry.hint)
}
