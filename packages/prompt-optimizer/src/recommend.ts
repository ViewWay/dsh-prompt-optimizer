/**
 * Deterministic context-to-role scoring: keyword overlap between the request
 * context (draft plus queued inbox text) and each role definition. No model
 * call — the same context always yields the same ranking, so the
 * recommendation is auditable and free.
 * @module dsh-prompt-optimizer
 */

import type { PromptRoleRef } from './meta-prompt.ts'
import type { PromptRoleRecommendation } from './types.ts'

/** Most recommendations one request returns. */
const MAX_RECOMMENDATIONS = 3
/** Minimum score a role needs before it is worth surfacing. */
const MIN_SCORE = 2
/** Longest CJK context run considered; longer runs carry no extra signal. */
const MAX_CONTEXT_CHARS = 4000

/** One scored role during a ranking pass. */
interface ScoredRole {
  readonly ref: PromptRoleRef
  readonly score: number
  readonly matched: readonly string[]
}

/**
 * Tokenize text for matching: lowercase Latin/ASCII words of two or more
 * characters, plus every bigram of each CJK run (single CJK characters are
 * too ambiguous to score on).
 * @param text - arbitrary context or definition text.
 * @returns the distinct tokens: Latin words first, then CJK bigrams, each in
 * first-appearance order.
 */
export function tokenize(text: string): readonly string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const push = (token: string): void => {
    if (token !== '' && !seen.has(token)) {
      seen.add(token)
      tokens.push(token)
    }
  }
  const clipped = text.slice(0, MAX_CONTEXT_CHARS)
  for (const word of clipped.matchAll(/[A-Za-z][A-Za-z0-9_-]+/g)) {
    push(word[0].toLowerCase())
  }
  for (const run of clipped.matchAll(/[\u3400-\u9fff]+/g)) {
    const chars = run[0]
    if (chars.length === 1) {
      push(chars)
      continue
    }
    for (let index = 0; index + 1 < chars.length; index += 1) {
      push(chars.slice(index, index + 2))
    }
  }
  return tokens
}

/**
 * Score every role against the context tokens: a token matching the role's
 * slug or display name counts three, one in the definition body counts one.
 * Deterministic: equal scores break by slug order.
 * @param context - complete context text (draft plus queued messages).
 * @param roles - every loaded role definition.
 * @returns the top roles at or above {@link MIN_SCORE}, highest score first.
 */
export function recommendRoles(context: string, roles: readonly PromptRoleRef[]): readonly PromptRoleRecommendation[] {
  const tokens = tokenize(context)
  if (tokens.length === 0 || roles.length === 0) return []
  const scored: ScoredRole[] = []
  for (const ref of roles) {
    const identity = `${ref.id} ${ref.name}`.toLowerCase()
    const body = ref.text.toLowerCase()
    let score = 0
    const matched: string[] = []
    for (const token of tokens) {
      const weight = identity.includes(token) ? 3 : body.includes(token) ? 1 : 0
      if (weight > 0) {
        score += weight
        matched.push(token)
      }
    }
    if (score >= MIN_SCORE) scored.push({ ref, score, matched })
  }
  return scored
    .sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id))
    .slice(0, MAX_RECOMMENDATIONS)
    .map(entry => ({ id: entry.ref.id, name: entry.ref.name, score: entry.score, matched: entry.matched.slice(0, 5) }))
}
