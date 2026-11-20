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
  PromptCandidatesResult,
  PromptClarification,
  PromptDistillResult,
  PromptLibraryEntry,
  PromptMetricsSummary,
  PromptOptimizeDirection,
  PromptOptimizeResult,
  PromptOptimizeTarget,
  PromptOptimizerSettings as PromptOptimizerSettingsSection,
  PromptRoleEvolveResult,
  PromptRoleRecommendation,
  PromptRoleSummary,
  PromptVerifyResult,
} from '@yimiliya/dsh-prompt-optimizer/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { LibraryPanel } from './LibraryPanel.tsx'
import { OptimizeButton } from './OptimizeButton.tsx'
import { PreviewPanel } from './PreviewPanel.tsx'
import { QueueItemOptimizeEntry } from './QueueItemOptimizeEntry.tsx'
import { PromptOptimizerSettings } from './PromptOptimizerSettings.tsx'
import { PromptOptimizerSettingsForm } from './settings-form.ts'
import { createOptimizationStore, PromptLibraryPreview, PromptOptimizationPreview } from './optimization.ts'
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
  /** Direction the round pushes toward; undefined applies the plain rules. */
  readonly direction: PromptOptimizeDirection | undefined
  /** True forces a rewrite round past the host's decline-to-optimize precheck. */
  readonly force: boolean
  /** Interview answers folded into the round as first-class requirements; absent for a plain round. */
  readonly clarifications?: readonly PromptClarification[] | undefined
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

/**
 * Mirror one candidates round into the preview's normal result slot: the
 * recommended candidate becomes `result`, so apply, rerun, library, and
 * role-evolution flows work unchanged while the candidate list sits beside it.
 * @param round - completed candidates round.
 * @param draft - draft text the round ran over, verbatim for a declined result.
 * @returns the preview result plus the selected candidate index.
 */
