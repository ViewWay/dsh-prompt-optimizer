/** Compact composer trigger: starts one optimization round for the draft. */
import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconThinkOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PromptRoleRecommendation,
  PromptRoleSummary,
} from '@yimiliya/dsh-prompt-optimizer/types'
import type { OptimizationSnapshot, QueueItemId } from './optimization.ts'
import css from './OptimizeButton.module.css'

/** One queued message the trigger can optimize in place. */
export interface QueueItemPreview {
  readonly id: QueueItemId
  readonly text: string
}

/**
 * Project one pending queue onto id-plus-text previews: only messages whose
 * content is entirely text blocks are offered, so an image queue item never
 * reaches the optimizer.
 */
export function queuePreviews(queue: readonly {
  readonly id: QueueItemId
  readonly content: readonly { readonly type: string }[]
}[]): readonly QueueItemPreview[] {
  return queue.flatMap((message) => {
    const texts = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
    const text = texts.join('\n').trim()
    return message.content.every(block => block.type === 'text') && text !== ''
      ? [{ id: message.id, text }]
      : []
  })
}

/** Host verbs injected by the mount: round lifecycle over the Remote. */
export interface OptimizeButtonActions {
  /** Start one round for the current draft; `apply` replaces the draft on acceptance.
   * @param sessionId - Session owning the draft.
   * @param text - complete current draft text.
   * @param apply - draft replacement registered by this triggering entry.
   * @param role - optional role slug styling the round.
   */
  start: (sessionId: SessionId, text: string, apply: (text: string) => void, role?: string) => void
  /** Rewrite one pending queue item in place through the conversation service.
   * @param sessionId - Session owning the pending item.
   * @param itemId - pending inbox occurrence identity.
   * @param text - complete queued message text.
   * @param role - optional role slug styling the round.
   */
  startQueued: (sessionId: SessionId, itemId: QueueItemId, text: string, role?: string) => void
  /** List the host's selectable role definitions; a failing or empty listing hides the recommendation chips. */
  loadRoles: () => Promise<readonly PromptRoleSummary[]>
  /** Rank roles for the draft plus pending inbox context; a failing call hides the chips. */
  recommendRoles: (sessionId: SessionId, text: string) => Promise<readonly PromptRoleRecommendation[]>
}

/** Inject face shared by the mount: round verbs plus the state hook source. */
export interface OptimizeButtonInjected extends OptimizeButtonActions {
  hooks: { optimization: { getSnapshot(): OptimizationSnapshot; subscribe(listener: () => void): () => void } }
}

/** Standard Session props plus the injected round verbs. */
export type OptimizeButtonProps =
  Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useInput' | 'inputActions'>
  & PropsLocale<'prompt-optimizer'> & InjectFace<OptimizeButtonInjected>

/** Render the toolbar trigger; the preview panel owns everything after the click. */
export function OptimizeButton(
  { sessionId, useInput, inputActions, start, startQueued, loadRoles, recommendRoles, useOptimization, t }: OptimizeButtonProps,
) {
  const draft = useInput(input => input.draft)
  const rawQueue = useInput(input => input.queue)
  const queued = useMemo(() => queuePreviews(rawQueue), [rawQueue])
  const busy = useOptimization(snapshot => snapshot[sessionId]?.phase === 'running')
  const [roles, setRoles] = useState<readonly PromptRoleSummary[]>([])
  const [recommendations, setRecommendations] = useState<readonly PromptRoleRecommendation[]>([])
  useEffect(() => {
    let alive = true
    // A failing roles listing keeps the generic optimizer; the chips stay hidden.
    void loadRoles().then(
      (summaries) => { if (alive) setRoles(summaries) },
      (error: unknown) => { void error; if (alive) setRoles([]) },
    )
    return () => { alive = false }
  }, [loadRoles])
  const firstQueued = queued[0]
  const contextText = draft.trim() === '' && firstQueued !== undefined ? firstQueued.text : draft
  useEffect(() => {
    if (roles.length === 0 || contextText.trim() === '') {
      setRecommendations([])
      return
    }
    let alive = true
    // A failing recommendation keeps the plain trigger; the chips stay hidden.
    void recommendRoles(sessionId, contextText).then(
      (ranked) => { if (alive) setRecommendations(ranked) },
      (error: unknown) => { void error; if (alive) setRecommendations([]) },
    )
    return () => { alive = false }
  }, [roles.length, contextText, recommendRoles, sessionId])
  const draftReady = draft.trim() !== ''
  const queueReady = !draftReady && queued.length > 0
  const disabled = busy || (!draftReady && !queueReady)

  const startWith = (role?: string): void => {
    if (disabled) return
    if (draftReady) {
      start(sessionId, draft, (text) => { inputActions.setDraft(text) }, role)
      return
    }
    const item = queued[0]
    if (item !== undefined) startQueued(sessionId, item.id, item.text, role)
  }

  return (
    <Tooltip label={t(busy ? 'optimizing' : draftReady || queueReady ? 'optimize' : 'optimizeDisabled')} side="top" portal>
      <span className={css.triggerAnchor}>
        {recommendations.length > 0 && !busy && (
          <span className={css.recommendRow}>
            {recommendations.map(recommendation => (
              <button
                key={recommendation.id} type="button" className={css.recommendChip}
                aria-label={t('recommendRole', { name: recommendation.name })}
                onClick={() => { startWith(recommendation.id) }}
              >
                {recommendation.name}
              </button>
            ))}
          </span>
        )}
        <Button className={css.trigger} size="sm" disabled={disabled} aria-label={t('optimize')} onClick={() => { startWith() }}>
          {busy ? <StateDot state="ongoing" /> : <IconThinkOutlineRegular size={18} />}
        </Button>
      </span>
    </Tooltip>
  )
}
