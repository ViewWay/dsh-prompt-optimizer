/** Authenticated, cancellation-aware Client access to draft optimization. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@yimiliya/dsh-prompt-optimizer'
import type {
  PromptCandidatesRequest,
  PromptCandidatesResult,
  PromptDistillRequest,
  PromptDistillResult,
  PromptInterviewRequest,
  PromptInterviewResult,
  PromptLibraryDeleteRequest,
  PromptLibraryEntry,
  PromptLibrarySaveRequest,
  PromptMetricReportRequest,
  PromptMetricsSummary,
  PromptOptimizeRequest,
  PromptOptimizeResult,
  PromptRoleEvolveRequest,
  PromptRoleEvolveResult,
  PromptRoleRecommendation,
  PromptRoleRecommendRequest,
  PromptRoleSummary,
  PromptVerifyRequest,
  PromptVerifyResult,
} from '@yimiliya/dsh-prompt-optimizer/types'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental prompt-optimizer Remote controller. */
    promptOptimizerController: PromptOptimizerController
  }
}

/** Draft optimization never activates or submits to an Agent. */
export default class PromptOptimizerController extends TypertRemoteService {
  static inject = ['promptOptimizer', 'typert']

  constructor(ctx: Context) {
    super(ctx, 'promptOptimizerController', { namespace: 'promptOptimizer' })
  }

  /**
   * Optimize one conversation draft through the capability service.
   * @param request - session, draft text, rejected earlier results, and target.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the parsed optimization result for preview.
   */
  @Remote
  async optimize(request: PromptOptimizeRequest, signal: AbortSignal): Promise<PromptOptimizeResult> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.optimize(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/optimization-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Run one N-candidate round through the capability service: N differentiated
   * rewrites plus one judge scoring pass.
   * @param request - session, draft text, candidate count, and round conditioners.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the scored candidates with the recommended index.
   */
  @Remote
  async optimizeCandidates(request: PromptCandidatesRequest, signal: AbortSignal): Promise<PromptCandidatesResult> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.optimizeCandidates(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/candidates-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Distill one completed round into a durable agent skill file through the
   * capability service: a preview round, then a confirming write.
   * @param request - producing session, the round's texts, answers, and the phase selector.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the distilled skill's identity plus the pending definition on previews.
   */
  @Remote
  async distillSkill(request: PromptDistillRequest, signal: AbortSignal): Promise<PromptDistillResult> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.distillSkill(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/distill-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Interview the user about one draft through the capability service.
   * @param request - session, draft text, and output language.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the clarifying questions for the draft; empty when nothing was worth asking.
   */
  @Remote
  async interview(request: PromptInterviewRequest, signal: AbortSignal): Promise<PromptInterviewResult> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.interview(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/interview-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Record one user-decision metric the host cannot observe itself.
   * @param request - session, decision kind, and the round's route.
   * @param signal - Client cancellation or Remote contribution disposal.
   */
  @Remote
  async reportMetric(request: PromptMetricReportRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.reportMetric(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/metrics-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Aggregate the persisted local metrics for the settings card.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns decision counts, question totals, and adoption/verify rates.
   */
  @Remote
  async listMetrics(signal: AbortSignal): Promise<PromptMetricsSummary> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.listMetrics(signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/metrics-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Execute one acceptance criterion's check command in the Session workspace.
   * @param request - session, criterion statement, and substituted command.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the command's exit status and truncated output.
   */
  @Remote
  async verify(request: PromptVerifyRequest, signal: AbortSignal): Promise<PromptVerifyResult> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.verify(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      if ((error as { code?: string }).code === 'PROMPT_OPTIMIZER_COMMAND_BLOCKED') {
        throw new RemoteError('prompt-optimizer/verify-blocked', reason, { reason }, { cause: error })
      }
      throw new RemoteError('prompt-optimizer/verify-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Save one adopted optimization result into the durable prompt library.
   * @param request - producing session, title, and full text.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the persisted library entry.
   */
  @Remote
  async savePrompt(request: PromptLibrarySaveRequest, signal: AbortSignal): Promise<PromptLibraryEntry> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.savePrompt(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/library-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * List the prompt library's most recent entries, newest first.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns at most the service's entry cap of persisted prompts.
   */
  @Remote
  async listPrompts(signal: AbortSignal): Promise<readonly PromptLibraryEntry[]> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.listPrompts(signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/library-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Delete one stored entry from the durable prompt library.
   * @param request - requesting session and the entry's library id.
   * @param signal - Client cancellation or Remote contribution disposal.
   */
  @Remote
  async deletePrompt(request: PromptLibraryDeleteRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.ctx.promptOptimizer.deletePrompt(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/library-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * List the configured roles directory's selectable role definitions.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns every role summary the directory holds, sorted by slug.
   */
  @Remote
  async listRoles(signal: AbortSignal): Promise<readonly PromptRoleSummary[]> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.listRoles(signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/roles-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Recommend roles for the request context (draft plus pending inbox).
   * @param request - session whose inbox joins the context, plus optional draft text.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns at most three ranked role recommendations.
   */
  @Remote
  async recommendRoles(request: PromptRoleRecommendRequest, signal: AbortSignal): Promise<readonly PromptRoleRecommendation[]> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.recommendRoles(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/roles-failed', reason, { reason }, { cause: error })
    }
  }

  /**
   * Rewrite one role definition from the round's draft and optimized result.
   * @param request - producing session, role slug, and the round's two texts.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the rewritten role's slug, parsed name, and written byte size.
   */
  @Remote
  async evolveRole(request: PromptRoleEvolveRequest, signal: AbortSignal): Promise<PromptRoleEvolveResult> {
    signal.throwIfAborted()
    try {
      return await this.ctx.promptOptimizer.evolveRole(request, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('prompt-optimizer/role-evolve-failed', reason, { reason }, { cause: error })
    }
  }
}
