/**
 * Per-session optimization state: the store one mount shares with the
 * composer trigger and the preview panel, plus the pending-interaction
 * carrier that elects the panel into the composer seat.
 * @module @yimiliya/dsh-client-ui-prompt-optimizer/client
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptCandidate, PromptClarification, PromptInterviewQuestion, PromptOptimizeDirection, PromptOptimizeResult } from '@yimiliya/dsh-prompt-optimizer/types'

/** Identity of one pending queue item the round may rewrite in place. */
export type QueueItemId = InputState['queue'][number]['id']

/** Lifecycle of one optimization round. */
export type OptimizationPhase = 'running' | 'interviewing' | 'ready' | 'failed'

/** Complete optimization state for one Session. */
export interface OptimizationState {
  readonly phase: OptimizationPhase
  /** Draft text as it stood when the round started. */
  readonly draft: string
  /** Optimized texts the user rejected, oldest first. */
  readonly previousAttempts: readonly string[]
  /** Role slug styling the round; undefined for a generic rewrite. */
  readonly role: string | undefined
  /** Direction the round pushed toward; absent for the plain rules. */
  readonly direction?: PromptOptimizeDirection | undefined
  /** Pending queue item the round rewrites in place; absent for a draft round. */
  readonly queueItemId?: QueueItemId
  /** Interview questions awaiting answers; present only while `interviewing` (undefined while they load). */
  readonly questions?: readonly PromptInterviewQuestion[] | undefined
  /** Answer per question index — a picked option or free text; present only while `interviewing`. */
  readonly answers?: Readonly<Record<number, string>> | undefined
  /** `goal` when the running interview is acceptance-first; present only while `interviewing`. */
  readonly interviewMode?: 'goal' | undefined
  /** Acceptance criteria the goal interview's first answer compiled; carried into rounds like clarifications. */
  readonly goalCriteria?: readonly string[] | undefined
  /** Interview answers carried into rounds and preserved across reruns; absent for a plain round. */
  readonly clarifications?: readonly PromptClarification[] | undefined
  /** Scored alternatives from a candidates round; present only in `ready` after such a round. */
  readonly candidates?: readonly PromptCandidate[] | undefined
  /** Index into `candidates` the current `result` mirrors; present exactly with `candidates`. */
  readonly selectedCandidate?: number | undefined
  /** Result of the completed round; present only in `ready`. */
  readonly result: PromptOptimizeResult | undefined
  /** Failure message of the round; present only in `failed`. */
  readonly error: string | undefined
  /** Draft replacement the triggering composer entry registered for `apply`. */
  readonly apply: ((text: string) => void) | undefined
}

/**
 * Snapshot shape published to both entries: one state per live Session, keyed
 * by session id. Snapshots are deep-frozen at runtime; the writable type
 * serves the store's update draft.
 */
export type OptimizationSnapshot = Partial<Record<SessionId, OptimizationState>>

/**
 * Carrier published to the Session pending-interaction registry while a
 * preview is open; elects the panel through the composer chain.
 */
export class PromptOptimizationPreview implements SessionPendingInteractionBase {
  readonly kind = 'prompt-optimization'

  /**
   * Derive the preview seat's carrier key for one Session.
   * @param sessionId - Session whose preview seat the key addresses.
   * @returns the fixed carrier key of one Session's preview seat.
   */
  static keyOf(sessionId: SessionId): string {
    return `prompt-optimization:${sessionId}`
  }
  readonly key: string

  constructor(readonly sessionId: SessionId) {
    this.key = PromptOptimizationPreview.keyOf(sessionId)
  }
}

/**
 * Carrier published to the Session pending-interaction registry while the
 * prompt-library panel is open; elects the library panel into the composer
 * seat through its own registration.
 */
export class PromptLibraryPreview implements SessionPendingInteractionBase {
  readonly kind = 'prompt-library'

  /**
   * Derive the library seat's carrier key for one Session.
   * @param sessionId - Session whose library seat the key addresses.
   * @returns the fixed carrier key of one Session's library seat.
   */
  static keyOf(sessionId: SessionId): string {
    return `prompt-library:${sessionId}`
  }
  readonly key: string

  constructor(readonly sessionId: SessionId) {
    this.key = PromptLibraryPreview.keyOf(sessionId)
  }
}

/**
 * Carrier published to the Session pending-interaction registry while the
 * context checkup panel is open; elects the checkup panel into the composer
 * seat through its own registration.
 */
export class PromptContextPreview implements SessionPendingInteractionBase {
  readonly kind = 'prompt-context'

  /**
   * Derive the checkup seat's carrier key for one Session.
   * @param sessionId - Session whose checkup seat the key addresses.
   * @returns the fixed carrier key of one Session's checkup seat.
   */
  static keyOf(sessionId: SessionId): string {
    return `prompt-context:${sessionId}`
  }
  readonly key: string

  constructor(readonly sessionId: SessionId) {
    this.key = PromptContextPreview.keyOf(sessionId)
  }
}

/**
 * Create the optimization store owned by one mount.
 * @returns the store; mutation belongs to the mount's actions only.
 */
export function createOptimizationStore(): SnapshotStore<OptimizationSnapshot> {
  return createSnapshotStore<OptimizationSnapshot>({})
}
