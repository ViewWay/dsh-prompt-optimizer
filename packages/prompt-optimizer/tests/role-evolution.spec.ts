/** Role-definition evolution: rewrite round, .bak retention, typed failures. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import PromptOptimizer from '../src/index.ts'
import type { Config, PromptOptimizerRoleEvolvedEventData } from '../src/index.ts'

const CONFIG: Config = {
  maxInputBytes: 1_000, maxOutputTokens: 64, timeoutMs: 1_000, verifyTimeoutMs: 2_000,
  domainPriors: true, skillAware: false,
}

/** Committed role-evolution record payloads in `events`, oldest first. */
function roleEvolvedRecords(events: readonly SessionEvent[]): PromptOptimizerRoleEvolvedEventData[] {
  return events.flatMap(event => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:prompt-optimizer/role-evolved' ? [record.data as PromptOptimizerRoleEvolvedEventData] : []
  })
}

const REVIEWER_TEXT = '# 代码评审员（Code Reviewer）\n\n## 角色设定\n你是一名代码评审员，负责审查代码变更。\n'

const EVOLVED_DEFINITION = [
  '# 代码评审员（Code Reviewer）',
  '',
  '## 角色设定',
  '你是一名代码评审员，专注并发与契约审查。',
  '',
  '## 背景',
  '- 多年服务端评审经验',
  '',
  '## 技能',
  '- 并发路径与契约变更审查',
  '',
  '## 工作方式',
  '- 先读变更说明再读代码',
  '',
  '## 输出格式',
  '- 按风险等级列出问题',
  '',
  '## 回答风格',
  '- 克制、指向明确',
  '',
  '## 回答限制',
  '- 不虚构未见的代码路径',
].join('\n')

/** Adapter replaying one script per dispatch. */
class SequencedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly scripts: readonly (readonly StreamChunk[])[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const script = this.scripts[this.requests.length]
    this.requests.push(options)
    if (script === undefined) throw new Error('unexpected extra dispatch')
    yield * script
  }
}

/** Plain-text stream script: the evolution round parses no envelope. */
function definitionScript(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One in-memory role definition file a faked filesystem serves. */
interface RoleFile {
  readonly name: string
  readonly text: string
}

/** Fake the `fs` service over in-memory files plus a write-recording map. */
function writableFs(files: readonly RoleFile[]): { service: unknown; written: Map<string, string> } {
  const byName = new Map(files.map(file => [file.name, file]))
  const written = new Map<string, string>()
  return {
    written,
    service: {
      resolve: async (path: string) => path,
      listDir: async (dir: string) => [...byName.values()]
        .map(file => ({ name: file.name, type: 'file', target: `${dir}/${file.name}` })),
      readText: async (target: string) => {
        const file = byName.get(target.slice('/roles/'.length))
        if (file === undefined) throw new Error(`ENOENT: ${target}`)
        return written.get(target) ?? file.text
      },
      writeText: async (target: string, content: string) => {
        written.set(target, content)
        return {} as never
      },
    },
  }
}

async function withEvolve(
  script: readonly StreamChunk[],
  files: readonly RoleFile[] = [{ name: 'imp-code-reviewer.md', text: REVIEWER_TEXT }],
): Promise<{
  ctx: Context
  adapter: SequencedAdapter
  written: Map<string, string>
  sessionId: SessionId
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new SequencedAdapter([script])
  ctx.llm.registerAdapter(['current-route'], adapter)
  const fs = writableFs(files)
  ctx.provide('fs', fs.service as never)
  await ctx.plugin(PromptOptimizer, { ...CONFIG, rolesDir: '/roles' })
  const session = ctx.sessions.create(SessionId('role-evolve'))
  session.append('request/header', {
    header: { config: { provider: 'current-route', model: 'current-model' } },
    reason: 'initial',
  })
  return { ctx, adapter, written: fs.written, sessionId: session.id }
}

describe('PromptOptimizer.evolveRole', () => {
  it('rewrites the definition, keeps the old one as .bak, and logs the evolution', async () => {
    const { ctx, adapter, written, sessionId } = await withEvolve(definitionScript(EVOLVED_DEFINITION))

    const result = await ctx.promptOptimizer.evolveRole(
      { sessionId, role: 'imp-code-reviewer', draft: '帮我看看这段代码', optimized: '优化后的提示词' },
      new AbortController().signal,
    )

    expect(result).toEqual({
      role: 'imp-code-reviewer',
      name: '代码评审员',
      bytes: Buffer.byteLength(EVOLVED_DEFINITION, 'utf8'),
    })
    expect(written.get('/roles/imp-code-reviewer.md.bak')).toBe(REVIEWER_TEXT)
    expect(written.get('/roles/imp-code-reviewer.md')).toBe(EVOLVED_DEFINITION)
    const events = roleEvolvedRecords(ctx.sessions.get(sessionId)!.snapshotEvents())
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ role: 'imp-code-reviewer', bytes: result.bytes })
    expect(adapter.requests[0]?.system).toContain('role definition maintainer')
    const material = adapter.requests[0]?.messages[0]?.content[0]
    expect(material?.type === 'text' && material.text).toContain('你是一名代码评审员，负责审查代码变更。')
    expect(material?.type === 'text' && material.text).toContain('帮我看看这段代码')
    expect(material?.type === 'text' && material.text).toContain('优化后的提示词')
  })

  it('rejects an unlisted role before any dispatch or write', async () => {
    const { ctx, adapter, written, sessionId } = await withEvolve(definitionScript(EVOLVED_DEFINITION))

    await expect(ctx.promptOptimizer.evolveRole(
      { sessionId, role: 'imp-nope', draft: '草稿', optimized: '结果' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_ROLE_NOT_FOUND' })
    expect(adapter.requests).toHaveLength(0)
    expect(written.size).toBe(0)
  })

  it('rejects a model product without an H1 heading and writes nothing', async () => {
    const { ctx, written, sessionId } = await withEvolve(definitionScript('不是标题的定义正文'))

    await expect(ctx.promptOptimizer.evolveRole(
      { sessionId, role: 'imp-code-reviewer', draft: '草稿', optimized: '结果' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_ROLE_EVOLVE_INVALID' })
    expect(written.size).toBe(0)
    expect(roleEvolvedRecords(ctx.sessions.get(sessionId)!.snapshotEvents())).toHaveLength(0)
  })
})
