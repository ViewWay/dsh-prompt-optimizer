/** Meta-prompt framing, domain priors, and envelope parsing. */
import { describe, expect, it } from 'vitest'
import {
  AC_MARKER,
  CHANGES_MARKER,
  OPTIMIZED_MARKER,
  critiqueSystemPrompt,
  critiqueUserInput,
  detectDomainPriors,
  optimizerSystemPrompt,
  optimizerSystemPromptForSystem,
  optimizerUserInput,
  parseOptimizerResponse,
  roleEvolutionSystemPrompt,
  roleEvolutionUserInput,
} from '../src/meta-prompt.ts'
import type { PromptRoleRef } from '../src/meta-prompt.ts'
import type { SkillHint } from '../src/skills.ts'

describe('optimizerSystemPrompt', () => {
  it('declares the exact response envelope', () => {
    const prompt = optimizerSystemPrompt()
    expect(prompt).toContain(OPTIMIZED_MARKER)
    expect(prompt).toContain(CHANGES_MARKER)
    expect(prompt).toContain(AC_MARKER)
    expect(prompt.indexOf(OPTIMIZED_MARKER)).toBeLessThan(prompt.indexOf(CHANGES_MARKER))
    expect(prompt.indexOf(CHANGES_MARKER)).toBeLessThan(prompt.indexOf(AC_MARKER))
    expect(prompt).not.toContain('Domain guidance')
  })

  it('appends supplied domain guidance as a dedicated section', () => {
    const prompt = optimizerSystemPrompt({ domainPriors: ['Ask for the chip model.'] })
    expect(prompt).toContain('Domain guidance for this draft')
    expect(prompt).toContain('- Ask for the chip model.')
    expect(prompt.indexOf('Domain guidance')).toBeLessThan(prompt.indexOf('Respond with exactly'))
  })
})

describe('detectDomainPriors', () => {
  it('returns embedded guidance for a bilingual hardware draft', () => {
    const priors = detectDomainPriors('帮我写单片机固件，读一下 I2C 寄存器')
    expect(priors.length).toBeGreaterThan(0)
    expect(priors.some(line => line.includes('chip or module model'))).toBe(true)
  })

  it('returns no guidance for a generic draft', () => {
    expect(detectDomainPriors('帮我写个脚本 处理日志')).toEqual([])
  })

  it('is deterministic and caps the joined domains', () => {
    const text = '用 pytorch 训练模型，数据库接口部署到服务器'
    expect(detectDomainPriors(text)).toEqual(detectDomainPriors(text))
    expect(detectDomainPriors(text).length).toBeLessThanOrEqual(8)
  })
})

describe('optimizerUserInput', () => {
  it('frames a first round without the rejected-results block', () => {
    const input = optimizerUserInput('fix the bug', [])
    expect(input).not.toContain('rejected')
    expect(input).toContain('Optimize the following draft prompt:')
    expect(input.endsWith('fix the bug')).toBe(true)
  })

  it('quotes rejected results in order before the draft', () => {
    const input = optimizerUserInput('draft', ['first', 'second'])
    const firstIndex = input.indexOf('first')
    const secondIndex = input.indexOf('second')
    const draftIndex = input.indexOf('draft')
    expect(firstIndex).toBeGreaterThan(-1)
    expect(firstIndex).toBeLessThan(secondIndex)
    expect(secondIndex).toBeLessThan(draftIndex)
    expect(input).toContain('meaningfully different revision')
  })
})

describe('roleEvolutionSystemPrompt', () => {
  it('pins the maintainer role and the definition-file output contract', () => {
    const prompt = roleEvolutionSystemPrompt()
    expect(prompt).toContain('You are a role definition maintainer.')
    expect(prompt).toContain('# 中文名（English）')
    expect(prompt).toContain('no code fences')
    expect(prompt).toContain('Output only the definition file itself')
  })

  it('pins the seven-section structure, language, and length bounds', () => {
    const prompt = roleEvolutionSystemPrompt()
    for (const section of ['角色设定', '背景', '技能', '工作方式', '输出格式', '回答风格', '回答限制']) {
      expect(prompt).toContain(`## ${section}`)
    }
    expect(prompt.indexOf('## 角色设定')).toBeLessThan(prompt.indexOf('## 回答限制'))
    expect(prompt).toContain('250 and 900')
    expect(prompt).toContain('in Chinese')
  })

  it('forbids invented experience and tool or command names', () => {
    const prompt = roleEvolutionSystemPrompt()
    expect(prompt).toContain('never invent experiences')
    expect(prompt).toContain('Never mention any tool name or command name')
  })
})

