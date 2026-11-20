/** The optional namespace, round lifecycle, and preview seat follow plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@yimiliya/dsh-api-prompt-optimizer/types'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { mountPromptOptimizer, inject } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import { OptimizeButton } from '../src/client/OptimizeButton.tsx'
import { PreviewPanel } from '../src/client/PreviewPanel.tsx'
import { QueueItemOptimizeEntry } from '../src/client/QueueItemOptimizeEntry.tsx'
import {
  PromptOptimizerSettings, type PromptOptimizerSettingsInjected, type PromptOptimizerSettingsProps,
} from '../src/client/PromptOptimizerSettings.tsx'
import { en, type PromptOptimizerKey } from '../src/client/locales.ts'
import type { OptimizationSnapshot, OptimizationState } from '../src/client/optimization.ts'

afterEach(cleanup)

const REMOTE: TypertRemoteContribution = {
  package: '@yimiliya/dsh-api-prompt-optimizer',
  descriptors: [],
}
const SESSION = 'session-1' as SessionId
/** Zeroed metrics aggregate the default remote stub serves. */
const EMPTY_METRICS = {
  adopted: 0, rejected: 0, declined: 0, declineOverridden: 0,
  interviewQuestions: 0, clarifiedRounds: 0, verifyPassed: 0, verifyFailed: 0,
  candidatesRounds: 0, judgedRounds: 0, judgeAverage: null, distills: 0,
  adoptionRate: null, verifyPassRate: null, rows: 0,
}
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

/** Locale snapshot a stub locale runtime republishes; pins single- or mis-rooted catalogs. */
interface StubLocaleSnapshot {
  readonly active: string
  readonly locales: readonly { readonly id: string; readonly label: string }[]
  readonly revision: number
}

