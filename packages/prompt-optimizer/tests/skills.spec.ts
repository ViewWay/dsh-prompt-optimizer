/** Deterministic skill-hint selection over registry summaries. */
import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { selectSkillHints } from '../src/skills.ts'

/**
 * Build one registry summary with defaults that permit every surface.
 * @param overrides - fields the case varies.
 * @returns a complete summary for {@link selectSkillHints}.
 */
function summary(overrides: Pick<SkillSummary, 'name' | 'description'> & Partial<SkillSummary>): SkillSummary {
  return {
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: 'runtime',
    ...overrides,
  }
}

describe('selectSkillHints', () => {
  it('selects skills by name overlap, highest score first', () => {
    const hints = selectSkillHints('push 前先跑 pre-push 检查和 benchmark', [
      summary({ name: 'benchmark-runner', description: 'Runs performance benchmarks.' }),
      summary({ name: 'dsh-pre-push-checks', description: 'Run the repository check suite before pushing.' }),
    ])
    expect(hints.map(hint => hint.name)).toEqual(['dsh-pre-push-checks', 'benchmark-runner'])
  })

  it('never hints a user-invocable-only skill', () => {
    const hints = selectSkillHints('run the pre-push checks', [
      summary({ name: 'dsh-pre-push-checks', description: 'checks', invocation: { modelInvocable: false, userInvocable: true } }),
    ])
    expect(hints).toEqual([])
  })

  it('returns empty for a non-matching or empty context', () => {
    const skills = [summary({ name: 'dsh-pre-push-checks', description: 'Run the repository check suite.' })]
    expect(selectSkillHints('帮我写个脚本 处理日志', skills)).toEqual([])
    expect(selectSkillHints('', skills)).toEqual([])
  })

  it('clips long descriptions with an explicit ellipsis', () => {
    const long = 'a'.repeat(200)
    const hints = selectSkillHints('run the pre-push checks', [
      summary({ name: 'dsh-pre-push-checks', description: long }),
    ])
    expect(hints[0]?.description).toBe(`${'a'.repeat(160)}…`)
  })

  it('breaks score ties by name order', () => {
    const hints = selectSkillHints('run the checks', [
      summary({ name: 'zeta-checks', description: 'run checks' }),
      summary({ name: 'alpha-checks', description: 'run checks' }),
    ])
    expect(hints.map(hint => hint.name)).toEqual(['alpha-checks', 'zeta-checks'])
  })
})
