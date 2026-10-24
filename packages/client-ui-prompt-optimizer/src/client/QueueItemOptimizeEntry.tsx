/** Per-row queue entry: opens the optimizer preview for one queued item. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconThinkOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OptimizationSnapshot, QueueItemId } from './optimization.ts'
import { queuePreviews } from './OptimizeButton.tsx'
import css from './QueueItemOptimizeEntry.module.css'

/** Pending inbox occurrence share this entry consumes (the queue slot's `item`). */
export interface QueueItemEntryItem {
  readonly id: QueueItemId
  readonly content: readonly { readonly type: string }[]
}

/** Inject face shared by the mount: the queued-round verb plus the state hook source. */
export interface QueueItemOptimizeEntryInjected {
  /** Rewrite one pending queue item in place through the conversation service.
   * @param sessionId - Session owning the pending item.
   * @param itemId - pending inbox occurrence identity.
   * @param text - complete queued message text.
   * @param role - optional role slug styling the round.
   */
  startQueued: (sessionId: SessionId, itemId: QueueItemId, text: string, role?: string) => void
  hooks: { optimization: { getSnapshot(): OptimizationSnapshot; subscribe(listener: () => void): () => void } }
}

/**
 * Queue-row owner share declared structurally: the harness slot
 * `conversation.input.dock.queue.item` is declared by no published harness
 * release up to 0.2.1-rc.3, so its `PropsRuntime` lookup is absent from
 * published slot maps.
 */
export interface QueueItemOptimizeEntryProps
  extends PropsLocale<'prompt-optimizer'>, InjectFace<QueueItemOptimizeEntryInjected> {
  /** Session owning the pending item. */
  sessionId: SessionId
  /** Pending inbox occurrence rendered by the queue row. */
  item: QueueItemEntryItem
}

/** Render one queued row's optimize action; non-text items are not optimizable. */
export function QueueItemOptimizeEntry(
  { sessionId, item, startQueued, useOptimization, t }: QueueItemOptimizeEntryProps,
) {
  const busy = useOptimization(snapshot => snapshot[sessionId]?.phase === 'running')
  const preview = queuePreviews([item])[0]
  if (preview === undefined) return null
  return (
    <Tooltip portal label={t('queueOptimize')} side="bottom" delayMs={500}>
      <Button
        className={css.action} size="sm" disabled={busy} aria-label={t('queueOptimize')}
        onClick={() => { startQueued(sessionId, preview.id, preview.text) }}
      >
        {busy ? <StateDot state="ongoing" /> : <IconThinkOutlineRegular size={14} />}
      </Button>
    </Tooltip>
  )
}
