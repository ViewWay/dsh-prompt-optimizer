/** Evidence pack: rewrite-plus-judge comparison over the bundled samples, with metric rows. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import PromptOptimizer from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { EVAL_SAMPLES, selectEvalSamples } from '../src/eval-pack.ts'

const CONFIG: Config = {
  maxInputBytes: 2_000, maxOutputTokens: 512, timeoutMs: 1_000, verifyTimeoutMs: 2_000,
  domainPriors: false, skillAware: false, skipCheck: false, metrics: true, precedents: false,
}

/**
 * Adapter serving a fixed script: every odd round returns a rewrite envelope,
 * every even round a judge block scoring A(raw)=6/6/6 and B(rewrite)=8/7/9.
 */
class EvalAdapter extends LlmAdapter {
  private round = 0

  constructor(private readonly judgeFails = false) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options
    this.round += 1
    const text = this.round % 2 === 1
      ? '<<<OPTIMIZED_PROMPT>>>\n优化后的规格\n<<<CHANGES>>>\n- 补充了约束\n<<<AC>>>\n- 脚本存在 `ls script.sh`'
      : this.judgeFails
        ? '评审轮不可读的输出'
        : '<<<JUDGE>>>\nA: faithfulness=6 completeness=6 clarity=6 — raw\nB: faithfulness=8 completeness=7 clarity=9 — rewrite\nBEST: B'
    yield * [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as never as readonly StreamChunk[]
  }
}

async function withEvalPack(judgeFails = false): Promise<{ ctx: Context; sessionId: SessionId }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], new EvalAdapter(judgeFails))
  const tables = new Map<string, Map<string, unknown>>()
  ctx.provide('storageDomain', {
    open: async () => ({
      table: (name: string) => {
        const table = tables.get(name) ?? new Map()
        tables.set(name, table)
        return {
          get: (key: string) => table.get(key),
          put: async (key: string, value: unknown) => { table.set(key, value) },
          delete: async (key: string) => table.delete(key),
          entries: () => table.entries(),
        }
      },
    }),
  } as never)
  await ctx.plugin(PromptOptimizer, CONFIG)
  const session = ctx.sessions.create(SessionId('eval-session'))
  session.append('request/header', {
    header: { config: { provider: 'current-route', model: 'current-model' } },
    reason: 'initial',
  })
  return { ctx, sessionId: session.id }
}

describe('the bundled sample pack', () => {
  it('interleaves domains so every prefix covers as many domains as it can', () => {
    expect(EVAL_SAMPLES.length).toBeGreaterThanOrEqual(10)
    const firstFive = selectEvalSamples(5).map(sample => sample.domain)
    expect(new Set(firstFive).size).toBe(5)
    expect(selectEvalSamples(3)).toEqual(EVAL_SAMPLES.slice(0, 3))
  })
})

describe('PromptOptimizer.runEvalPack', () => {
  it('judges every sample raw against rewritten and records run and win metrics', async () => {
    const { ctx, sessionId } = await withEvalPack()

    const result = await ctx.promptOptimizer.runEvalPack({ sessionId, count: 2 }, new AbortController().signal)

    expect(result.samples).toHaveLength(2)
    expect(result.samples[0]).toMatchObject({ id: 'embedded-uart', domain: 'embedded', rawTotal: 18, optimizedTotal: 24, improved: true })
    expect(result.improved).toBe(2)
    expect(result.judged).toBe(2)
    expect(result.provider).toBe('current-route')

    const summary = await ctx.promptOptimizer.listMetrics(new AbortController().signal)
    expect(summary.evalRuns).toBe(1)
    expect(summary.evalWins).toBe(2)
  })

  it('degrades a sample to unscored when its judge round is unreadable', async () => {
    const { ctx, sessionId } = await withEvalPack(true)

    const result = await ctx.promptOptimizer.runEvalPack({ sessionId, count: 1 }, new AbortController().signal)

    expect(result.samples[0]).toMatchObject({ id: 'embedded-uart', improved: false })
    expect(result.samples[0]!.rawTotal).toBeUndefined()
    expect(result.samples[0]!.optimizedTotal).toBeUndefined()
    expect(result.improved).toBe(0)
    expect(result.judged).toBe(0)
  })

  it('rejects an out-of-range count before any dispatch, and a missing session fails at route resolution', async () => {
    const { ctx, sessionId } = await withEvalPack()
    await expect(ctx.promptOptimizer.runEvalPack({ sessionId, count: 7 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_EVAL_COUNT' })
    await expect(ctx.promptOptimizer.runEvalPack({ sessionId, count: 0 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_EVAL_COUNT' })
    await expect(ctx.promptOptimizer.runEvalPack({ sessionId: SessionId('gone') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_NO_ROUTE' })
  })
})
