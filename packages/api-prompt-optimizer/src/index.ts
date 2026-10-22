/** Authenticated, cancellation-aware Client access to draft optimization. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@yimiliya/dsh-prompt-optimizer'
import type {
  PromptLibraryEntry,
  PromptLibrarySaveRequest,
  PromptOptimizeRequest,
  PromptOptimizeResult,
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
}
