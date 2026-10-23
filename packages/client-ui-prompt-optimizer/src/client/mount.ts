/** Source-safe lifecycle for the optional prompt-optimizer Remote and browser UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@yimiliya/dsh-api-prompt-optimizer/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PromptOptimizeTarget,
  PromptOptimizerSettings as PromptOptimizerSettingsSection,
  PromptRoleRecommendation,
  PromptRoleSummary,
  PromptVerifyResult,
} from '@yimiliya/dsh-prompt-optimizer/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { OptimizeButton } from './OptimizeButton.tsx'
import { PreviewPanel } from './PreviewPanel.tsx'
import { QueueItemOptimizeEntry } from './QueueItemOptimizeEntry.tsx'
import { PromptOptimizerSettings } from './PromptOptimizerSettings.tsx'
import { PromptOptimizerSettingsForm } from './settings-form.ts'
import { createOptimizationStore, PromptOptimizationPreview } from './optimization.ts'
import type { QueueItemId } from './optimization.ts'
import { en, NS, zh } from './locales.ts'

export const inject = ['remote', 'uiSession', 'slots', 'locale', 'configForms']

interface Round {
  readonly controller: AbortController
}

/** One optimization round request the mount is about to run. */
interface RoundRequest {
  readonly draft: string
  readonly previousAttempts: readonly string[]
  readonly apply: (text: string) => void
  readonly target: PromptOptimizeTarget
  readonly role: string | undefined
  /** Pending queue item the round rewrites in place; absent for a draft round. */
  readonly queueItemId: QueueItemId | undefined
}

/**
 * Read the active locale's self-describing label (for example `中文`), so the
 * host pins the rewrite to the agent's configured language.
 * @param locale - live locale runtime.
 * @returns the active language's own label; undefined when the interface
 * offers no language choice or the catalog carries no definition for the
 * active id.
 */
