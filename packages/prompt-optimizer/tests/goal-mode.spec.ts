/** Goal mode: acceptance-first interview prompt dispatch and authoritative criteria injection. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import PromptOptimizer from '../src/index.ts'
import type { Config, PromptOptimizerLlmRequestEventData } from '../src/index.ts'
import { OPTIMIZED_MARKER, CHANGES_MARKER, AC_MARKER } from '../src/meta-prompt.ts'

const CONFIG: Config = {
  maxInputBytes: 2_000, maxOutputTokens: 512, timeoutMs: 1_000, verifyTimeoutMs: 2_000,
  domainPriors: true, skillAware: false, skipCheck: false, metrics: false, precedents: false,
}

function questions(): StreamChunk[] {
  const text = '<<<QUESTIONS>>>\nQ: 什么算完成？\n- 脚本零退出\n- 输出两列数据\nQ: 芯片型号？\n- STM32F103'
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function envelope(): StreamChunk[] {
  const text = [OPTIMIZED_MARKER, '规格', CHANGES_MARKER, '- 并入验收', AC_MARKER, '- 脚本零退出 `./run.sh`'].join('\n')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Committed llm-request payloads for one session, oldest first. */
function requests(ctx: Context, sessionId: SessionId): PromptOptimizerLlmRequestEventData[] {
  return ctx.sessions.get(sessionId)!.snapshotEvents().flatMap(event => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:prompt-optimizer/llm-request' ? [record.data as PromptOptimizerLlmRequestEventData] : []
  })
}

async function withGoalMode(): Promise<{ ctx: Context; sessionId: SessionId }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new (class extends LlmAdapter {
    private next = 0

    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model })
    }

    override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield * [questions(), envelope(), envelope()][Math.min(this.next, 2)]!
      this.next += 1
    }
  })()
  ctx.llm.registerAdapter(['current-route'], adapter)
  await ctx.plugin(PromptOptimizer, CONFIG)
  const session = ctx.sessions.create(SessionId('goal-session'))
  session.append('request/header', {
    header: { config: { provider: 'current-route', model: 'current-model' } },
    reason: 'initial',
  })
  return { ctx, sessionId: session.id }
}

describe('goal-mode interview', () => {
  it('dispatches the acceptance-first system prompt on mode goal', async () => {
    const { ctx, sessionId } = await withGoalMode()
    const result = await ctx.promptOptimizer.interview(
      { sessionId, text: '帮我写单片机固件 串口', mode: 'goal' }, new AbortController().signal,
    )
    expect(result.questions[0]?.text).toContain('什么算完成')
    const system = requests(ctx, sessionId)[0]?.system ?? ''
    expect(system).toContain('acceptance-first intent clarification specialist')
    expect(system).toContain('The FIRST question is always the acceptance question')
  })

  it('keeps the plain interview prompt without mode', async () => {
    const { ctx, sessionId } = await withGoalMode()
    await ctx.promptOptimizer.interview({ sessionId, text: '帮我写单片机固件 串口' }, new AbortController().signal)
    const system = requests(ctx, sessionId)[0]?.system ?? ''
    expect(system).toContain('intent clarification specialist')
    expect(system).not.toContain('acceptance-first')
  })
})

describe('goal criteria injection', () => {
  it('injects the authoritative criteria into the rewrite system prompt', async () => {
    const { ctx, sessionId } = await withGoalMode()
    await ctx.promptOptimizer.optimize(
      {
        sessionId, text: '帮我写单片机固件 串口', force: true,
        goalCriteria: ['脚本零退出', '输出两列数据'],
      },
      new AbortController().signal,
    )
    const system = requests(ctx, sessionId)[0]?.system ?? ''
    expect(system).toContain('The user defined done up front')
    expect(system).toContain('- 脚本零退出')
    expect(system).toContain('- 输出两列数据')
  })

  it('injects the criteria into every candidate of a candidates round', async () => {
    const { ctx, sessionId } = await withGoalMode()
    await ctx.promptOptimizer.optimizeCandidates(
      { sessionId, text: '帮我写单片机固件 串口', count: 2, force: true, goalCriteria: ['脚本零退出'] },
      new AbortController().signal,
    )
    const systems = requests(ctx, sessionId).map(record => record.system)
    // Every rewrite candidate round carries the criteria; the judge round scores, it does not rewrite.
    const rewrites = systems.filter(system => system.includes('prompt optimization specialist'))
    expect(rewrites).toHaveLength(2)
    for (const system of rewrites) {
      expect(system).toContain('- 脚本零退出')
    }
  })

  it('rejects blank entries and oversized lists before any dispatch', async () => {
    const { ctx, sessionId } = await withGoalMode()
    await expect(ctx.promptOptimizer.optimize(
      { sessionId, text: '草稿', goalCriteria: ['  '] }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_GOAL_CRITERIA' })
    await expect(ctx.promptOptimizer.optimize(
      { sessionId, text: '草稿', goalCriteria: ['一', '二', '三', '四', '五'] }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_GOAL_CRITERIA' })
  })
})
