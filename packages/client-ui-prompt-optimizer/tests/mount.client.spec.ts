/** The optional namespace, round lifecycle, and preview seat follow plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'dsh-api-prompt-optimizer/types'
import { expect, it, vi } from 'vitest'
import { mountPromptOptimizer, inject } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import { OptimizeButton } from '../src/client/OptimizeButton.tsx'
import { PreviewPanel } from '../src/client/PreviewPanel.tsx'
import type { OptimizationSnapshot, OptimizationState } from '../src/client/optimization.ts'

const REMOTE: TypertRemoteContribution = {
  package: 'dsh-api-prompt-optimizer',
  descriptors: [],
}
const SESSION = 'session-1' as SessionId
const RESULT = {
  optimizedText: '优化后的提示词',
  changes: ['补充了输出格式'],
  provider: 'current-route',
  model: 'current-model',
  usage: undefined,
} as const

interface Published {
  readonly interaction: { key: string; kind: string; sessionId: SessionId }
  readonly delegate: () => Promise<void>
  readonly unpublish: () => void
}

async function fixture(optimize?: (request: unknown, signal: AbortSignal) => Promise<unknown>) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const published: Published[] = []
  ctx.provide('uiSession', {
    registerPendingInteraction:
      <T extends { key: string }>(precedence: (interaction: T) => number) =>
        (interaction: T & { kind: string; sessionId: SessionId }, delegate: () => Promise<void>) => {
          expect(precedence(interaction)).toBe(0)
          const entry: Published = { interaction, delegate, unpublish: vi.fn() }
          published.push(entry)
          return () => { published.splice(published.indexOf(entry), 1) }
        },
  } as never)
  const round = vi.fn(async () => ({ ok: true as const, value: RESULT }))
  ctx.provide('remote.promptOptimizer', { optimize: optimize ?? round } as never)
  ctx.provide('configForms', {
    get: () => ({
      getSnapshot: () => ({ status: 'loading', value: undefined, base: {}, user: {}, writable: false, revision: 0 }),
      subscribe: () => () => {},
      mutate: async () => false,
    }),
  } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.locale.setLocale('en')
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
    'conversation.input.dock.queue.item': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  } } as never,
  () => null)
  return { ctx, unmount, published, round }
}

type MountedActions = {
  start: (sessionId: SessionId, text: string, apply: (text: string) => void) => void
  apply: (sessionId: SessionId) => void
  regenerate: (sessionId: SessionId) => void
  regenerateAsRole: (sessionId: SessionId, role: string | undefined) => void
  cancel: (sessionId: SessionId) => void
  hooks: { optimization: { getSnapshot(): OptimizationSnapshot; subscribe(listener: () => void): () => void } }
}

/** The actions both entries inject; each registration closes over the same mount. */
function actionsOf(ctx: Context): MountedActions {
  const item = ctx.slots.entries('conversation.input.right').find(candidate => candidate.component === OptimizeButton)
    ?? ctx.slots.entries('conversation.composer').find(candidate => candidate.component === PreviewPanel)
  return item!.inject!() as MountedActions
}

/** Read one session's state through the entry-injected hook source. */
function stateOf(ctx: Context): OptimizationState | undefined {
  return actionsOf(ctx).hooks.optimization.getSnapshot()[SESSION]
}