function activeLanguageLabel(locale: Context['locale']): string | undefined {
  const snapshot = locale.getLocale()
  // A single selectable language is unambiguous; the host default already matches it.
  if (snapshot.locales.length < 2) return undefined
  return snapshot.locales.find(candidate => candidate.id === snapshot.active)?.label
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const store = createOptimizationStore()
  const rounds = new Map<SessionId, Round>()
  const previews = new Map<SessionId, () => void>()
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PromptOptimizationPreview>(
    () => 0,
  )
  ctx.effect(() => () => {
    for (const round of rounds.values()) round.controller.abort(new Error('prompt optimizer unloaded'))
    for (const unpublish of previews.values()) unpublish()
    previews.clear()
  })

  const dismiss = (sessionId: SessionId): void => {
    const round = rounds.get(sessionId)
    if (round !== undefined) {
      round.controller.abort(new Error('preview closed'))
      rounds.delete(sessionId)
    }
    previews.get(sessionId)?.()
    previews.delete(sessionId)
    store.update((draft) => { Reflect.deleteProperty(draft, sessionId) })
  }

  const runRound = (sessionId: SessionId, state: RoundRequest): void => {
    const round = rounds.get(sessionId)
    if (round !== undefined) round.controller.abort(new Error('superseded by a new round'))
    const controller = new AbortController()
    rounds.set(sessionId, { controller })
    store.update((draft) => {
      draft[sessionId] = {
        phase: 'running', draft: state.draft, previousAttempts: state.previousAttempts, role: state.role,
        ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
        result: undefined, error: undefined, apply: state.apply,
      }
    })
    void (async () => {
      try {
        const language = activeLanguageLabel(ctx.locale)
        const result = await ctx.remote.promptOptimizer.optimize(
          {
            sessionId,
            text: state.draft,
            ...(state.previousAttempts.length > 0 ? { previousAttempts: state.previousAttempts } : {}),
            ...(state.target !== 'draft' ? { target: state.target } : {}),
            ...(state.role !== undefined ? { role: state.role } : {}),
            ...(language !== undefined ? { language } : {}),
          },
          controller.signal,
        )
        if (!result.ok) throw new Error(result.error.message)
        controller.signal.throwIfAborted()
        store.update((draft) => {
          draft[sessionId] = {
            // The resolved role (host defaultRole included) is what the round used.
            phase: 'ready', draft: state.draft, previousAttempts: state.previousAttempts, role: result.value.role,
            ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
            result: result.value, error: undefined, apply: state.apply,
          }
        })
      } catch (failure) {
        if (controller.signal.aborted && rounds.get(sessionId)?.controller === controller) return
        const message = failure instanceof Error ? failure.message : String(failure)
        store.update((draft) => {
          draft[sessionId] = {
            phase: 'failed', draft: state.draft, previousAttempts: state.previousAttempts, role: state.role,
            ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
            result: undefined, error: message, apply: state.apply,
          }
        })
      } finally {
        if (rounds.get(sessionId)?.controller === controller) rounds.delete(sessionId)
      }
    })()
  }

  /** Open the preview seat for one round, draft or queued item alike. */
  const openPreview = (sessionId: SessionId): void => {
    previews.get(sessionId)?.()
    const preview = new PromptOptimizationPreview(sessionId)
    previews.set(sessionId, registerPendingInteraction(preview, () => { dismiss(sessionId); return Promise.resolve() }))
  }

  /** Rewrite one pending queue item in place through the conversation service. */
  const applyQueueEdit = async (sessionId: SessionId, itemId: QueueItemId, text: string): Promise<void> => {
    const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
    if (conversation === undefined) {
      throw new Error('prompt optimizer: the conversation service is unavailable in this session')
    }
    await conversation.updateQueue(itemId, { kind: 'edit', content: [{ type: 'text', text }] })
  }

  /** Re-run one Session's round over the same draft with the given target and role. */
  const rerun = (sessionId: SessionId, target: PromptOptimizeTarget, role: string | undefined): void => {
    const state = store.getSnapshot()[sessionId]
    if (state === undefined || (state.queueItemId === undefined && state.apply === undefined)) return
    const rejected = state.result === undefined ? state.previousAttempts : [...state.previousAttempts, state.result.optimizedText]
    runRound(sessionId, {
      draft: state.draft, previousAttempts: rejected, apply: state.apply ?? (() => {}), target,
      role, queueItemId: state.queueItemId,
    })
  }

  const actions = {
    start: (sessionId: SessionId, text: string, apply: (text: string) => void, role?: string): void => {
      openPreview(sessionId)
      runRound(sessionId, { draft: text, previousAttempts: [], apply, target: 'draft', role, queueItemId: undefined })
    },
    startQueued: (sessionId: SessionId, itemId: QueueItemId, text: string, role?: string): void => {
      openPreview(sessionId)
      runRound(sessionId, {
        draft: text, previousAttempts: [], apply: () => {}, target: 'draft', role, queueItemId: itemId,
      })
    },
    apply: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state?.phase !== 'ready' || state.result === undefined) return
      if (state.queueItemId === undefined) {
        state.apply?.(state.result.optimizedText)
        dismiss(sessionId)
        return
      }
      const itemId = state.queueItemId
      const optimizedText = state.result.optimizedText
      store.update((draft) => {
        draft[sessionId] = { ...state, phase: 'running', result: undefined, error: undefined }
      })
      void (async () => {
        try {
          await applyQueueEdit(sessionId, itemId, optimizedText)
          dismiss(sessionId)
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          store.update((draft) => {
            draft[sessionId] = { ...state, phase: 'failed', result: undefined, error: message }
          })
        }
      })()
    },
    regenerate: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state === undefined) return
      rerun(sessionId, 'draft', state.role)
    },
    regenerateAsSystem: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state === undefined) return
      rerun(sessionId, 'system', state.role)
    },
    regenerateAsRole: (sessionId: SessionId, role: string | undefined): void => {
      rerun(sessionId, 'draft', role)
    },
    loadRoles: async (): Promise<readonly PromptRoleSummary[]> => {
      const result = await ctx.remote.promptOptimizer.listRoles(new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    recommendRoles: async (sessionId: SessionId, text: string): Promise<readonly PromptRoleRecommendation[]> => {
      const result = await ctx.remote.promptOptimizer.recommendRoles(
        { sessionId, ...(text !== '' ? { text } : {}) }, new AbortController().signal,
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    verifyCheck: async (sessionId: SessionId, criterion: string, command: string): Promise<PromptVerifyResult> => {
      const result = await ctx.remote.promptOptimizer.verify({ sessionId, criterion, command }, new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    saveToLibrary: async (sessionId: SessionId, title: string, text: string): Promise<void> => {
      const result = await ctx.remote.promptOptimizer.savePrompt({ sessionId, title, text }, new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
    },
    cancel: (sessionId: SessionId): void => { dismiss(sessionId) },
  }

  const injected = { ...actions, hooks: { optimization: store } }

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    { name: 'conversation.input.right', id: 'prompt-optimizer', locale: NS, inject: () => injected },
    OptimizeButton,
  ))
  // Best-effort: the per-queue-item entry needs the harness slot
  // `conversation.input.dock.queue.item`, which shipped after 0.2.1-rc.2.
  // Older hosts reject the unknown slot; skip the entry there.
  try {
    ctx.slots.inject('conversation.input.dock.queue.item' as never, () => ctx.slots.register(
      { name: 'conversation.input.dock.queue.item', id: 'prompt-optimizer', locale: NS, inject: () => injected } as never,
      QueueItemOptimizeEntry,
    ))
  } catch {
    ctx.logger.warn('prompt optimizer: queue-item slot unavailable on this host; the queue entry stays hidden')
  }
  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      select: ({ pendingInteraction }: ComposerChainProps): PromptOptimizationPreview | null =>
        pendingInteraction instanceof PromptOptimizationPreview ? pendingInteraction : null,
      locale: NS,
      inject: () => injected,
    },
    PreviewPanel,
  ))
  const settingsForm = new PromptOptimizerSettingsForm(
    ctx.configForms.get<PromptOptimizerSettingsSection>('prompt-optimizer'),
  )
  ctx.effect(() => () => { settingsForm.dispose() }, 'prompt optimizer: settings form')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    {
      name: 'plugins.bundle.config', key: '@yimiliya/dsh-prompt-optimizer-bundle',
      locale: NS, inject: () => ({ ...settingsForm.inject(), loadRoles: actions.loadRoles }),
    },
    PromptOptimizerSettings,
  ))
}

/**
 * Mount this experimental namespace without adding it to stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated prompt-optimizer Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountPromptOptimizer(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.promptOptimizer', 'uiSession', 'slots', 'locale', 'configForms'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
