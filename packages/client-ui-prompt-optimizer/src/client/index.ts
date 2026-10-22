/** Browser entry for the optional prompt-optimizer Remote contribution and composer UI. */
import type { Context } from '@deepseek-ai/cordis'
import optimizerRemote from '@yimiliya/dsh-api-prompt-optimizer/remote'
import { mountPromptOptimizer } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the experimental draft-optimization contribution.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountPromptOptimizer(ctx, optimizerRemote)
}