it('mounts both seats, runs a round, replaces the draft on apply, and withdraws on disposal', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    expect(b.ctx.slots.entries('conversation.input.right').find(item => item.component === OptimizeButton)).toMatchObject({ locale: 'prompt-optimizer' })
    expect(b.ctx.slots.entries('conversation.composer').find(item => item.component === PreviewPanel)).toMatchObject({ locale: 'prompt-optimizer' })

    const actions = actionsOf(b.ctx)
    const applied: string[] = []
    actions.start(SESSION, '帮我写脚本', (text) => { applied.push(text) })
    expect(b.published).toHaveLength(1)
    expect(b.published[0]!.interaction).toMatchObject({ key: `prompt-optimization:${SESSION}`, kind: 'prompt-optimization' })
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })
    expect(b.round).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, text: '帮我写脚本', language: 'English' }, expect.any(AbortSignal))

    actions.apply(SESSION)
    expect(applied).toEqual(['优化后的提示词'])
    expect(b.published).toHaveLength(0)
    expect(stateOf(b.ctx)).toBeUndefined()

    await fiber.dispose()
    expect(b.ctx.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.composer')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it('accumulates rejected results into the next round and cancels cleanly', async () => {
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)
    actions.start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })

    actions.regenerate(SESSION)
    await vi.waitFor(() => { expect(b.round).toHaveBeenCalledTimes(2) })
    expect(b.round).toHaveBeenLastCalledWith({ sessionId: SESSION, text: 'draft', previousAttempts: ['优化后的提示词'], language: 'English' }, expect.any(AbortSignal))

    actions.cancel(SESSION)
    expect(b.published).toHaveLength(0)
    expect(stateOf(b.ctx)).toBeUndefined()
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('re-runs with a newly picked role and adopts the host-resolved role into the state', async () => {
  const styled = {
    optimize: vi.fn(async () => ({ ok: true as const, value: { ...RESULT, role: 'imp-code-reviewer' } })),
  }
  const b = await fixture(styled.optimize)
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)
    actions.start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })
    expect(stateOf(b.ctx)?.role).toBe('imp-code-reviewer')

    actions.regenerateAsRole(SESSION, 'qa-engineer')
    await vi.waitFor(() => { expect(styled.optimize).toHaveBeenCalledTimes(2) })
    expect(styled.optimize).toHaveBeenLastCalledWith({
      sessionId: SESSION, text: 'draft', previousAttempts: ['优化后的提示词'], role: 'qa-engineer', language: 'English',
    }, expect.any(AbortSignal))
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })

    actions.regenerateAsRole(SESSION, undefined)
    await vi.waitFor(() => { expect(styled.optimize).toHaveBeenCalledTimes(3) })
    expect(styled.optimize).toHaveBeenLastCalledWith({
      sessionId: SESSION, text: 'draft',
      previousAttempts: ['优化后的提示词', '优化后的提示词'], role: undefined, language: 'English',
    }, expect.any(AbortSignal))
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('carries the active agent-locale label as the round language', async () => {
  const styled = {
    optimize: vi.fn(async () => ({ ok: true as const, value: RESULT })),
  }
  const b = await fixture(styled.optimize)
  try {
    b.ctx.locale.setLocale('zh')
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    actionsOf(b.ctx).start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(styled.optimize).toHaveBeenCalledTimes(1) })
    expect(styled.optimize).toHaveBeenCalledWith({
      sessionId: SESSION, text: 'draft', language: '中文',
    }, expect.any(AbortSignal))
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('records a failed round for retry', async () => {
  const failing = {
    optimize: async () => ({ ok: false as const, error: new RemoteError('prompt-optimizer/optimization-failed', '断网', { reason: '断网' }) }),
  }
  const b = await fixture(failing.optimize)
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)
    actions.start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('failed') })
    expect(stateOf(b.ctx)?.error).toBe('断网')
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('rolls back the Remote when a slot registration fails', async () => {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  ctx.provide('uiSession', { registerPendingInteraction: () => () => () => {} } as never)
  ctx.provide('remote.promptOptimizer', { optimize: async () => ({ ok: true as const, value: RESULT }) } as never)
  ctx.provide('configForms', { get: () => ({
    getSnapshot: () => ({ status: 'loading', value: undefined, base: {}, user: {}, writable: false, revision: 0 }),
    subscribe: () => () => {},
    mutate: async () => false,
  }) } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('slots', { inject: () => { throw new Error('slot failed') } } as never)
  try {
    await expect(mountPromptOptimizer(ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(unmount).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})