function resultOfCandidatesRound(round: PromptCandidatesResult, draft: string): {
  readonly result: PromptOptimizeResult
  readonly selected: number
} {
  if (round.skipped === true || round.candidates.length === 0) {
    return {
      result: {
        optimizedText: draft,
        changes: [],
        acceptance: [],
        provider: round.provider,
        model: round.model,
        ...(round.tier !== undefined ? { tier: round.tier } : {}),
        ...(round.skipped === true ? { skipped: true } : {}),
        ...(round.skipReason !== undefined ? { skipReason: round.skipReason } : {}),
      },
      selected: 0,
    }
  }
  const index = Math.max(0, Math.min(round.recommended, round.candidates.length - 1))
  const candidate = round.candidates[index]!
  return {
    result: {
      optimizedText: candidate.optimizedText,
      changes: candidate.changes,
      acceptance: candidate.acceptance,
      provider: round.provider,
      model: round.model,
      ...(round.tier !== undefined ? { tier: round.tier } : {}),
      ...(round.skills !== undefined && round.skills.length > 0 ? { skills: round.skills } : {}),
    },
    selected: index,
  }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const store = createOptimizationStore()
  const rounds = new Map<SessionId, Round>()
  const previews = new Map<SessionId, () => void>()
  const libraryPreviews = new Map<SessionId, () => void>()
  const libraryInserts = new Map<SessionId, (text: string) => void>()
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PromptOptimizationPreview>(
    () => 0,
  )
  const registerLibraryInteraction = ctx.uiSession.registerPendingInteraction<PromptLibraryPreview>(
    () => 0,
  )
  ctx.effect(() => () => {
    for (const round of rounds.values()) round.controller.abort(new Error('prompt optimizer unloaded'))
    for (const unpublish of previews.values()) unpublish()
    previews.clear()
    for (const unpublish of libraryPreviews.values()) unpublish()
    libraryPreviews.clear()
    libraryInserts.clear()
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

  /** Report one user-decision metric; fire-and-forget — telemetry never blocks a click. */
  const reportOutcome = (
    sessionId: SessionId,
    kind: 'adopted' | 'rejected' | 'decline-overridden',
    result: { readonly provider: string; readonly model: string; readonly tier?: string } | undefined,
  ): void => {
    if (result === undefined) return
    void ctx.remote.promptOptimizer.reportMetric(
      { sessionId, kind, provider: result.provider, model: result.model, ...(result.tier !== undefined ? { tier: result.tier as never } : {}) },
      new AbortController().signal,
    ).catch((error: unknown) => {
      ctx.logger.warn(`prompt optimizer: reporting the ${kind} metric failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Close one Session's library panel and drop its registered draft insert. */
  const closeLibrary = (sessionId: SessionId): void => {
    libraryPreviews.get(sessionId)?.()
    libraryPreviews.delete(sessionId)
    libraryInserts.delete(sessionId)
  }

  const runRound = (sessionId: SessionId, state: RoundRequest): void => {
    const round = rounds.get(sessionId)
    if (round !== undefined) round.controller.abort(new Error('superseded by a new round'))
    const controller = new AbortController()
    rounds.set(sessionId, { controller })
    store.update((draft) => {
      draft[sessionId] = {
        phase: 'running', draft: state.draft, previousAttempts: state.previousAttempts, role: state.role,
        direction: state.direction,
        ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
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
            ...(state.direction !== undefined ? { direction: state.direction } : {}),
            ...(state.force ? { force: true } : {}),
            ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
          },
          controller.signal,
        )
        if (!result.ok) throw new Error(result.error.message)
        controller.signal.throwIfAborted()
        store.update((draft) => {
          draft[sessionId] = {
            // The resolved role (host defaultRole included) is what the round used.
            phase: 'ready', draft: state.draft, previousAttempts: state.previousAttempts, role: result.value.role,
            direction: state.direction,
            ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
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
            direction: state.direction,
            ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
            ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
            result: undefined, error: message, apply: state.apply,
          }
        })
      } finally {
        if (rounds.get(sessionId)?.controller === controller) rounds.delete(sessionId)
      }
    })()
  }

  /**
   * Run one N-candidate round over the same request state a plain round uses:
   * the recommended candidate becomes the preview result and the scored list
   * sits beside it for comparison.
   */
  const runCandidates = (sessionId: SessionId, state: RoundRequest): void => {
    const round = rounds.get(sessionId)
    if (round !== undefined) round.controller.abort(new Error('superseded by a new round'))
    const controller = new AbortController()
    rounds.set(sessionId, { controller })
    store.update((draft) => {
      draft[sessionId] = {
        phase: 'running', draft: state.draft, previousAttempts: state.previousAttempts, role: state.role,
        direction: state.direction,
        ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
        ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
        result: undefined, error: undefined, apply: state.apply,
      }
    })
    void (async () => {
      try {
        const language = activeLanguageLabel(ctx.locale)
        const outcome = await ctx.remote.promptOptimizer.optimizeCandidates(
          {
            sessionId,
            text: state.draft,
            ...(state.role !== undefined ? { role: state.role } : {}),
            ...(language !== undefined ? { language } : {}),
            ...(state.direction !== undefined ? { direction: state.direction } : {}),
            ...(state.force ? { force: true } : {}),
            ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
          },
          controller.signal,
        )
        if (!outcome.ok) throw new Error(outcome.error.message)
        controller.signal.throwIfAborted()
        const { result, selected } = resultOfCandidatesRound(outcome.value, state.draft)
        store.update((draft) => {
          draft[sessionId] = {
            phase: 'ready', draft: state.draft, previousAttempts: state.previousAttempts, role: state.role,
            direction: state.direction,
            ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
            ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
            candidates: outcome.value.candidates,
            selectedCandidate: selected,
            result, error: undefined, apply: state.apply,
          }
        })
      } catch (failure) {
        if (controller.signal.aborted && rounds.get(sessionId)?.controller === controller) return
        const message = failure instanceof Error ? failure.message : String(failure)
        store.update((draft) => {
          draft[sessionId] = {
            phase: 'failed', draft: state.draft, previousAttempts: state.previousAttempts, role: state.role,
            direction: state.direction,
            ...(state.clarifications !== undefined && state.clarifications.length > 0 ? { clarifications: state.clarifications } : {}),
            ...(state.queueItemId !== undefined ? { queueItemId: state.queueItemId } : {}),
            result: undefined, error: message, apply: state.apply,
          }
        })
      } finally {
        if (rounds.get(sessionId)?.controller === controller) rounds.delete(sessionId)
      }
    })()
  }

  /**
   * Interview the user about one draft: fetch clarifying questions, hold them
   * in the `interviewing` phase, and fall straight into a plain round when the
   * model finds nothing worth asking.
   */
  const runInterview = (sessionId: SessionId, base: RoundRequest): void => {
    const round = rounds.get(sessionId)
    if (round !== undefined) round.controller.abort(new Error('superseded by a new round'))
    const controller = new AbortController()
    rounds.set(sessionId, { controller })
    store.update((draft) => {
      draft[sessionId] = {
        phase: 'interviewing', draft: base.draft, previousAttempts: base.previousAttempts, role: base.role,
        direction: base.direction,
        ...(base.queueItemId !== undefined ? { queueItemId: base.queueItemId } : {}),
        questions: undefined, answers: {},
        result: undefined, error: undefined, apply: base.apply,
      }
    })
    void (async () => {
      try {
        const language = activeLanguageLabel(ctx.locale)
        const result = await ctx.remote.promptOptimizer.interview(
          { sessionId, text: base.draft, ...(language !== undefined ? { language } : {}) },
          controller.signal,
        )
        if (!result.ok) throw new Error(result.error.message)
        controller.signal.throwIfAborted()
        if (result.value.questions.length === 0) {
          runRound(sessionId, { ...base, force: false })
          return
        }
        store.update((draft) => {
          draft[sessionId] = { ...draft[sessionId]!, questions: result.value.questions, answers: {} }
        })
      } catch (failure) {
        if (controller.signal.aborted && rounds.get(sessionId)?.controller === controller) return
        const message = failure instanceof Error ? failure.message : String(failure)
        store.update((draft) => {
          draft[sessionId] = {
            phase: 'failed', draft: base.draft, previousAttempts: base.previousAttempts, role: base.role,
            direction: base.direction,
            ...(base.queueItemId !== undefined ? { queueItemId: base.queueItemId } : {}),
            result: undefined, error: message, apply: base.apply,
          }
        })
      } finally {
        if (rounds.get(sessionId)?.controller === controller) rounds.delete(sessionId)
      }
    })()
  }

  /** Open the preview seat for one round, draft or queued item alike. */
  const openPreview = (sessionId: SessionId): void => {
    closeLibrary(sessionId)
    previews.get(sessionId)?.()
    const preview = new PromptOptimizationPreview(sessionId)
    previews.set(sessionId, registerPendingInteraction(preview, () => { dismiss(sessionId); return Promise.resolve() }))
  }

  /** Open the library panel for one Session, registering how a picked entry replaces the draft. */
  const openLibrary = (sessionId: SessionId, insert: (text: string) => void): void => {
    closeLibrary(sessionId)
    libraryInserts.set(sessionId, insert)
    const preview = new PromptLibraryPreview(sessionId)
    libraryPreviews.set(sessionId, registerLibraryInteraction(preview, () => { closeLibrary(sessionId); return Promise.resolve() }))
  }

  /** Rewrite one pending queue item in place through the conversation service. */
  const applyQueueEdit = async (sessionId: SessionId, itemId: QueueItemId, text: string): Promise<void> => {
    const conversation = ctx.sessions.scope(sessionId)?.get('conversation')
    if (conversation === undefined) {
      throw new Error('prompt optimizer: the conversation service is unavailable in this session')
    }
    await conversation.updateQueue(itemId, { kind: 'edit', content: [{ type: 'text', text }] })
  }

  /** Re-run one Session's round over the same draft with the given target and role; an undefined
   * direction keeps the state's current direction. */
  const rerun = (
    sessionId: SessionId,
    target: PromptOptimizeTarget,
    role: string | undefined,
    direction?: PromptOptimizeDirection,
  ): void => {
    const state = store.getSnapshot()[sessionId]
    if (state === undefined || (state.queueItemId === undefined && state.apply === undefined)) return
    // An explicit rerun means the user asked for a rewrite: force past the decline precheck.
    // A finished result the rerun discards counts as rejected; a declined round never does.
    if (state.result !== undefined && state.result.skipped !== true) {
      reportOutcome(sessionId, 'rejected', state.result)
    }
    const rejected = state.result === undefined ? state.previousAttempts : [...state.previousAttempts, state.result.optimizedText]
    runRound(sessionId, {
      draft: state.draft, previousAttempts: rejected, apply: state.apply ?? (() => {}), target,
      role, direction: direction ?? state.direction, force: true, clarifications: state.clarifications, queueItemId: state.queueItemId,
    })
  }

  const actions = {
    start: (sessionId: SessionId, text: string, apply: (text: string) => void, role?: string): void => {
      openPreview(sessionId)
      runRound(sessionId, { draft: text, previousAttempts: [], apply, target: 'draft', role, direction: undefined, force: false, queueItemId: undefined })
    },
    startQueued: (sessionId: SessionId, itemId: QueueItemId, text: string, role?: string): void => {
      openPreview(sessionId)
      runRound(sessionId, {
        draft: text, previousAttempts: [], apply: () => {}, target: 'draft', role, direction: undefined, force: false, queueItemId: itemId,
      })
    },
    apply: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state?.phase !== 'ready' || state.result === undefined) return
      reportOutcome(sessionId, 'adopted', state.result)
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
    regenerateForced: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state === undefined) return
      if (state.result?.skipped === true) {
        reportOutcome(sessionId, 'decline-overridden', state.result)
      }
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
    regenerateWithDirection: (sessionId: SessionId, direction: PromptOptimizeDirection): void => {
      rerun(sessionId, 'draft', store.getSnapshot()[sessionId]?.role, direction)
    },
    regenerateCandidates: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state === undefined || (state.queueItemId === undefined && state.apply === undefined)) return
      // An explicit candidates round asks for alternatives: the discarded result counts as rejected.
      if (state.result !== undefined && state.result.skipped !== true) {
        reportOutcome(sessionId, 'rejected', state.result)
      }
      runCandidates(sessionId, {
        draft: state.draft, previousAttempts: state.previousAttempts, apply: state.apply ?? (() => {}), target: 'draft',
        role: state.role, direction: state.direction, force: true, clarifications: state.clarifications, queueItemId: state.queueItemId,
      })
    },
    selectCandidate: (sessionId: SessionId, index: number): void => {
      const state = store.getSnapshot()[sessionId]
      if (state?.phase !== 'ready' || state.result === undefined || state.candidates === undefined) return
      const candidate = state.candidates[index]
      if (candidate === undefined || index === state.selectedCandidate) return
      const prior = state.result
      store.update((draft) => {
        draft[sessionId] = {
          ...state,
          selectedCandidate: index,
          result: {
            optimizedText: candidate.optimizedText,
            changes: candidate.changes,
            acceptance: candidate.acceptance,
            provider: prior.provider,
            model: prior.model,
            ...(prior.tier !== undefined ? { tier: prior.tier } : {}),
            ...(prior.skills !== undefined && prior.skills.length > 0 ? { skills: prior.skills } : {}),
          },
        }
      })
    },
    startInterview: (sessionId: SessionId, text: string, apply: (text: string) => void, role?: string): void => {
      openPreview(sessionId)
      runInterview(sessionId, { draft: text, previousAttempts: [], apply, target: 'draft', role, direction: undefined, force: false, queueItemId: undefined })
    },
    startInterviewQueued: (sessionId: SessionId, itemId: QueueItemId, text: string, role?: string): void => {
      openPreview(sessionId)
      runInterview(sessionId, { draft: text, previousAttempts: [], apply: () => {}, target: 'draft', role, direction: undefined, force: false, queueItemId: itemId })
    },
    reInterview: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state === undefined || (state.queueItemId === undefined && state.apply === undefined)) return
      runInterview(sessionId, {
        draft: state.draft, previousAttempts: state.previousAttempts, apply: state.apply ?? (() => {}), target: 'draft',
        role: state.role, direction: state.direction, force: false, queueItemId: state.queueItemId,
      })
    },
    answerInterview: (sessionId: SessionId, index: number, value: string): void => {
      const state = store.getSnapshot()[sessionId]
      if (state?.phase !== 'interviewing') return
      store.update((draft) => {
        draft[sessionId] = { ...state, answers: { ...state.answers, [index]: value } }
      })
    },
    submitInterview: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state?.phase !== 'interviewing' || state.questions === undefined) return
      if (state.queueItemId === undefined && state.apply === undefined) return
      const clarifications: PromptClarification[] = state.questions
        .flatMap((question, index) => {
          const answer = (state.answers ?? {})[index]?.trim()
          return answer !== undefined && answer !== '' ? [{ question: question.text, answer }] : []
        })
      // An interviewed draft always deserves the rewrite: force past the decline precheck.
      runRound(sessionId, {
        draft: state.draft, previousAttempts: state.previousAttempts, apply: state.apply ?? (() => {}), target: 'draft',
        role: state.role, direction: state.direction, force: true,
        ...(clarifications.length > 0 ? { clarifications } : {}),
        queueItemId: state.queueItemId,
      })
    },
    skipInterview: (sessionId: SessionId): void => {
      const state = store.getSnapshot()[sessionId]
      if (state?.phase !== 'interviewing') return
      if (state.queueItemId === undefined && state.apply === undefined) return
      runRound(sessionId, {
        draft: state.draft, previousAttempts: state.previousAttempts, apply: state.apply ?? (() => {}), target: 'draft',
        role: state.role, direction: state.direction, force: false, queueItemId: state.queueItemId,
      })
    },
    openLibrary: (sessionId: SessionId, insert: (text: string) => void): void => {
      openLibrary(sessionId, insert)
    },
    loadRoles: async (): Promise<readonly PromptRoleSummary[]> => {
      const result = await ctx.remote.promptOptimizer.listRoles(new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    loadMetrics: async (): Promise<PromptMetricsSummary> => {
      const result = await ctx.remote.promptOptimizer.listMetrics(new AbortController().signal)
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
      // The rebuilt RemoteError keeps the stable code the panel branches on (verify-blocked).
      if (!result.ok) throw result.error
      return result.value
    },
    saveToLibrary: async (sessionId: SessionId, title: string, text: string): Promise<void> => {
      const result = await ctx.remote.promptOptimizer.savePrompt({ sessionId, title, text }, new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
    },
    evolveRole: async (sessionId: SessionId, role: string, draft: string, optimized: string, confirm?: boolean): Promise<PromptRoleEvolveResult> => {
      const result = await ctx.remote.promptOptimizer.evolveRole(
        { sessionId, role, draft, optimized, ...(confirm === true ? { confirm: true } : {}) }, new AbortController().signal,
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    distillSkill: async (sessionId: SessionId, draft: string, optimized: string, clarifications?: readonly PromptClarification[], confirm?: boolean): Promise<PromptDistillResult> => {
      const result = await ctx.remote.promptOptimizer.distillSkill(
        {
          sessionId, draft, optimized,
          ...(clarifications !== undefined && clarifications.length > 0 ? { clarifications } : {}),
          ...(confirm === true ? { confirm: true } : {}),
        },
        new AbortController().signal,
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    cancel: (sessionId: SessionId): void => { dismiss(sessionId) },
  }

  /** Inject face the library panel registration serves: library verbs plus the registered draft insert. */
  const libraryActions = {
    listLibrary: async (): Promise<readonly PromptLibraryEntry[]> => {
      const result = await ctx.remote.promptOptimizer.listPrompts(new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    deleteLibraryEntry: async (sessionId: SessionId, id: string): Promise<void> => {
      const result = await ctx.remote.promptOptimizer.deletePrompt({ sessionId, id }, new AbortController().signal)
      if (!result.ok) throw new Error(result.error.message)
    },
    insertDraft: (sessionId: SessionId, text: string): void => {
      libraryInserts.get(sessionId)?.(text)
      closeLibrary(sessionId)
    },
    reoptimize: (sessionId: SessionId, text: string): void => {
      const insert = libraryInserts.get(sessionId) ?? (() => {})
      closeLibrary(sessionId)
      actions.start(sessionId, text, insert)
    },
    closeLibrary: (sessionId: SessionId): void => { closeLibrary(sessionId) },
  }

  const injected = { ...actions, hooks: { optimization: store } }

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    { name: 'conversation.input.right', id: 'prompt-optimizer', locale: NS, inject: () => injected },
    OptimizeButton,
  ))
  // Best-effort: the per-queue-item entry needs the harness slot
  // `conversation.input.dock.queue.item`, which no published harness
  // release declares up to 0.2.1-rc.5.
  // Hosts that never declared the key make inject() wait silently (spec()
  // stays undefined) while a declared key can only reject inside the register
  // callback; inject() runs either way so a host declaring the slot later
  // still gets the entry, and the flag surfaces the degradation once on the
  // settings page.
  let queueEntryUnavailable = ctx.slots.spec('conversation.input.dock.queue.item' as never) === undefined
  try {
    ctx.slots.inject('conversation.input.dock.queue.item' as never, () => ctx.slots.register(
      { name: 'conversation.input.dock.queue.item', id: 'prompt-optimizer', locale: NS, inject: () => injected } as never,
      QueueItemOptimizeEntry,
    ))
  } catch {
    queueEntryUnavailable = true
  }
  if (queueEntryUnavailable) {
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
  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      select: ({ pendingInteraction }: ComposerChainProps): PromptLibraryPreview | null =>
        pendingInteraction instanceof PromptLibraryPreview ? pendingInteraction : null,
      locale: NS,
      inject: () => libraryActions,
    },
    LibraryPanel,
  ))
  const settingsForm = new PromptOptimizerSettingsForm(
    ctx.configForms.get<PromptOptimizerSettingsSection>('prompt-optimizer'),
  )
  ctx.effect(() => () => { settingsForm.dispose() }, 'prompt optimizer: settings form')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    {
      name: 'plugins.bundle.config', key: '@yimiliya/dsh-prompt-optimizer-bundle',
      locale: NS, inject: () => ({ ...settingsForm.inject(), loadRoles: actions.loadRoles, loadMetrics: actions.loadMetrics, queueEntryUnavailable }),
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
