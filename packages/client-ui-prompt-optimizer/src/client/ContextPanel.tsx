/** Composer takeover: one deterministic context checkup — system-prompt sizing, skill sizing, findings. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptContextCheckResult, PromptContextFinding } from '@yimiliya/dsh-prompt-optimizer/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptContextPreview } from './optimization.ts'
import css from './ContextPanel.module.css'

/** Host verbs the mount injects: the scan plus the close. */
export interface ContextPanelInjected {
  /** Run the deterministic scan for the Session; a failing call surfaces the error state. */
  contextCheck: (sessionId: SessionId) => Promise<PromptContextCheckResult>
  /** Close the checkup panel. */
  closeContext: (sessionId: SessionId) => void
}

/** Composer-chain owner props plus the injected checkup verbs. */
export type ContextPanelProps =
  Pick<PropsRuntime<'conversation.composer'>, 'sessionId'>
  & { matched: PromptContextPreview }
  & PropsLocale<'prompt-optimizer'> & InjectFace<ContextPanelInjected>

/** Locale key naming each finding kind's chip. */
const FINDING_LABEL_KEYS: Readonly<Record<PromptContextFinding['kind'], 'findingOversizedSection' | 'findingDuplicateSection' | 'findingOversizedSkill' | 'findingDuplicateSkill' | 'findingStaleReference'>> = {
  'oversized-section': 'findingOversizedSection',
  'duplicate-section': 'findingDuplicateSection',
  'oversized-skill': 'findingOversizedSkill',
  'duplicate-skill': 'findingDuplicateSkill',
  'stale-skill-reference': 'findingStaleReference',
}

/** Scan lifecycle of one checkup load. */
type ScanPhase = 'loading' | 'ready' | 'failed'

/** Render one Session's context checkup in the composer seat. */
export function ContextPanel({ sessionId, contextCheck, closeContext, t }: ContextPanelProps) {
  const [phase, setPhase] = useState<ScanPhase>('loading')
  const [report, setReport] = useState<PromptContextCheckResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = (): void => {
    setPhase('loading')
    setError(undefined)
    void (async () => {
      try {
        setReport(await contextCheck(sessionId))
        setPhase('ready')
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
        setPhase('failed')
      }
    })()
  }
  // Reload on open; the panel stays mounted only while its carrier is pending.
  useEffect(load, [contextCheck, sessionId])

  return (
    <div className={css.frame}>
      <section className={css.card} aria-label={t('contextTitle')}>
        <header className={css.header}>
          <span className={css.title}>{t('contextTitle')}</span>
          <Button size="sm" type="button" aria-label={t('cancel')} onClick={() => { closeContext(sessionId) }}>
            <IconCloseOutlineRegular size={14} />
          </Button>
        </header>
        <div className={css.body}>
          {phase === 'loading'
            ? <p className={css.hint} data-testid="context-loading">{t('contextLoading')}</p>
            : null}
          {phase === 'failed'
            ? <div className={css.hint} data-testid="context-error" role="alert">
              <p className={css.failedText}>{t('contextError', { message: error ?? '' })}</p>
              <Button size="sm" type="button" onClick={() => { load() }}>{t('contextRerun')}</Button>
            </div>
            : null}
          {phase === 'ready' && report !== undefined
            ? <>
              {report.systemPrompt !== undefined
                ? <div className={css.hint} data-testid="context-system">
                  <span className={css.sectionTitle}>{t('contextSystemTitle')}</span>
                  <span>{t('contextSystemTokens', {
                    tokens: String(report.systemPrompt.estimatedTokens),
                    chars: String(report.systemPrompt.totalChars),
                  })}</span>
                  <ul className={css.list}>
                    {report.systemPrompt.sections.map(section => (
                      <li key={section.name}>
                        {t('contextSection', {
                          name: section.name,
                          chars: String(section.chars),
                          share: `${Math.round(section.share * 100)}%`,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
                : null}
              <div className={css.hint} data-testid="context-skills">
                {t('contextSkillsLine', {
                  count: String(report.skills.count),
                  invocable: String(report.skills.modelInvocable),
                  scanned: String(report.skills.scannedBodies),
                  chars: String(report.skills.totalBodyChars),
                })}
              </div>
              <div className={css.hint}>
                <span className={css.sectionTitle}>{t('contextFindings')}</span>
                {report.findings.length === 0
                  ? <span data-testid="context-clean">{t('contextNoFindings')}</span>
                  : <ul className={css.list} data-testid="context-findings">
                    {report.findings.map(finding => (
                      <li key={`${finding.kind}:${finding.subject}`}>
                        <span className={css.findingKind}>{t(FINDING_LABEL_KEYS[finding.kind])}</span>
                        <span className={css.findingSubject}>{finding.subject}</span>
                        <span> — {finding.detail}</span>
                      </li>
                    ))}
                  </ul>}
              </div>
            </>
            : null}
        </div>
      </section>
    </div>
  )
}
