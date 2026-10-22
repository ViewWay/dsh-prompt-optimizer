/** Store snapshots and the pending-interaction carrier key. */
import { describe, expect, it } from 'vitest'
import { createOptimizationStore, PromptOptimizationPreview } from '../src/client/optimization.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const SESSION = 'session-1' as SessionId

describe('createOptimizationStore', () => {
  it('starts empty and records one state per session', () => {
    const store = createOptimizationStore()
    expect(Object.keys(store.getSnapshot())).toHaveLength(0)
    const apply = (): void => {}
    store.update((draft) => {
      draft[SESSION] = { phase: 'running', draft: '草稿', previousAttempts: [], role: undefined, result: undefined, error: undefined, apply }
    })
    expect(store.getSnapshot()[SESSION]).toMatchObject({ phase: 'running', draft: '草稿' })
    store.update((draft) => { Reflect.deleteProperty(draft, SESSION) })
    expect(store.getSnapshot()[SESSION]).toBeUndefined()
  })
})

describe('PromptOptimizationPreview', () => {
  it('derives a stable per-session key and the domain kind', () => {
    const preview = new PromptOptimizationPreview(SESSION)
    expect(preview.key).toBe(`prompt-optimization:${SESSION}`)
    expect(preview.key).toBe(PromptOptimizationPreview.keyOf(SESSION))
    expect(preview.kind).toBe('prompt-optimization')
    expect(preview.sessionId).toBe(SESSION)
  })
})
