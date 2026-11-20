/**
 * Deterministic context-doctor analysis: given the assembled system-prompt
 * sections and the scanned skill bodies, surface redundancy, oversized blocks,
 * and stale file references before they rot the working context. Pure
 * functions only — the service owns I/O.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import type { PromptContextFinding } from './types.ts'

/** Longest system-prompt section (in characters) that escapes a finding. */
const SECTION_MAX_CHARS = 4_000
/** Longest skill body (in characters) that escapes a finding. */
const SKILL_MAX_CHARS = 6_000
/** Minimum block size (in characters) before two blocks may count as duplicates. */
const DUPLICATE_MIN_CHARS = 200
/** Word-set Jaccard similarity at which two system-prompt sections are duplicates. */
const SECTION_DUPLICATE_JACCARD = 0.6
/** Word-set Jaccard similarity at which two skill bodies are duplicates. */
const SKILL_DUPLICATE_JACCARD = 0.7
/** Most relative file references checked against one skill's directory. */
const MAX_REFS_PER_SKILL = 8
/** Relative-path references worth an existence check: `./guide.md`, `data.csv`, `scripts/run.sh`. */
const REFERENCE_PATTERN = /(?:^|[\s(`[>])(\.?\/)?([A-Za-z0-9_][A-Za-z0-9_-]*(?:[/.][A-Za-z0-9_.-]+)*\.(?:md|txt|json|ya?ml|csv|sh|py|ts|js|tsx|ps1))\b/g

/** One system-prompt section as the doctor sizes it. */
export interface SectionStat {
  readonly name: string
  readonly chars: number
  /** Share of the assembled sections' total characters, 0–1. */
  readonly share: number
}

/** Word-set Jaccard similarity between two texts; case-insensitive, punctuation-split. */
function jaccard(left: string, right: string): number {
  const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(word => word !== ''))
  const a = wordsOf(left)
  const b = wordsOf(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) {
    if (b.has(word)) shared += 1
  }
  return shared / (a.size + b.size - shared)
}

/**
 * Size the assembled sections and surface redundancy and bloat findings.
 * @param sections - assembled system-prompt sections in canonical order.
 * @returns per-section stats plus findings for oversized and near-duplicate sections.
 */
export function analyzeSections(sections: readonly { readonly name: string; readonly text: string }[]): {
  readonly stats: readonly SectionStat[]
  readonly findings: readonly PromptContextFinding[]
} {
  const total = sections.reduce((sum, section) => sum + section.text.length, 0)
  const stats = sections.map(section => ({
    name: section.name,
    chars: section.text.length,
    share: total === 0 ? 0 : section.text.length / total,
  }))
  const findings: PromptContextFinding[] = []
  for (const [index, section] of sections.entries()) {
    if (section.text.length > SECTION_MAX_CHARS) {
      findings.push({
        kind: 'oversized-section',
        subject: section.name,
        detail: `${String(section.text.length)} characters (cap ${String(SECTION_MAX_CHARS)}); consider splitting or trimming this section`,
      })
    }
    for (let later = index + 1; later < sections.length; later += 1) {
      const other = sections[later]!
      if (section.text.length < DUPLICATE_MIN_CHARS || other.text.length < DUPLICATE_MIN_CHARS) continue
      const similarity = jaccard(section.text, other.text)
      if (similarity >= SECTION_DUPLICATE_JACCARD) {
        findings.push({
          kind: 'duplicate-section',
          subject: `${section.name} ≈ ${other.name}`,
          detail: `word overlap ${Math.round(similarity * 100)}%; these sections largely repeat each other`,
        })
      }
    }
  }
  return { stats, findings }
}

/**
 * Relative file references a skill body names, first-appearance order, capped.
 * @param body - complete skill instruction body.
 * @returns at most {@link MAX_REFS_PER_SKILL} candidate relative paths.
 */
export function referencesOf(body: string): readonly string[] {
  const refs: string[] = []
  for (const match of body.matchAll(REFERENCE_PATTERN)) {
    const ref = match[2]!
    if (!refs.includes(ref) && refs.length < MAX_REFS_PER_SKILL) refs.push(ref)
  }
  return refs
}

/**
 * Surface bloat, duplication, and stale-reference findings across scanned skill bodies.
 * @param skills - scanned skills with name, body, and an existence checker for relative references.
 * @param exists - async predicate resolving whether one relative reference exists in the skill's directory.
 * @returns findings for oversized bodies, near-duplicate bodies, and missing referenced files.
 */
export async function analyzeSkills(
  skills: readonly { readonly name: string; readonly body: string }[],
  exists: (skill: string, reference: string) => Promise<boolean>,
): Promise<readonly PromptContextFinding[]> {
  const findings: PromptContextFinding[] = []
  for (const [index, skill] of skills.entries()) {
    if (skill.body.length > SKILL_MAX_CHARS) {
      findings.push({
        kind: 'oversized-skill',
        subject: skill.name,
        detail: `body is ${String(skill.body.length)} characters (cap ${String(SKILL_MAX_CHARS)}); move detail into referenced files`,
      })
    }
    for (let later = index + 1; later < skills.length; later += 1) {
      const other = skills[later]!
      if (skill.body.length < DUPLICATE_MIN_CHARS || other.body.length < DUPLICATE_MIN_CHARS) continue
      const similarity = jaccard(skill.body, other.body)
      if (similarity >= SKILL_DUPLICATE_JACCARD) {
        findings.push({
          kind: 'duplicate-skill',
          subject: `${skill.name} ≈ ${other.name}`,
          detail: `word overlap ${Math.round(similarity * 100)}%; these skills largely repeat each other`,
        })
      }
    }
  }
  for (const skill of skills) {
    for (const reference of referencesOf(skill.body)) {
      if (!(await exists(skill.name, reference))) {
        findings.push({
          kind: 'stale-skill-reference',
          subject: skill.name,
          detail: `references "${reference}", which does not exist in the skill directory`,
        })
      }
    }
  }
  return findings
}

/** Rough token estimate for mixed CJK/Latin text: CJK characters count as one token each, everything else as one per four characters. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}
