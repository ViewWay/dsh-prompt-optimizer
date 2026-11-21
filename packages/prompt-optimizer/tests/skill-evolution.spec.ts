/** Skill evolution: draft-to-skill links, suggestEvolve, and the evolveOf distillation flow. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import PromptOptimizer from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Adapter serving a queue of raw-text scripts, one per model round. */
class ScriptedAdapter extends LlmAdapter {
  private next = 0

  constructor(private readonly scripts: readonly (readonly StreamChunk[])[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const script = this.scripts[Math.min(this.next, this.scripts.length - 1)]
    this.next += 1
    void options
    yield * script
  }
}

function rawText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function envelope(optimized: string): StreamChunk[] {
  return rawText(`<<<OPTIMIZED_PROMPT>>>\n${optimized}\n<<<CHANGES>>>\n- 补充了约束\n<<<AC>>>\n- 脚本存在 \`ls script.sh\``)
}

const CONFIG: Config = {
  maxInputBytes: 1_000, maxOutputTokens: 4_096, timeoutMs: 1_000, verifyTimeoutMs: 2_000,
  domainPriors: false, skillAware: false, skipCheck: false, metrics: true, precedents: false,
}

const SKILL_FILE = [
  '---',
  'name: uart-debugging',
  'description: Draft UART debugging prompts with pinned bus config and probe steps',
  '---',
  '',
  '# UART 调试提示词',
  '',
  'When to use: 用户要调试串口外设时。',
  'Captured requirements:',
  '- 引脚与波特率先确认',
].join('\n')

const EVOLVED_FILE = [
  '---',
  'name: uart-renamed-by-model',
  'description: Draft UART debugging prompts with pinned bus config, probe steps, and log capture',
  '---',
  '',
  '# UART 调试提示词',
  '',
  'When to use: 用户要调试串口外设时。',
  'Captured requirements:',
  '- 引脚与波特率先确认',
  '- 先抓一段日志再下结论',
].join('\n')

async function withEvolutionStorage(scripts: readonly (readonly StreamChunk[])[], opt: { existingSkill?: string } = {}): Promise<{
  ctx: Context
  sessionId: SessionId
  tables: Map<string, Map<string, { id: string; createdAt: string; [key: string]: unknown }>>
  writes: { path: string; content: string }[]
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], new ScriptedAdapter(scripts))
  const tables = new Map<string, Map<string, { id: string; createdAt: string; [key: string]: unknown }>>()
  ctx.provide('storageDomain', {
    open: async () => ({
      table: (name: string) => {
        const table = tables.get(name) ?? new Map()
        tables.set(name, table)
        return {
          get: (key: string) => table.get(key),
          put: async (key: string, value: { id: string; createdAt: string; [key: string]: unknown }) => { table.set(key, value) },
          delete: async (key: string) => table.delete(key),
          entries: () => table.entries(),
        }
      },
    }),
  } as never)
  const contents = new Map<string, string>()
  if (opt.existingSkill !== undefined) {
    contents.set('/proj/root/.dsh/skills/uart-debugging/SKILL.md', opt.existingSkill)
  }
  const writes: { path: string; content: string }[] = []
  ctx.provide('fs', {
    resolve: async (path: string) => path,
    writeText: async (target: string, content: string) => {
      contents.set(String(target), content)
      writes.push({ path: String(target), content })
      return {} as never
    },
    readText: async (target: string) => {
      const text = contents.get(String(target))
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
  } as never)
  ctx.provide('workingDirectory', { get: () => '/proj/root' } as never)
  await ctx.plugin(PromptOptimizer, CONFIG)
  const session = ctx.sessions.create(SessionId('evolve-session'))
  session.append('request/header', {
    header: { config: { provider: 'current-route', model: 'current-model' } },
    reason: 'initial',
  })
  return { ctx, sessionId: session.id, tables, writes }
}

