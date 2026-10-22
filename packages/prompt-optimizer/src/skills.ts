/**
 * Deterministic context-to-skill selection for skill-aware optimization:
 * keyword overlap between the request context (draft plus queued inbox text)
 * and each model-invocable skill's routing text. No model call — the same
 * context always yields the same hints, mirroring {@link recommendRoles}.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { tokenize } from './recommend.ts'

/** Most skill hints one optimization round injects. */
const MAX_SKILL_HINTS = 12
/** Minimum score a skill needs before it is worth hinting. */
const MIN_SKILL_SCORE = 2
/** Longest description carried into the meta-prompt, marked when clipped. */
const DESCRIPTION_MAX_CHARS = 160

/** One selected skill hint injected into an optimization system prompt. */
export interface SkillHint {
  /** Exact skill name; the only form the rewrite may reference. */
  readonly name: string
  /** Clipped one-line routing description. */
  readonly description: string
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
 * Score every model-invocable skill against the context tokens: a token
 * matching the skill's name counts three, one in the routing description or
 * `whenToUse` guidance counts one. Deterministic: equal scores break by name
 * order. Skills the model cannot invoke are never hinted, so a hint always
 * names a skill the runtime agent can load.
 * @param context - complete context text (draft plus queued messages).
 * @param skills - every skill the resolved registry listed.
 * @returns the top hints at or above {@link MIN_SKILL_SCORE}, highest score
 * first, each carrying the exact name and a clipped description.
 */
export function selectSkillHints(context: string, skills: readonly SkillSummary[]): readonly SkillHint[] {
  const tokens = tokenize(context)
  if (tokens.length === 0) return []
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
    if (score >= MIN_SKILL_SCORE) {
      scored.push({ hint: { name: skill.name, description: clipDescription(skill.description) }, score })
    }
  }
  return scored
    .sort((left, right) => right.score - left.score || left.hint.name.localeCompare(right.hint.name))
    .slice(0, MAX_SKILL_HINTS)
    .map(entry => entry.hint)
}
