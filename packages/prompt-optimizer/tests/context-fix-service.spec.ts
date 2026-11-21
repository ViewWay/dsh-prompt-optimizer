/** contextFix service flows: preview, writability boundary, confirm writes, rescan, typed failures. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
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

const CONFIG: Config = {
  maxInputBytes: 1_000, maxOutputTokens: 4_096, timeoutMs: 1_000, verifyTimeoutMs: 2_000,
  domainPriors: false, skillAware: false, skipCheck: false, metrics: false, precedents: false,
}

/** One skill fixture: a directory under the writable root plus the files it holds. */
interface FixSkill {
  readonly name: string
  readonly base: string
  readonly body: string
  readonly files?: readonly string[]
}

async function withFixContext(opt: {
  readonly skills?: readonly FixSkill[]
  readonly sections?: readonly { readonly name: string; readonly text: string }[]
  readonly scripts?: readonly (readonly StreamChunk[])[]
  readonly config?: Partial<Config>
}): Promise<{
  ctx: Context
  sessionId: SessionId
  writes: { readonly path: string; readonly content: string }[]
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], new ScriptedAdapter(opt.scripts ?? []))
  const skills = opt.skills ?? []
  const contents = new Map<string, string>(skills.map(skill => [`${skill.base}/SKILL.md`, skill.body]))
  const writes: { path: string; content: string }[] = []
  const summaryOf = (skill: FixSkill) => ({
    name: skill.name,
    description: `${skill.name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'fs',
    resourceBase: { kind: 'directory', path: skill.base },
  })
  if (skills.length > 0) {
    ctx.provide('skills', {
      list: async () => skills.map(summaryOf),
      get: async (name: string) => {
        const skill = skills.find(entry => entry.name === name)
        return skill === undefined ? undefined : { ...summaryOf(skill), content: contents.get(`${skill.base}/SKILL.md`) }
      },
    } as never)
  }
  if (opt.sections !== undefined) {
    ctx.provide('systemPrompt', { assemble: async () => ({ sections: opt.sections!.map(section => ({ ...section })), contexts: [], variables: {}, tools: [] }) } as never)
  }
  ctx.provide('workingDirectory', { get: () => '/proj/root' } as never)
  ctx.provide('fs', {
    resolve: async (path: string) => path,
    readText: async (target: string) => {
      const text = contents.get(String(target))
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    writeText: async (target: string, content: string) => {
      const path = String(target)
      contents.set(path, content)
      writes.push({ path, content })
      return {} as never
    },
    listDir: async (target: string) => {
      const skill = skills.find(entry => `${entry.base}` === String(target))
      return skill === undefined
        ? []
        : ['SKILL.md', ...(skill.files ?? [])].map(name => ({ type: 'file', name, target: `${skill.base}/${name}` }))
    },
    stat: async (target: string) => {
      const skill = skills.find(entry => String(target).startsWith(`${entry.base}/`))
      if (skill === undefined) throw new Error('ENOENT')
      const reference = String(target).slice(`${skill.base}/`.length)
      return ['SKILL.md', ...(skill.files ?? [])].includes(reference) ? { type: 'file' } : Promise.reject(new Error('ENOENT'))
    },
  } as never)
  await ctx.plugin(PromptOptimizer, { ...CONFIG, ...opt.config })
  const session = ctx.sessions.create(SessionId('fix-session'))
  session.append('request/header', {
    header: { config: { provider: 'current-route', model: 'current-model' } },
    reason: 'initial',
  })
  return { ctx, sessionId: session.id, writes }
}

const STALE_BODY = [
  '# 参考技能',
  '',
  'Open ./guide.md first, then ./guilde.md for the legacy notes.',
  '- Always read ./guilde.md before probing the board',
  'Keep the probe steps pinned.',
].join('\n')

const STRIPPED_BODY = [
  '# 参考技能',
  '',
  'Open ./guide.md first, then  for the legacy notes.',
  '- Always read  before probing the board',
  'Keep the probe steps pinned.',
].join('\n')

describe('PromptOptimizer.contextFix stale references', () => {
  it('previews a writable repair without writing, then confirms with a backup and a clean rescan', async () => {
    const { ctx, sessionId, writes } = await withFixContext({
      skills: [{ name: 'ref-skill', base: '/proj/root/.dsh/skills/ref-skill', body: STALE_BODY, files: ['guide.md'] }],
    })

    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'stale-skill-reference')!
    expect(finding).toMatchObject({ subject: 'ref-skill' })

    const preview = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'stale-skill-reference', subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )
    expect(preview).toMatchObject({
      advisory: false,
      proposal: STRIPPED_BODY,
      replacement: 'guide.md',
      targetFile: '/proj/root/.dsh/skills/ref-skill/SKILL.md',
    })
    expect(preview.findings).toBeUndefined()
    expect(writes).toEqual([])

    const confirmed = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'stale-skill-reference', subject: finding.subject, detail: finding.detail, confirm: true },
      new AbortController().signal,
    )
    expect(confirmed.findings).toEqual([])
    expect(writes.map(write => write.path)).toEqual([
      '/proj/root/.dsh/skills/ref-skill/SKILL.md.bak',
      '/proj/root/.dsh/skills/ref-skill/SKILL.md',
    ])
    expect(writes[0]!.content).toBe(STALE_BODY)
    expect(writes[1]!.content).toBe(STRIPPED_BODY)
    const events = ctx.sessions.get(sessionId)!.snapshotEvents().flatMap(event => {
      const record = pluginRecordOf(event)
      return record?.type === 'plugin:prompt-optimizer/context-fixed' ? [record.data] : []
    })
    expect(events).toEqual([{ kind: 'stale-skill-reference', subject: 'ref-skill', bytes: Buffer.byteLength(STRIPPED_BODY, 'utf8') }])
  })

  it('rejects a forged stale-reference detail and binds confirmation to the preview', async () => {
    const { ctx, sessionId, writes } = await withFixContext({
      skills: [{ name: 'ref-skill', base: '/proj/root/.dsh/skills/ref-skill', body: STALE_BODY, files: ['guide.md'] }],
    })
    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'stale-skill-reference')!
    const forgedDetail = finding.detail.replace('guilde.md', 'guide.md')

    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: finding.kind, subject: finding.subject, detail: forgedDetail },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_FINDING_GONE' })
    expect(writes).toEqual([])

    await ctx.promptOptimizer.contextFix(
      { sessionId, kind: finding.kind, subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: finding.kind, subject: finding.subject, detail: forgedDetail, confirm: true },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_NOT_PENDING' })
    expect(writes).toEqual([])
  })

  it('degrades to an advisory proposal when the skill sits outside the writable root', async () => {
    const { ctx, sessionId, writes } = await withFixContext({
      skills: [{ name: 'packaged-skill', base: '/packaged/skill-x', body: STALE_BODY, files: [] }],
    })
    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'stale-skill-reference')!

    const preview = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'stale-skill-reference', subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )
    expect(preview.advisory).toBe(true)
    expect(preview.targetFile).toBeUndefined()
    expect(writes).toEqual([])
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'stale-skill-reference', subject: finding.subject, detail: finding.detail, confirm: true },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_NOT_PENDING' })
  })
})

describe('PromptOptimizer.contextFix duplicate skills', () => {
  const SHARED = 'wire the sensor over i2c then dump the register table before changing driver code '.repeat(3)

  it('merges over one model round, pins the left name, and retires the right half to a tombstone', async () => {
    const MERGED = [
      '---',
      'name: i2c-renamed-by-model',
      'description: Draft I2C sensor prompts with the shared wiring rules',
      '---',
      '',
      '# I2C 提示词',
      '',
      'When to use: 用户要配置 i2c 传感器时。',
      SHARED,
    ].join('\n')
    const { ctx, sessionId, writes } = await withFixContext({
      skills: [
        { name: 'i2c-a', base: '/proj/root/.dsh/skills/i2c-a', body: SHARED },
        { name: 'i2c-b', base: '/proj/root/.dsh/skills/i2c-b', body: `${SHARED}with a tail` },
      ],
      scripts: [rawText(MERGED)],
    })
    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'duplicate-skill')!
    expect(finding.subject).toBe('i2c-a ≈ i2c-b')

    const preview = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-skill', subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )
    expect(preview.advisory).toBe(false)
    expect(preview.targetFile).toBe('/proj/root/.dsh/skills/i2c-a/SKILL.md')
    // The model-renamed frontmatter value is pinned back to the left registry name.
    expect(preview.proposal).toContain('name: i2c-a')
    expect(preview.proposal).not.toContain('i2c-renamed-by-model')
    expect(writes).toEqual([])

    const confirmed = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-skill', subject: finding.subject, detail: finding.detail, confirm: true },
      new AbortController().signal,
    )
    // The tombstone body is far below the duplicate-detection floor, so the finding is gone.
    expect(confirmed.findings).toEqual([])
    expect(writes.map(write => write.path)).toEqual([
      '/proj/root/.dsh/skills/i2c-a/SKILL.md.bak',
      '/proj/root/.dsh/skills/i2c-a/SKILL.md',
      '/proj/root/.dsh/skills/i2c-b/SKILL.md.bak',
      '/proj/root/.dsh/skills/i2c-b/SKILL.md',
    ])
    expect(writes[1]!.content).toContain('name: i2c-a')
    expect(writes[3]!.content).toContain('merged into i2c-a')
  })

  it('degrades to advisory when either half sits outside the writable root', async () => {
    const { ctx, sessionId } = await withFixContext({
      skills: [
        { name: 'i2c-a', base: '/proj/root/.dsh/skills/i2c-a', body: SHARED },
        { name: 'i2c-b', base: '/packaged/i2c-b', body: SHARED },
      ],
      scripts: [rawText('---\nname: i2c-a\ndescription: merged\n---\n# merged\n')],
    })
    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'duplicate-skill')!
    const preview = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-skill', subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )
    expect(preview.advisory).toBe(true)
    expect(preview.targetFile).toBeUndefined()
  })

  it('fails typed when the merge output is not a valid skill definition', async () => {
    const { ctx, sessionId } = await withFixContext({
      skills: [
        { name: 'i2c-a', base: '/proj/root/.dsh/skills/i2c-a', body: SHARED },
        { name: 'i2c-b', base: '/proj/root/.dsh/skills/i2c-b', body: SHARED },
      ],
      scripts: [rawText('# 没有元数据')],
    })
    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'duplicate-skill')!
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-skill', subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_INVALID' })
  })
})

describe('PromptOptimizer.contextFix duplicate sections and guards', () => {
  const REPEATED = 'check the register map before touching any peripheral on this board '.repeat(4)

  it('merges duplicate sections as advisory copy only, with no write path', async () => {
    const { ctx, sessionId, writes } = await withFixContext({
      sections: [
        { name: 'left', text: REPEATED },
        { name: 'right', text: `${REPEATED}with a tail` },
      ],
      scripts: [rawText('合并后的段落文本')],
    })
    const scan = await ctx.promptOptimizer.contextCheck({ sessionId }, new AbortController().signal)
    const finding = scan.findings.find(entry => entry.kind === 'duplicate-section')!

    const preview = await ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-section', subject: finding.subject, detail: finding.detail },
      new AbortController().signal,
    )
    expect(preview).toMatchObject({ advisory: true, proposal: '合并后的段落文本' })
    expect(preview.targetFile).toBeUndefined()
    expect(writes).toEqual([])
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-section', subject: finding.subject, detail: finding.detail, confirm: true },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_NOT_PENDING' })
  })

  it('rejects a finding a fresh scan no longer reports, an unfixable kind, and blank targets', async () => {
    const { ctx, sessionId } = await withFixContext({})
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-section', subject: 'left ≈ right', detail: 'word overlap 90%; these sections largely repeat each other' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_FINDING_GONE' })
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'oversized-section' as never, subject: 'x', detail: 'y' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_CONTEXT_FIX_KIND' })
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'duplicate-section', subject: '  ', detail: '' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_BAD_CONTEXT_FIX_TARGET' })
  })

  it('requires a preceding preview before any confirm', async () => {
    const { ctx, sessionId } = await withFixContext({})
    await expect(ctx.promptOptimizer.contextFix(
      { sessionId, kind: 'stale-skill-reference', subject: 'ref-skill', detail: 'references "gone.md", which does not exist in the skill directory', confirm: true },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROMPT_OPTIMIZER_CONTEXT_FIX_NOT_PENDING' })
  })
})
