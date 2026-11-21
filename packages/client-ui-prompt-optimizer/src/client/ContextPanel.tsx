/** Composer takeover: one deterministic context checkup — system-prompt sizing, skill sizing, findings, repairs. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptContextCheckResult, PromptContextFinding, PromptContextFixResult, PromptEvalRunResult } from '@yimiliya/dsh-prompt-optimizer/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptContextPreview } from './optimization.ts'
import css from './ContextPanel.module.css'

/** Finding kinds the repair flow can propose a fix for. */
type FixableKind = 'stale-skill-reference' | 'duplicate-skill' | 'duplicate-section'

/** Every finding kind the repair button appears for. */
const FIXABLE_KINDS: readonly FixableKind[] = ['stale-skill-reference', 'duplicate-skill', 'duplicate-section']

/** Host verbs the mount injects: the scan, the repair, the evidence pack, and the close. */
export interface ContextPanelInjected {
  /** Run the deterministic scan for the Session; a failing call surfaces the error state. */
  contextCheck: (sessionId: SessionId) => Promise<PromptContextCheckResult>
  /** Propose (or, with `confirm`, apply) one repair for a fixable finding. */
  contextFix: (sessionId: SessionId, kind: FixableKind, subject: string, detail: string, confirm?: boolean) => Promise<PromptContextFixResult>
  /** Run the bundled evidence pack on the Session's route: rewrite plus judge, per sample. */
  runEvalPack: (sessionId: SessionId, count?: number) => Promise<PromptEvalRunResult>
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

/** Evidence-pack run lifecycle inside the checkup panel. */
type EvalPhase = { state: 'idle' } | { state: 'running' } | { state: 'failed'; error: string } | { state: 'done'; result: PromptEvalRunResult }

/** Render one Session's context checkup in the composer seat. */
export function ContextPanel({ sessionId, contextCheck, contextFix, runEvalPack, closeContext, t }: ContextPanelProps) {
  const [phase, setPhase] = useState<ScanPhase>('loading')
  const [report, setReport] = useState<PromptContextCheckResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [fixTarget, setFixTarget] = useState<PromptContextFinding | undefined>(undefined)
  const [fixBusy, setFixBusy] = useState(false)
  const [fixResult, setFixResult] = useState<PromptContextFixResult | undefined>(undefined)
  const [fixError, setFixError] = useState<string | undefined>(undefined)
  const [fixConfirming, setFixConfirming] = useState(false)
  const [fixDone, setFixDone] = useState(false)
  const [copied, setCopied] = useState(false)
  const [evalPhase, setEvalPhase] = useState<EvalPhase>({ state: 'idle' })

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

  const discardFix = (): void => {
    setFixTarget(undefined)
    setFixResult(undefined)
    setFixError(undefined)
    setFixConfirming(false)
    setCopied(false)
  }

  const startFix = (finding: PromptContextFinding): void => {
    discardFix()
    setFixDone(false)
    setFixTarget(finding)
    setFixBusy(true)
    void (async () => {
      try {
        setFixResult(await contextFix(sessionId, finding.kind as FixableKind, finding.subject, finding.detail))
      } catch (failure) {
        setFixError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setFixBusy(false)
      }
    })()
  }

  const confirmFix = (): void => {
    if (fixTarget === undefined || fixConfirming) return
    setFixConfirming(true)
    setFixError(undefined)
    void (async () => {
      try {
        await contextFix(sessionId, fixTarget.kind as FixableKind, fixTarget.subject, fixTarget.detail, true)
        discardFix()
        setFixDone(true)
        load()
      } catch (failure) {
        setFixError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setFixConfirming(false)
      }
    })()
  }

  const copyProposal = (): void => {
    if (fixResult === undefined) return
    void (async () => {
      try {
        await navigator.clipboard.writeText(fixResult.proposal)
        setCopied(true)
      } catch {
        setCopied(false)
      }
    })()
  }

  const startEval = (): void => {
    if (evalPhase.state === 'running') return
    setEvalPhase({ state: 'running' })
    void (async () => {
      try {
        setEvalPhase({ state: 'done', result: await runEvalPack(sessionId) })
      } catch (failure) {
        setEvalPhase({ state: 'failed', error: failure instanceof Error ? failure.message : String(failure) })
      }
    })()
  }

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
                        {FIXABLE_KINDS.includes(finding.kind as FixableKind) && fixTarget?.subject !== finding.subject
                          ? <Button size="sm" type="button" data-testid={`context-fix-trigger:${finding.kind}`} onClick={() => { startFix(finding) }}>{t('contextFix')}</Button>
                          : null}
                      </li>
                    ))}
                  </ul>}
                {fixTarget !== undefined
                  ? <div className={css.fixBlock} data-testid="context-fix">
                    <span className={css.sectionTitle}>{t('contextFixPreviewTitle')}</span>
                    {fixBusy
                      ? <p className={css.hint} data-testid="context-fix-loading">{t('contextFixPending')}</p>
                      : null}
                    {fixError !== undefined
                      ? <p className={css.failedText} data-testid="context-fix-error" role="alert">{t('contextFixFailed', { message: fixError })}</p>
                      : null}
                    {fixResult !== undefined
                      ? <>
                        {fixResult.advisory
                          ? <p className={css.hint}>{t('contextFixAdvisory')}</p>
                          : null}
                        {fixResult.replacement !== undefined
                          ? <p className={css.hint}>{t('contextFixReplacement', { file: fixResult.replacement })}</p>
                          : null}
                        <pre className={css.fixProposal} data-testid="context-fix-proposal">{fixResult.proposal}</pre>
                        <div className={css.fixActions}>
                          {fixResult.advisory
                            ? <Button size="sm" type="button" onClick={() => { copyProposal() }}>{copied ? t('contextFixCopied') : t('contextFixCopy')}</Button>
                            : <Button size="sm" type="button" data-testid="context-fix-confirm" onClick={() => { confirmFix() }}>{fixConfirming ? t('contextFixConfirming') : t('contextFixConfirm')}</Button>}
                          <Button size="sm" type="button" onClick={() => { discardFix() }}>{t('contextFixDiscard')}</Button>
                        </div>
                      </>
                      : null}
                  </div>
                  : null}
                {fixDone
                  ? <p className={css.hint} data-testid="context-fix-done">{t('contextFixDone')}</p>
                  : null}
              </div>
              <div className={css.hint} data-testid="eval-pack">
                <span className={css.sectionTitle}>{t('evalTitle')}</span>
                {evalPhase.state === 'running'
                  ? <span data-testid="eval-running">{t('evalRunning')}</span>
                  : <Button size="sm" type="button" data-testid="eval-trigger" onClick={() => { startEval() }}>
                    {t('evalRun', { count: '3' })}
                  </Button>}
                {evalPhase.state === 'failed'
                  ? <p className={css.failedText} role="alert" data-testid="eval-error">{t('evalFailed', { message: evalPhase.error })}</p>
                  : null}
                {evalPhase.state === 'done'
                  ? <>
                    <span data-testid="eval-summary">{t('evalSummary', {
                      improved: String(evalPhase.result.improved),
                      judged: String(evalPhase.result.judged),
                    })}</span>
                    <ul className={css.list} data-testid="eval-samples">
                      {evalPhase.result.samples.map(sample => (
                        <li key={sample.id}>
                          {sample.rawTotal !== undefined && sample.optimizedTotal !== undefined
                            ? t('evalSample', { id: sample.id, raw: String(sample.rawTotal), opt: String(sample.optimizedTotal) })
                            : t('evalUnjudged', { id: sample.id })}
                        </li>
                      ))}
                    </ul>
                  </>
                  : null}
              </div>
            </>
            : null}
        </div>
      </section>
    </div>
  )
}
