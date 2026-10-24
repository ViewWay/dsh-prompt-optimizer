/** Deterministic skill-hint selection over registry summaries. */
import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { digestOf, enrichSkillHint, selectSkillHints, skillParametersOf, sourceLabelOf } from '../src/skills.ts'

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

  it('bridges Chinese draft terms to English-described skills through the gloss', () => {
    const hints = selectSkillHints('帮我做一个登录页面，要求响应式布局', [
      summary({ name: 'frontend-design', description: 'Guidance for intentional visual design when building new UI or reshaping an existing one.' }),
      summary({ name: 'tdd', description: 'Test-driven development with a red-green-refactor loop.' }),
    ])
    expect(hints.map(hint => hint.name)).toEqual(['frontend-design'])
  })

  it('bridges English drafts to Chinese-described skills through the gloss', () => {
    const hints = selectSkillHints('generate Chinese comments for the firmware source files', [
      summary({ name: 'lucas-annotation', description: '为嵌入式 C/C++ 源码生成、补充、修订或审查可被 Doxygen 识别的简体中文注释。' }),
      summary({ name: 'benchmark-runner', description: 'Runs performance benchmarks.' }),
    ])
    expect(hints.map(hint => hint.name)).toEqual(['lucas-annotation'])
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

  it('labels each hint with the coarse origin of its source', () => {
    const hints = selectSkillHints('run the pre-push checks', [
      summary({ name: 'dsh-pre-push-checks', description: 'Run the repository check suite before pushing.', source: 'project-dsh' }),
    ])
    expect(hints[0]!.sourceLabel).toBe('project')
  })
})

describe('sourceLabelOf', () => {
  it('buckets discovery sources into coarse origins', () => {
    expect(sourceLabelOf('project-dsh')).toBe('project')
    expect(sourceLabelOf('project-agents')).toBe('project')
    expect(sourceLabelOf('user-dsh')).toBe('user')
    expect(sourceLabelOf('user-agents')).toBe('user')
    expect(sourceLabelOf('bundled')).toBe('bundled')
    expect(sourceLabelOf('runtime')).toBe('runtime')
    expect(sourceLabelOf('custom')).toBe('custom')
    expect(sourceLabelOf('marketplace-x')).toBe('custom')
  })
})

describe('skillParametersOf', () => {
  it('parses object-array, string-array, and record conventions', () => {
    expect(skillParametersOf({ metadata: { parameters: [{ name: 'env', description: '目标环境' }, { name: 'region', desc: '部署区域' }] } }))
      .toEqual([{ name: 'env', description: '目标环境' }, { name: 'region', description: '部署区域' }])
    expect(skillParametersOf({ metadata: { parameters: ['verbose'] } })).toEqual([{ name: 'verbose', description: '' }])
    expect(skillParametersOf({ metadata: { parameters: { env: '目标环境' } } })).toEqual([{ name: 'env', description: '目标环境' }])
  })

  it('yields nothing for absent or unrecognized shapes', () => {
    expect(skillParametersOf({ metadata: {} })).toEqual([])
    expect(skillParametersOf({})).toEqual([])
    expect(skillParametersOf({ metadata: { parameters: 'env' } })).toEqual([])
    expect(skillParametersOf({ metadata: { parameters: [{ description: '无名字' }] } })).toEqual([])
  })

  it('clips long parameter descriptions and caps the descriptor count', () => {
    const parsed = skillParametersOf({ metadata: { parameters: [
      { name: 'a', description: 'x'.repeat(40) },
      { name: 'b', description: 'b' },
      { name: 'c', description: 'c' },
      { name: 'd', description: 'd' },
      { name: 'e', description: 'e' },
    ] } })
    expect(parsed).toHaveLength(4)
    expect(parsed[0]!.description).toBe(`${'x'.repeat(24)}…`)
  })
})

describe('digestOf and enrichSkillHint', () => {
  it('flattens and clips a body into one digest line', () => {
    expect(digestOf('# Title\n\nBody  line.')).toBe('# Title Body line.')
    expect(digestOf('a'.repeat(250))).toBe(`${'a'.repeat(200)}…`)
    expect(digestOf('   ')).toBe('')
  })

  it('enriches a hint with parameters and digest, omitting empty ones', () => {
    const hint = { name: 'deploy', description: 'Deploy.', sourceLabel: 'project' }
    expect(enrichSkillHint(hint, { content: 'Build then ship.', metadata: { parameters: [{ name: 'env', description: '环境' }] } }))
      .toEqual({ ...hint, parameters: [{ name: 'env', description: '环境' }], detail: 'Build then ship.' })
    expect(enrichSkillHint(hint, { content: '' })).toEqual(hint)
  })
})