describe('roleEvolutionUserInput', () => {
  it('frames the three materials in definition, draft, optimized order', () => {
    const input = roleEvolutionUserInput('# 代码评审员\n定义', '草稿', '优化结果')
    const definitionIndex = input.indexOf('# 代码评审员')
    const draftIndex = input.indexOf('草稿')
    const optimizedIndex = input.indexOf('优化结果')
    expect(definitionIndex).toBeGreaterThan(-1)
    expect(definitionIndex).toBeLessThan(draftIndex)
    expect(draftIndex).toBeLessThan(optimizedIndex)
    expect(input).toContain('--- current role definition ---')
    expect(input).toContain('--- draft the round optimized ---')
    expect(input).toContain('--- optimized result ---')
    expect(input.endsWith('Output the complete rewritten role definition file only.')).toBe(true)
  })
})

describe('parseOptimizerResponse', () => {
  it('extracts the optimized text and strips bullet markers from changes', () => {
    const parsed = parseOptimizerResponse(
      `noise\n${OPTIMIZED_MARKER}\n  rewritten prompt  \n${CHANGES_MARKER}\n- first change\n* second change\n\n- third change\n`,
    )
    expect(parsed.optimizedText).toBe('rewritten prompt')
    expect(parsed.changes).toEqual(['first change', 'second change', 'third change'])
    expect(parsed.acceptance).toEqual([])
  })

  it('splits acceptance criteria into mechanical and llm kinds', () => {
    const parsed = parseOptimizerResponse(
      `${OPTIMIZED_MARKER}\nrewritten\n${CHANGES_MARKER}\n- change\n${AC_MARKER}\n- 脚本可运行 \`pnpm test\`\n- 与用户确认了日志格式`,
    )
    expect(parsed.acceptance).toEqual([
      { text: '脚本可运行', kind: 'mechanical', commandTemplate: 'pnpm test' },
      { text: '与用户确认了日志格式', kind: 'llm' },
    ])
  })

  it('caps the kept acceptance list at four criteria', () => {
    const lines = Array.from({ length: 6 }, (_unused, index) => `- criterion ${String(index + 1)}`).join('\n')
    const parsed = parseOptimizerResponse(`${OPTIMIZED_MARKER}\nrewritten\n${CHANGES_MARKER}\n- change\n${AC_MARKER}\n${lines}`)
    expect(parsed.acceptance).toHaveLength(4)
    expect(parsed.acceptance[3]?.text).toBe('criterion 4')
  })

  it('treats an unclosed backtick as a judgment-only criterion', () => {
    const parsed = parseOptimizerResponse(`${OPTIMIZED_MARKER}\nrewritten\n${AC_MARKER}\n- runs \`pnpm test`)
    expect(parsed.acceptance).toEqual([{ text: 'runs `pnpm test', kind: 'llm' }])
  })

  it('treats a response without the optimized marker as pure rewritten text', () => {
    const parsed = parseOptimizerResponse('just the rewrite')
    expect(parsed.optimizedText).toBe('just the rewrite')
    expect(parsed.changes).toEqual([])
    expect(parsed.acceptance).toEqual([])
  })

  it('caps the kept change list at six bullets', () => {
    const changes = Array.from({ length: 9 }, (_unused, index) => `- change ${String(index + 1)}`).join('\n')
    const parsed = parseOptimizerResponse(`${OPTIMIZED_MARKER}\nrewritten\n${CHANGES_MARKER}\n${changes}`)
    expect(parsed.changes).toHaveLength(6)
    expect(parsed.changes[5]).toBe('change 6')
  })

  it('returns an empty optimized text only for empty content', () => {
    expect(parseOptimizerResponse(`   \n${CHANGES_MARKER}\n- only changes`).optimizedText).toBe('')
  })
})

describe('system-target prompts', () => {
  it('frames the rewrite as standing instructions, distinct from the draft variant', () => {
    const system = optimizerSystemPromptForSystem()
    expect(system).toContain('draft SYSTEM prompt')
    expect(system).toContain('timeless and self-contained')
    expect(system).toContain(OPTIMIZED_MARKER)
    expect(system).not.toBe(optimizerSystemPrompt())
  })

  it('injects domain guidance the same way as the draft variant', () => {
    const priors = detectDomainPriors('为单片机 uart 驱动写固件')
    expect(optimizerSystemPromptForSystem({ domainPriors: priors })).toContain('Domain guidance for this draft')
    expect(critiqueSystemPrompt({ domainPriors: priors })).toContain('Domain guidance for this draft')
  })

  it('frames the critique round as an audit with a complete revision', () => {
    const critique = critiqueSystemPrompt()
    expect(critique).toContain('critique round')
    expect(critique).toContain('COMPLETE improved system prompt')
    expect(critique).toContain(OPTIMIZED_MARKER)
    expect(critique).toContain(CHANGES_MARKER)
    expect(critique).toContain(AC_MARKER)
  })

  it('carries the original draft and the first rewrite in the critique input', () => {
    const input = critiqueUserInput('原始系统提示', '第一版系统提示')
    expect(input).toContain('--- original draft ---')
    expect(input).toContain('原始系统提示')
    expect(input).toContain('--- first rewrite ---')
    expect(input).toContain('第一版系统提示')
  })
})

