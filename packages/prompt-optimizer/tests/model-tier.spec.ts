/** Route-tier classification, tier guidance, and the decline-to-optimize precheck. */
import { describe, expect, it } from 'vitest'
import { classifyModelTier, declineToOptimize, modelTierBlock } from '../src/model-tier.ts'
import type { DeclineCheckInput } from '../src/model-tier.ts'

describe('classifyModelTier', () => {
  it('marks reasoning families from the model id alone', () => {
    expect(classifyModelTier('dsh', 'deepseek-reasoner')).toBe('reasoning')
    expect(classifyModelTier('dsh', 'deepseek-r1')).toBe('reasoning')
    expect(classifyModelTier('openai', 'o1-mini')).toBe('reasoning')
    expect(classifyModelTier('openai', 'o3-mini')).toBe('reasoning')
    expect(classifyModelTier('openai', 'o4-mini')).toBe('reasoning')
    expect(classifyModelTier('dashscope', 'qwq-32b')).toBe('reasoning')
    expect(classifyModelTier('some-host', 'glm-4.5-thinking')).toBe('reasoning')
  })

  it('lets a reasoning marker win over a local gateway', () => {
    expect(classifyModelTier('ollama', 'qwq-32b')).toBe('reasoning')
    expect(classifyModelTier('litellm', 'deepseek-r1-distill-llama-8b')).toBe('reasoning')
  })

  it('keeps version digits and unrelated names out of the reasoning tier', () => {
    expect(classifyModelTier('dsh', 'deepseek-chat')).toBe('standard')
    expect(classifyModelTier('openai', 'gpt-4.1')).toBe('standard')
    expect(classifyModelTier('some-host', 'glm-4.7')).toBe('standard')
    expect(classifyModelTier('some-host', 'llama3.1-70b')).toBe('standard')
  })

  it('marks self-hosted gateways as local-small unless the model is hosted', () => {
    expect(classifyModelTier('litellm', 'my-finetune')).toBe('local-small')
    expect(classifyModelTier('vllm', 'qwen2.5-72b')).toBe('local-small')
    expect(classifyModelTier('ollama', 'llama3.3')).toBe('local-small')
    expect(classifyModelTier('litellm', 'gpt-4o')).toBe('standard')
    expect(classifyModelTier('litellm', 'claude-sonnet-4')).toBe('standard')
    expect(classifyModelTier('litellm', 'deepseek-chat')).toBe('standard')
  })

  it('marks small open-weight families by their size suffix without a gateway', () => {
    expect(classifyModelTier('openrouter', 'qwen3-4b')).toBe('local-small')
    expect(classifyModelTier('openrouter', 'gemma-2-9b')).toBe('local-small')
    expect(classifyModelTier('openrouter', 'qwen2.5-72b-instruct')).toBe('standard')
  })
})

describe('modelTierBlock', () => {
  it('guides reasoning and local-small tiers and leaves standard empty', () => {
    const reasoning = modelTierBlock('reasoning').join('\n')
    expect(reasoning).toContain('REASONING model')
    expect(reasoning).toContain('Never add chain-of-thought scaffolding')
    expect(modelTierBlock('local-small').join('\n')).toContain('SMALL LOCAL model')
    expect(modelTierBlock('standard')).toEqual([])
  })
})

describe('declineToOptimize', () => {
  const base: DeclineCheckInput = {
    tier: 'reasoning',
    target: 'draft',
    draft: '帮我把这个函数改成异步的',
    domainPriors: [],
    role: undefined,
    direction: undefined,
    previousAttempts: [],
  }

  it('declines a short clear draft aimed at a reasoning model', () => {
    expect(declineToOptimize(base)).toBe('reasoning-short-clear')
  })

  it('keeps every other shape', () => {
    expect(declineToOptimize({ ...base, tier: 'standard' })).toBeUndefined()
    expect(declineToOptimize({ ...base, tier: 'local-small' })).toBeUndefined()
    expect(declineToOptimize({ ...base, target: 'system' })).toBeUndefined()
    expect(declineToOptimize({ ...base, role: 'code-reviewer' })).toBeUndefined()
    expect(declineToOptimize({ ...base, direction: 'concise' })).toBeUndefined()
    expect(declineToOptimize({ ...base, previousAttempts: ['第一次改写'] })).toBeUndefined()
    expect(declineToOptimize({ ...base, domainPriors: ['Ask for the chip model.'] })).toBeUndefined()
  })

  it('keeps long or already structured drafts', () => {
    expect(declineToOptimize({ ...base, draft: 'x'.repeat(241) })).toBeUndefined()
    expect(declineToOptimize({ ...base, draft: '- 第一步\n- 第二步' })).toBeUndefined()
    expect(declineToOptimize({ ...base, draft: '# 任务\n帮我把这个函数改成异步的' })).toBeUndefined()
    expect(declineToOptimize({ ...base, draft: '运行 ```ls``` 看看输出' })).toBeUndefined()
    expect(declineToOptimize({ ...base, draft: '   ' })).toBeUndefined()
  })
})
