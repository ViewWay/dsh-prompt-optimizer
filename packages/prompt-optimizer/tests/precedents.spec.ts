/** Adoption feedback: same-domain precedents recorded from adopted reports and referenced by later rounds. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import PromptOptimizer from '../src/index.ts'
import type { Config, PromptOptimizerLlmRequestEventData } from '../src/index.ts'
import { OPTIMIZED_MARKER, CHANGES_MARKER, AC_MARKER } from '../src/meta-prompt.ts'

const CONFIG: Config = {
  maxInputBytes: 2_000, maxOutputTokens: 64, timeoutMs: 1_000, verifyTimeoutMs: 2_000,
  domainPriors: true, skillAware: false, skipCheck: false, metrics: true, precedents: true,
}

function envelope(optimized: string): StreamChunk[] {
  const text = [OPTIMIZED_MARKER, optimized, CHANGES_MARKER, '- 补充了约束', AC_MARKER, '- 脚本存在 `ls script.sh`'].join('\n')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Adapter answering every round with one fixed envelope. */
class FixedAdapter extends LlmAdapter {
  constructor(private readonly optimized: string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield * envelope(this.optimized)
  }
}

async function withPrecedents(config: Partial<Config> = {}): Promise<{
  ctx: Context
  sessionId: SessionId
  precedents: Map<string, { id: string; createdAt: string; domain: string; text: string; judgeTotal?: number }>
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], new FixedAdapter('优化后'))
  const precedents = new Map<string, { id: string; createdAt: string; domain: string; text: string; judgeTotal?: number }>()
  const tables = new Map([['precedents', precedents]])
  ctx.provide('storageDomain', {
    open: async () => ({
      table: (name: string) => {
        const table = tables.get(name) ?? new Map()
        tables.set(name, table as never)
        return {
          get: (key: string) => (table as Map<string, unknown>).get(key),
          put: async (key: string, value: unknown) => { (table as Map<string, unknown>).set(key, value) },
          delete: async (key: string) => { (table as Map<string, unknown>).delete(key) },
          entries: () => (table as Map<string, unknown>).entries(),
        }
      },
    }),
  } as never)
  await ctx.plugin(PromptOptimizer, { ...CONFIG, ...config })
  const session = ctx.sessions.create(SessionId('precedent-session'))
  session.append('request/header', {
    header: { config: { provider: 'current-route', model: 'current-model' } },
    reason: 'initial',
  })
  return { ctx, sessionId: session.id, precedents }
}

const I2C_DRAFT = '配置 i2c 传感器并 dump 寄存器表'

/** First user-input text of every committed llm-request record for one session, oldest first. */
function roundInputs(ctx: Context, sessionId: SessionId): string[] {
  return ctx.sessions.get(sessionId)!.snapshotEvents().flatMap(event => {
    const record = pluginRecordOf(event)
    if (record?.type !== 'plugin:prompt-optimizer/llm-request') return []
    const data = record.data as PromptOptimizerLlmRequestEventData
    return [data.messages[0]?.content[0]?.type === 'text' ? data.messages[0]!.content[0].text : '']
  })
}