describe('role conditioning', () => {
  const role: PromptRoleRef = { id: 'imp-code-reviewer', name: '代码评审员', text: '你是一名代码评审员。' }

  it('appends the framed role definition to every round prompt', () => {
    const draft = optimizerSystemPrompt({ role })
    expect(draft).toContain('Professional role for this round: 代码评审员 (imp-code-reviewer)')
    expect(draft).toContain('addressed to this specialist')
    expect(draft).toContain('--- role definition start ---\n你是一名代码评审员。\n--- role definition end ---')
    const system = optimizerSystemPromptForSystem({ role })
    expect(system).toContain('turn the agent into')
    expect(system).toContain('你是一名代码评审员。')
    expect(critiqueSystemPrompt({ role })).toContain('你是一名代码评审员。')
  })

  it('omits the role block entirely without a role', () => {
    expect(optimizerSystemPrompt()).not.toContain('Professional role for this round')
    expect(optimizerSystemPromptForSystem()).not.toContain('role definition')
    expect(critiqueSystemPrompt()).not.toContain('role definition')
  })
})

describe('skill conditioning', () => {
  const hints: readonly SkillHint[] = [
    { name: 'dsh-pre-push-checks', description: 'Run the repository pre-push check suite before pushing.', sourceLabel: 'runtime' },
  ]

  it('appends the exact-name skill block to every round prompt', () => {
    const draft = optimizerSystemPrompt({ skills: hints })
    expect(draft).toContain('Installed skills for this agent that match the draft')
    expect(draft).toContain('weave it into the rewrite: name the skill by its exact name at the exact step')
    expect(draft).toContain('never invent, rename, or guess skill names')
    expect(draft).toContain('- dsh-pre-push-checks — Run the repository pre-push check suite before pushing. [runtime]')
    expect(draft.indexOf('Installed skills')).toBeLessThan(draft.indexOf('Respond with exactly'))
    expect(optimizerSystemPromptForSystem({ skills: hints })).toContain('dsh-pre-push-checks')
    expect(critiqueSystemPrompt({ skills: hints })).toContain('dsh-pre-push-checks')
  })

  it('renders origin labels, params segments, and deep-read digests', () => {
    const enriched: readonly SkillHint[] = [{
      name: 'deploy-service',
      description: 'Deploy the service.',
      sourceLabel: 'project',
      parameters: [
        { name: 'env', description: '目标环境' },
        { name: 'region', description: '部署区域' },
      ],
      detail: 'Build, then ship to the target environment.',
    }]
    const prompt = optimizerSystemPrompt({ skills: enriched })
    expect(prompt).toContain('- deploy-service — Deploy the service. [project]; params: env=目标环境, region=部署区域')
    expect(prompt).toContain('never invent parameters')
    expect(prompt).toContain('    Build, then ship to the target environment.')
  })

  it('clips the params segment at eighty characters', () => {
    const capped: readonly SkillHint[] = [{
      name: 'deploy-service',
      description: 'Deploy.',
      sourceLabel: 'user',
      parameters: [
        { name: 'alpha', description: 'x'.repeat(24) },
        { name: 'beta', description: 'y'.repeat(24) },
        { name: 'gamma', description: 'z'.repeat(24) },
      ],
    }]
    const line = optimizerSystemPrompt({ skills: capped })
      .split('\n').find(text => text.startsWith('- deploy-service'))
    expect(line).toBeDefined()
    const segment = line!.slice(line!.indexOf('params:'))
    expect(segment.length).toBeLessThanOrEqual(81)
    expect(segment.endsWith('…')).toBe(true)
  })

  it('omits the skill block entirely without hints', () => {
    expect(optimizerSystemPrompt()).not.toContain('Installed skills')
    expect(optimizerSystemPromptForSystem()).not.toContain('Installed skills')
    expect(critiqueSystemPrompt()).not.toContain('Installed skills')
  })
})

describe('language conditioning', () => {
  it('pins the output language across rules, bullets, and criteria when one is requested', () => {
    const prompt = optimizerSystemPrompt({ language: '中文' })
    expect(prompt).toContain('1. Write the rewrite in 中文.')
    expect(prompt).toContain('one short bullet in 中文, at most 6 bullets.')
    expect(prompt).toContain('must satisfy, in 中文.')
    expect(prompt).not.toContain("the draft's language")
    expect(optimizerSystemPromptForSystem({ language: 'English' })).toContain('1. Write the rewrite in English.')
    expect(critiqueSystemPrompt({ language: '中文' })).toContain('1. Write the revision in 中文.')
  })

  it('keeps the draft-language rules untouched without a language', () => {
    expect(optimizerSystemPrompt()).toContain("1. Keep the draft's language.")
    expect(optimizerSystemPrompt()).toContain("in the draft's language")
    expect(optimizerSystemPromptForSystem()).toContain("in the draft's language")
    expect(critiqueSystemPrompt()).toContain("1. Keep the rewrite's language.")
  })
})
