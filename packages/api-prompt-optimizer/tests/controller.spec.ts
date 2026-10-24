/** Remote forwarding: passthrough success, abort passthrough, typed failure wrap. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { PromptOptimizeResult } from '@yimiliya/dsh-prompt-optimizer/types'
import PromptOptimizerController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

const RESULT: PromptOptimizeResult = {
  optimizedText: '优化后的提示词',
  changes: ['补充了输出格式'],
  acceptance: [
    { text: '脚本存在且可运行', kind: 'mechanical', commandTemplate: 'ls script.sh' },
    { text: '与用户确认了日志格式', kind: 'llm' },
  ],
  provider: 'current-route',
  model: 'current-model',
}

function fixture(optimize = vi.fn(async () => RESULT)): { api: PromptOptimizerController; optimize: typeof optimize } {
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('promptOptimizer', { optimize } as never)
  return { api: new PromptOptimizerController(ctx), optimize }
}

it('forwards the request and signal to the capability service unchanged', async () => {
  const { api, optimize } = fixture()
  const signal = new AbortController().signal
  const request = { sessionId: 'session-1' as never, text: '草稿' }

  await expect(api.optimize(request, signal)).resolves.toEqual(RESULT)
  expect(optimize).toHaveBeenCalledExactlyOnceWith(request, signal)
})

it('propagates a caller abort instead of wrapping it as a Remote error', async () => {
  const { api } = fixture()
  const controller = new AbortController()
  controller.abort(new Error('caller stopped'))

  await expect(api.optimize({ sessionId: 'session-1' as never, text: 'draft' }, controller.signal))
    .rejects.toThrow('caller stopped')
})

it('wraps one capability failure as the typed Remote error with its reason', async () => {
  const failure = new Error('provider failed') as Error & { code?: string }
  failure.code = 'SERVER'
  const { api } = fixture(vi.fn(async () => { throw failure }))

  await expect(api.optimize({ sessionId: 'session-1' as never, text: 'draft' }, new AbortController().signal))
    .rejects.toMatchObject({ message: 'provider failed', details: { reason: 'provider failed' }, cause: failure })
})

const VERIFY_RESULT = { passed: true, exitCode: 0, timedOut: false, output: '$ ls\nok', durationMs: 4 }

it('forwards a verify request to the capability service unchanged', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const verify = vi.fn(async () => VERIFY_RESULT)
  ctx.provide('promptOptimizer', { verify } as never)
  const api = new PromptOptimizerController(ctx)
  const request = { sessionId: 'session-1' as never, criterion: '脚本存在', command: 'ls script.sh' }

  await expect(api.verify(request, new AbortController().signal)).resolves.toEqual(VERIFY_RESULT)
  expect(verify).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal))
})

it('wraps a verify failure as the typed Remote error', async () => {
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('promptOptimizer', { verify: vi.fn(async () => { throw new Error('no shell') }) } as never)
  const api = new PromptOptimizerController(ctx)

  await expect(api.verify({ sessionId: 'session-1' as never, criterion: 'c', command: 'ls' }, new AbortController().signal))
    .rejects.toMatchObject({ details: { reason: 'no shell' } })
})

it('forwards a library save and wraps its failure typed', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const savePrompt = vi.fn(async () => ({ id: 'entry-1', title: '标题', text: '内容', createdAt: '2026-10-20T00:00:00.000Z', sourceSessionId: 'session-1' as never }))
  ctx.provide('promptOptimizer', { savePrompt } as never)
  const api = new PromptOptimizerController(ctx)
  const request = { sessionId: 'session-1' as never, title: '标题', text: '内容' }

  await expect(api.savePrompt(request, new AbortController().signal)).resolves.toMatchObject({ id: 'entry-1' })
  expect(savePrompt).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal))

  const failing = new Context()
  roots.push(failing)
  failing.provide('promptOptimizer', { savePrompt: vi.fn(async () => { throw new Error('no storage domain') }) } as never)
  const failingApi = new PromptOptimizerController(failing)
  await expect(failingApi.savePrompt(request, new AbortController().signal))
    .rejects.toMatchObject({ details: { reason: 'no storage domain' } })
})

it('forwards a roles listing and wraps its failure typed', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const listRoles = vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员' }])
  ctx.provide('promptOptimizer', { listRoles } as never)
  const api = new PromptOptimizerController(ctx)

  await expect(api.listRoles(new AbortController().signal)).resolves.toEqual([
    { id: 'imp-code-reviewer', name: '代码评审员' },
  ])
  expect(listRoles).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))

  const failing = new Context()
  roots.push(failing)
  failing.provide('promptOptimizer', { listRoles: vi.fn(async () => { throw new Error('rolesDir unset') }) } as never)
  const failingApi = new PromptOptimizerController(failing)
  await expect(failingApi.listRoles(new AbortController().signal))
    .rejects.toMatchObject({ details: { reason: 'rolesDir unset' } })
})

it('forwards a role evolution and wraps its failure typed', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const EVOLVED = { role: 'imp-code-reviewer', name: '代码评审员', bytes: 128 }
  const evolveRole = vi.fn(async () => EVOLVED)
  ctx.provide('promptOptimizer', { evolveRole } as never)
  const api = new PromptOptimizerController(ctx)
  const request = { sessionId: 'session-1' as never, role: 'imp-code-reviewer', draft: '草稿', optimized: '优化后' }

  await expect(api.evolveRole(request, new AbortController().signal)).resolves.toEqual(EVOLVED)
  expect(evolveRole).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal))

  const failing = new Context()
  roots.push(failing)
  failing.provide('promptOptimizer', { evolveRole: vi.fn(async () => { throw new Error('no adapter') }) } as never)
  const failingApi = new PromptOptimizerController(failing)
  await expect(failingApi.evolveRole(request, new AbortController().signal))
    .rejects.toMatchObject({ details: { reason: 'no adapter' } })
})