async function fixture(
  optimize?: (request: unknown, signal: AbortSignal) => Promise<unknown>,
  localeSnapshot?: () => StubLocaleSnapshot,
  declareQueueSlot = true,
  remoteExtra: Record<string, unknown> = {},
) {
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
  const reportMetric = vi.fn(async () => ({ ok: true as const, value: undefined }))
  ctx.provide('remote.promptOptimizer', {
    optimize: optimize ?? round,
    reportMetric,
    listMetrics: vi.fn(async () => ({ ok: true as const, value: { ...EMPTY_METRICS } })),
    ...remoteExtra,
  } as never)
  ctx.provide('configForms', {
    get: () => ({
      getSnapshot: () => ({ status: 'loading', value: undefined, base: {}, user: {}, writable: false, revision: 0 }),
      subscribe: () => () => {},
      mutate: async () => false,
    }),
  } as never)
  ctx.provide('locale', (localeSnapshot === undefined
    ? new LocaleRuntime(ctx)
    : { getLocale: localeSnapshot, register: () => () => {}, setLocale: () => {} }) as never)
  ctx.locale.setLocale('en')
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
    ...(declareQueueSlot ? { 'conversation.input.dock.queue.item': { kind: 'list', scope: 'session' } } : {}),
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
  regenerateCandidates: (sessionId: SessionId) => void
  selectCandidate: (sessionId: SessionId, index: number) => void
  distillSkill: (sessionId: SessionId, draft: string, optimized: string, clarifications?: readonly { question: string; answer: string }[], confirm?: boolean) => Promise<unknown>
  startInterview: (sessionId: SessionId, text: string, apply: (text: string) => void, role?: string) => void
  answerInterview: (sessionId: SessionId, index: number, value: string) => void
  submitInterview: (sessionId: SessionId) => void
  skipInterview: (sessionId: SessionId) => void
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

/** Simulate a host where the queue-item inject rejects (a declared slot failing registration). */
function rejectQueueItemSlot(ctx: Context): void {
  const slots = ctx.slots as unknown as { inject: (key: string, callback: () => unknown) => () => void }
  const realInject = slots.inject
  slots.inject = (key, callback) => {
    if (key === 'conversation.input.dock.queue.item') {
      throw new Error(`slot "${key}" is not declared (a parent entry's children table must declare it)`)
    }
    return realInject.call(ctx.slots, key, callback)
  }
}

/** Page-view props for the mounted settings card: its real injected face plus the runtime share. */
function settingsPageProps(ctx: Context): PromptOptimizerSettingsProps {
  const entry = ctx.slots.entries('plugins.bundle.config').find(candidate => candidate.component === PromptOptimizerSettings)
  if (entry?.inject === undefined) throw new Error('settings entry not registered')
  const { hooks, ...actions } = entry.inject() as PromptOptimizerSettingsInjected
  return {
    view: 'page', ...actions,
    useSettingsForm: bindSnapshotSelector(hooks.settingsForm),
    t: (key: PromptOptimizerKey) => en[key],
  } as PromptOptimizerSettingsProps
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

it('notifies the unavailable queue-item slot once on the settings page while other entries still mount', async () => {
  const b = await fixture()
  try {
    rejectQueueItemSlot(b.ctx)
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    expect(b.ctx.slots.entries('conversation.input.dock.queue.item')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.right').find(item => item.component === OptimizeButton)).toBeTruthy()
    expect(b.ctx.slots.entries('conversation.composer').find(item => item.component === PreviewPanel)).toBeTruthy()
    const settings = b.ctx.slots.entries('plugins.bundle.config').find(item => item.component === PromptOptimizerSettings)
    expect(settings?.inject?.()).toMatchObject({ queueEntryUnavailable: true })
    render(createElement(PromptOptimizerSettings, settingsPageProps(b.ctx)))
    expect(screen.getAllByText(en.settingsQueueEntryUnavailable)).toHaveLength(1)
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('notifies the never-declared queue-item slot once while inject stays pending and other entries still mount', async () => {
  const b = await fixture(undefined, undefined, false)
  try {
    const injectKeys: string[] = []
    const slots = b.ctx.slots as unknown as { inject: (key: string, callback: () => unknown) => () => void }
    const realInject = slots.inject
    slots.inject = (key, callback) => { injectKeys.push(key); return realInject.call(b.ctx.slots, key, callback) }
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    expect(injectKeys).toContain('conversation.input.dock.queue.item')
    expect(b.ctx.slots.entries('conversation.input.dock.queue.item')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.right').find(item => item.component === OptimizeButton)).toBeTruthy()
    expect(b.ctx.slots.entries('conversation.composer').find(item => item.component === PreviewPanel)).toBeTruthy()
    const settings = b.ctx.slots.entries('plugins.bundle.config').find(item => item.component === PromptOptimizerSettings)
    expect(settings?.inject?.()).toMatchObject({ queueEntryUnavailable: true })
    render(createElement(PromptOptimizerSettings, settingsPageProps(b.ctx)))
    expect(screen.getAllByText(en.settingsQueueEntryUnavailable)).toHaveLength(1)
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('keeps the settings page free of the queue-entry notice when the host declares the slot', async () => {
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    expect(b.ctx.slots.entries('conversation.input.dock.queue.item')
      .find(item => item.component === QueueItemOptimizeEntry)).toBeTruthy()
    const settings = b.ctx.slots.entries('plugins.bundle.config').find(item => item.component === PromptOptimizerSettings)
    expect(settings?.inject?.()).toMatchObject({ queueEntryUnavailable: false })
    render(createElement(PromptOptimizerSettings, settingsPageProps(b.ctx)))
    expect(screen.queryByText(en.settingsQueueEntryUnavailable)).toBeNull()
    await fiber.dispose()
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
    expect(b.round).toHaveBeenLastCalledWith({ sessionId: SESSION, text: 'draft', previousAttempts: ['优化后的提示词'], language: 'English', force: true }, expect.any(AbortSignal))

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
      sessionId: SESSION, text: 'draft', previousAttempts: ['优化后的提示词'], role: 'qa-engineer', language: 'English', force: true,
    }, expect.any(AbortSignal))
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })

    actions.regenerateAsRole(SESSION, undefined)
    await vi.waitFor(() => { expect(styled.optimize).toHaveBeenCalledTimes(3) })
    expect(styled.optimize).toHaveBeenLastCalledWith({
      sessionId: SESSION, text: 'draft',
      previousAttempts: ['优化后的提示词', '优化后的提示词'], role: undefined, language: 'English', force: true,
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

it('omits the round language when the interface offers a single language', async () => {
  let request: unknown
  const styled = {
    optimize: vi.fn(async (payload: unknown) => { request = payload; return { ok: true as const, value: RESULT } }),
  }
  const b = await fixture(styled.optimize, () => ({ active: 'en', locales: [{ id: 'en', label: 'English' }], revision: 0 }))
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    actionsOf(b.ctx).start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(styled.optimize).toHaveBeenCalledTimes(1) })
    expect(request).not.toHaveProperty('language')
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('omits the round language when the multi-language catalog lacks the active label', async () => {
  let request: unknown
  const styled = {
    optimize: vi.fn(async (payload: unknown) => { request = payload; return { ok: true as const, value: RESULT } }),
  }
  const b = await fixture(styled.optimize, () => ({
    active: 'fr', locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }], revision: 0,
  }))
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    actionsOf(b.ctx).start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(styled.optimize).toHaveBeenCalledTimes(1) })
    expect(request).not.toHaveProperty('language')
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

it('interviews before optimizing: answered questions ride into the forced round', async () => {
  const interview = vi.fn(async () => ({
    ok: true as const,
    value: {
      questions: [
        { text: '目标芯片型号？', options: ['STM32F103', 'ESP32'] },
        { text: '成功标准？', options: [] },
      ],
      provider: 'current-route',
      model: 'current-model',
    },
  }))
  const optimize = vi.fn(async () => ({ ok: true as const, value: RESULT }))
  const b = await fixture(optimize, undefined, true, { interview })
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)

    actions.startInterview(SESSION, '帮我写单片机固件', () => {})
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('interviewing') })
    await vi.waitFor(() => { expect(interview).toHaveBeenCalledTimes(1) })
    expect(stateOf(b.ctx)?.questions).toHaveLength(2)

    actions.answerInterview(SESSION, 0, 'ESP32')
    actions.answerInterview(SESSION, 1, '编译通过')
    actions.submitInterview(SESSION)
    await vi.waitFor(() => { expect(optimize).toHaveBeenCalledTimes(1) })
    expect(optimize).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      text: '帮我写单片机固件',
      force: true,
      clarifications: [
        { question: '目标芯片型号？', answer: 'ESP32' },
        { question: '成功标准？', answer: '编译通过' },
      ],
    }), expect.any(AbortSignal))
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })
    // A later explicit rerun keeps the answers in the round.
    actions.regenerate(SESSION)
    await vi.waitFor(() => { expect(optimize).toHaveBeenCalledTimes(2) })
    expect(optimize).toHaveBeenLastCalledWith(expect.objectContaining({
      previousAttempts: ['优化后的提示词'],
      clarifications: [
        { question: '目标芯片型号？', answer: 'ESP32' },
        { question: '成功标准？', answer: '编译通过' },
      ],
    }), expect.any(AbortSignal))
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('falls straight into a plain round when the interview finds nothing to ask', async () => {
  const interview = vi.fn(async () => ({ ok: true as const, value: { questions: [], provider: 'current-route', model: 'current-model' } }))
  const optimize = vi.fn(async () => ({ ok: true as const, value: RESULT }))
  const b = await fixture(optimize, undefined, true, { interview })
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)

    actions.startInterview(SESSION, '这份草稿已经很明确', () => {})
    await vi.waitFor(() => { expect(optimize).toHaveBeenCalledTimes(1) })
    expect(interview).toHaveBeenCalledTimes(1)
    const plainRequest = optimize.mock.calls[0]![0] as Record<string, unknown>
    expect(plainRequest).not.toHaveProperty('force')
    expect(plainRequest).not.toHaveProperty('clarifications')
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('reports rejected and adopted decisions as local metrics', async () => {
  const reportMetric = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const optimize = vi.fn(async () => ({ ok: true as const, value: RESULT }))
  const b = await fixture(optimize, undefined, true, { reportMetric })
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)

    actions.start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })

    actions.regenerate(SESSION)
    await vi.waitFor(() => {
      expect(reportMetric).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rejected', provider: 'current-route', model: 'current-model' }),
        expect.any(AbortSignal),
      )
    })
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })

    actions.apply(SESSION)
    await vi.waitFor(() => {
      expect(reportMetric).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'adopted', provider: 'current-route', model: 'current-model' }),
        expect.any(AbortSignal),
      )
    })
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('runs a candidates round, reports the discarded result, and switches the picked candidate', async () => {
  const CANDIDATES = {
    candidates: [
      { label: 'A', optimizedText: '候选甲', changes: [], acceptance: [], scores: { faithfulness: 8, completeness: 8, clarity: 9 }, total: 25, pareto: true, recommended: false },
      { label: 'B', optimizedText: '候选乙', changes: [], acceptance: [], scores: { faithfulness: 9, completeness: 7, clarity: 9 }, total: 25, pareto: true, recommended: true },
    ],
    recommended: 1,
    provider: 'current-route',
    model: 'current-model',
  }
  const optimizeCandidates = vi.fn(async () => ({ ok: true as const, value: CANDIDATES }))
  const reportMetric = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const b = await fixture(undefined, undefined, true, { optimizeCandidates, reportMetric })
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)
    const applied: string[] = []
    actions.start(SESSION, 'draft', (text) => { applied.push(text) })
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })

    actions.regenerateCandidates(SESSION)
    await vi.waitFor(() => { expect(optimizeCandidates).toHaveBeenCalledTimes(1) })
    expect(optimizeCandidates).toHaveBeenCalledWith({ sessionId: SESSION, text: 'draft', language: 'English', force: true }, expect.any(AbortSignal))
    await vi.waitFor(() => {
      expect(reportMetric).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rejected', provider: 'current-route', model: 'current-model' }),
        expect.any(AbortSignal),
      )
    })
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })
    expect(stateOf(b.ctx)?.result?.optimizedText).toBe('候选乙')
    expect(stateOf(b.ctx)?.selectedCandidate).toBe(1)

    actions.selectCandidate(SESSION, 0)
    expect(stateOf(b.ctx)?.result?.optimizedText).toBe('候选甲')
    expect(stateOf(b.ctx)?.selectedCandidate).toBe(0)

    actions.apply(SESSION)
    expect(applied).toEqual(['候选甲'])
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('distills a suggested round through the preview-then-confirm flow', async () => {
  const DISTILL_PREVIEW = {
    name: 'uart-debugging',
    description: 'Draft UART debugging prompts',
    bytes: 210,
    targetDir: '/proj/.dsh/skills',
    pendingDefinition: '---\nname: uart-debugging\ndescription: d\n---\n\n# 技能',
  }
  const distillSkill = vi.fn(async (_request: unknown, _signal?: AbortSignal) =>
    _signal === undefined || (_request as { confirm?: boolean }).confirm !== true
      ? { ok: true as const, value: DISTILL_PREVIEW }
      : { ok: true as const, value: { name: 'uart-debugging', description: 'Draft UART debugging prompts', bytes: 210, targetDir: '/proj/.dsh/skills' } })
  const suggested = {
    optimize: vi.fn(async () => ({ ok: true as const, value: { ...RESULT, suggestDistill: true } })),
  }
  const b = await fixture(suggested.optimize, undefined, true, { distillSkill })
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountPromptOptimizer(ctx, REMOTE) })
    await fiber
    const actions = actionsOf(b.ctx)
    actions.start(SESSION, 'draft', () => {})
    await vi.waitFor(() => { expect(stateOf(b.ctx)?.phase).toBe('ready') })
    expect(stateOf(b.ctx)?.result?.suggestDistill).toBe(true)

    const preview = await actions.distillSkill(SESSION, 'draft', '优化后的提示词', [{ question: '芯片？', answer: 'STM32' }])
    expect(distillSkill).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION, draft: 'draft', optimized: '优化后的提示词', clarifications: [{ question: '芯片？', answer: 'STM32' }],
    }), expect.any(AbortSignal))
    expect((preview as { pendingDefinition?: string }).pendingDefinition).toBeDefined()

    await actions.distillSkill(SESSION, 'draft', '优化后的提示词', undefined, true)
    expect(distillSkill).toHaveBeenLastCalledWith(expect.objectContaining({ confirm: true }), expect.any(AbortSignal))
    await fiber.dispose()
  } finally { await b.ctx.fiber.dispose() }
})
