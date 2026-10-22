/** Deterministic context-to-role scoring: tokenization and ranking. */
import { describe, expect, it } from 'vitest'
import { recommendRoles, tokenize } from '../src/recommend.ts'
import type { PromptRoleRef } from '../src/meta-prompt.ts'

const REVIEWER: PromptRoleRef = {
  id: 'imp-code-reviewer',
  name: '代码评审员',
  text: '# 代码评审员\n\n## 角色设定\n你是一名代码评审员，负责审查代码变更。\n## 技能\n缺陷识别、测试审查。',
}
const MECHANICAL: PromptRoleRef = {
  id: 'oc-mechanical-engineer',
  name: '机械工程师',
  text: '# 机械工程师\n结构设计、强度校核、公差配合与材料工艺。',
}

describe('tokenize', () => {
  it('splits Latin words and CJK bigrams, case-folded and distinct', () => {
    expect(tokenize('Rust 并发 Lock rust')).toEqual(['rust', 'lock', '并发'])
  })

  it('keeps a lone CJK character as its own token', () => {
    expect(tokenize('图')).toEqual(['图'])
  })

  it('returns nothing for empty or non-word text', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('，。！')).toEqual([])
  })
})

describe('recommendRoles', () => {
  it('ranks identity matches above body matches', () => {
    const ranked = recommendRoles('帮我评审 code review 代码', [REVIEWER, MECHANICAL])
    expect(ranked[0]).toMatchObject({ id: 'imp-code-reviewer' })
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(3)
    expect(ranked.map(entry => entry.id)).not.toContain('oc-mechanical-engineer')
  })

  it('returns nothing below the score threshold or without tokens', () => {
    expect(recommendRoles('完全无关的天气闲聊', [REVIEWER, MECHANICAL])).toEqual([])
    expect(recommendRoles('', [REVIEWER])).toEqual([])
    expect(recommendRoles('代码', [])).toEqual([])
  })

  it('caps the result at three roles, ties broken by slug order', () => {
    const clones = Array.from({ length: 5 }, (_unused, index): PromptRoleRef => ({
      id: `role-${String(index)}`,
      name: `角色${String(index)}`,
      text: '共享 公共 词汇 上下文',
    }))
    const ranked = recommendRoles('共享 公共 词汇', clones)
    expect(ranked).toHaveLength(3)
    expect(ranked.map(entry => entry.id)).toEqual(['role-0', 'role-1', 'role-2'])
  })
})
