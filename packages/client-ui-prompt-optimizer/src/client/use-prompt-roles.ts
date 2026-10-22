/** Shared roles-listing hook for the preview panel's picker. */
import { useEffect, useState } from 'react'
import type { PromptRoleSummary } from '@yimiliya/dsh-prompt-optimizer/types'

/**
 * Load the host's selectable role definitions once per verb identity; a failing
 * or empty listing keeps the caller on its no-roles presentation.
 * @param loadRoles - host verb listing role definitions.
 * @returns the loaded summaries; empty while loading or after a failure.
 */
export function usePromptRoles(loadRoles: () => Promise<readonly PromptRoleSummary[]>): readonly PromptRoleSummary[] {
  const [roles, setRoles] = useState<readonly PromptRoleSummary[]>([])
  useEffect(() => {
    let alive = true
    void loadRoles().then(
      (summaries) => { if (alive) setRoles(summaries) },
      (error: unknown) => { void error; if (alive) setRoles([]) },
    )
    return () => { alive = false }
  }, [loadRoles])
  return roles
}