describe('precedent recording', () => {
  it('records an adopted report with precedent materials under the draft domain', async () => {
    const { ctx, sessionId, precedents } = await withPrecedents()
    await ctx.promptOptimizer.reportMetric(
      {
        sessionId, kind: 'adopted', provider: 'current-route', model: 'current-model',
        precedent: { draft: I2C_DRAFT, optimizedText: 'i2c 先例规格', judgeTotal: 27 },
      },
      new AbortController().signal,
    )
    expect([...precedents.values()]).toHaveLength(1)
    expect([...precedents.values()][0]).toMatchObject({ domain: 'embedded', text: 'i2c 先例规格', judgeTotal: 27 })
  })

  it('rejects precedent materials on non-adopted kinds and blank texts', async () => {
    const { ctx, sessionId } = await withPrecedents()
    await expect(ctx.promptOptimizer.reportMetric(
      {
        sessionId, kind: 'rejected', provider: 'current-route', model: 'current-model',
        precedent: { draft: I2C_DRAFT, optimizedText: 'x' },
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_METRIC_PRECEDENT' })
    await expect(ctx.promptOptimizer.reportMetric(
      {
        sessionId, kind: 'adopted', provider: 'current-route', model: 'current-model',
        precedent: { draft: '  ', optimizedText: 'x' },
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_METRIC_PRECEDENT' })
  })

  it('keeps only the best three precedents per domain, ranked by judge total then recency', async () => {
    const { ctx, sessionId, precedents } = await withPrecedents()
    for (const [text, total] of [['甲', 20], ['乙', 28], ['丙', undefined], ['丁', 25]] as const) {
      await ctx.promptOptimizer.reportMetric(
        {
          sessionId, kind: 'adopted', provider: 'current-route', model: 'current-model',
          precedent: { draft: I2C_DRAFT, optimizedText: text, ...(total !== undefined ? { judgeTotal: total } : {}) },
        },
        new AbortController().signal,
      )
    }
    const kept = [...precedents.values()].map(row => row.text).sort()
    // 乙(28) > 丁(25) > 甲(20); 丙 carries no judge total and ranks last, so it is dropped.
    expect(kept).toEqual(['丁', '乙', '甲'])
  })

  it('stores nothing when precedents is off', async () => {
    const { ctx, sessionId, precedents } = await withPrecedents({ precedents: false })
    await ctx.promptOptimizer.reportMetric(
      {
        sessionId, kind: 'adopted', provider: 'current-route', model: 'current-model',
        precedent: { draft: I2C_DRAFT, optimizedText: 'i2c 先例规格' },
      },
      new AbortController().signal,
    )
    expect(precedents.size).toBe(0)
  })
})

describe('precedent injection', () => {
  it('injects the best same-domain precedent into a later round and stays silent for other domains and local-small routes', async () => {
    const { ctx, sessionId } = await withPrecedents()
    await ctx.promptOptimizer.reportMetric(
      {
        sessionId, kind: 'adopted', provider: 'current-route', model: 'current-model',
        precedent: { draft: I2C_DRAFT, optimizedText: 'i2c 先例规格', judgeTotal: 24 },
      },
      new AbortController().signal,
    )
    await ctx.promptOptimizer.optimize({ sessionId, text: I2C_DRAFT }, new AbortController().signal)
    expect(roundInputs(ctx, sessionId)[0]).toContain('i2c 先例规格')

    // A different domain holds no precedent, so its round carries no block.
    const session2 = ctx.sessions.create(SessionId('other-domain'))
    session2.append('request/header', {
      header: { config: { provider: 'current-route', model: 'current-model' } },
      reason: 'initial',
    })
    await ctx.promptOptimizer.optimize({ sessionId: session2.id, text: '帮我写前端页面组件' }, new AbortController().signal)
    expect(roundInputs(ctx, session2.id)[0]).not.toContain('先例规格')

    // A local-small route never carries the block: the tier cannot spare the context.
    ctx.llm.registerAdapter(['ollama'], new FixedAdapter('本地规格'))
    const session3 = ctx.sessions.create(SessionId('local-session'))
    session3.append('request/header', {
      header: { config: { provider: 'ollama', model: 'qwen2.5:7b' } },
      reason: 'initial',
    })
    await ctx.promptOptimizer.optimize({ sessionId: session3.id, text: I2C_DRAFT }, new AbortController().signal)
    expect(roundInputs(ctx, session3.id)[0]).not.toContain('先例规格')
  })

  it('injects nothing when precedents is off', async () => {
    const { ctx, sessionId } = await withPrecedents({ precedents: false })
    await ctx.promptOptimizer.reportMetric(
      {
        sessionId, kind: 'adopted', provider: 'current-route', model: 'current-model',
        precedent: { draft: I2C_DRAFT, optimizedText: 'i2c 先例规格' },
      },
      new AbortController().signal,
    )
    await ctx.promptOptimizer.optimize({ sessionId, text: I2C_DRAFT }, new AbortController().signal)
    expect(roundInputs(ctx, sessionId)[0]).not.toContain('先例规格')
  })
})