describe('skill links and suggestEvolve', () => {
  it('registers a link on the distill confirm and suggests evolving on the next threshold round', async () => {
    const { ctx, sessionId, tables } = await withEvolutionStorage([
      envelope('第一版'), envelope('第二版'), envelope('第三版'), rawText(SKILL_FILE),
      envelope('第四版'), envelope('第五版'), envelope('第六版'),
    ])

    for (let index = 0; index < 3; index += 1) {
      await ctx.promptOptimizer.optimize({ sessionId, text: '帮我调试 uart 波特率' }, new AbortController().signal)
    }
    await ctx.promptOptimizer.distillSkill({ sessionId, draft: '帮我调试 uart 波特率', optimized: '第三版' }, new AbortController().signal)
    await ctx.promptOptimizer.distillSkill({ sessionId, draft: '帮我调试 uart 波特率', optimized: '第三版', confirm: true }, new AbortController().signal)
    const links = [...(tables.get('links') ?? new Map()).values()]
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ name: 'uart-debugging', targetDir: '/proj/root/.dsh/skills' })

    const fourth = await ctx.promptOptimizer.optimize({ sessionId, text: '帮我调试 uart 波特率' }, new AbortController().signal)
    expect(fourth.suggestDistill).toBeUndefined()
    expect(fourth.suggestEvolve).toBeUndefined()
    await ctx.promptOptimizer.optimize({ sessionId, text: '帮我调试 uart 波特率' }, new AbortController().signal)
    const sixth = await ctx.promptOptimizer.optimize({ sessionId, text: '帮我调试 uart 波特率' }, new AbortController().signal)
    expect(sixth.suggestEvolve).toEqual({ name: 'uart-debugging' })
    expect(sixth.suggestDistill).toBeUndefined()
  })
})

describe('distillSkill evolveOf', () => {
  it('evolves an existing skill in place: preview pins the name, confirm overwrites with a backup and records the evolved metric', async () => {
    const { ctx, sessionId, writes, tables } = await withEvolutionStorage([rawText(EVOLVED_FILE)], { existingSkill: SKILL_FILE })

    const preview = await ctx.promptOptimizer.distillSkill(
      { sessionId, draft: '帮我调试 uart 波特率', optimized: '加了日志要求', evolveOf: 'uart-debugging' },
      new AbortController().signal,
    )
    expect(preview.name).toBe('uart-debugging')
    expect(preview.pendingDefinition).toContain('先抓一段日志再下结论')
    // The model-renamed frontmatter value is pinned back to the existing skill's name.
    expect(preview.pendingDefinition).not.toContain('uart-renamed-by-model')
    expect(writes).toEqual([])

    const confirmed = await ctx.promptOptimizer.distillSkill(
      { sessionId, draft: '帮我调试 uart 波特率', optimized: '加了日志要求', evolveOf: 'uart-debugging', confirm: true },
      new AbortController().signal,
    )
    expect(confirmed.name).toBe('uart-debugging')
    expect(writes.map(write => write.path)).toEqual([
      '/proj/root/.dsh/skills/uart-debugging/SKILL.md.bak',
      '/proj/root/.dsh/skills/uart-debugging/SKILL.md',
    ])
    expect(writes[0]!.content).toBe(SKILL_FILE)
    expect(writes[1]!.content).toContain('name: uart-debugging')
    const metrics = [...(tables.get('metrics') ?? new Map()).values()]
    expect(metrics.some(row => row.kind === 'evolved')).toBe(true)
    expect(metrics.some(row => row.kind === 'distilled')).toBe(false)
  })

  it('fails typed for an unknown or malformed evolve target', async () => {
    const { ctx, sessionId } = await withEvolutionStorage([rawText(SKILL_FILE)], { existingSkill: SKILL_FILE })
    await expect(ctx.promptOptimizer.distillSkill(
      { sessionId, draft: '草稿', optimized: '优化后', evolveOf: 'no-such-skill' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_EVOLVE_TARGET_NOT_FOUND' })
    await expect(ctx.promptOptimizer.distillSkill(
      { sessionId, draft: '草稿', optimized: '优化后', evolveOf: '../escape' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_EVOLVE_TARGET_NOT_FOUND' })
  })
})
