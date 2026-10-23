/** Composer takeover: original/optimized comparison with apply, retry, cancel, runnable checks, library save. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptRoleSummary, PromptVerifyResult } from '@yimiliya/dsh-prompt-optimizer/types'
import type { PromptOptimizationPreview, OptimizationSnapshot } from './optimization.ts'
import { usePromptRoles } from './use-prompt-roles.ts'
import { RoleSelector } from './RoleSelector.tsx'
import css from './PreviewPanel.module.css'

/** Host verbs injected by the mount; each takes the Session whose preview is open. */
export interface PreviewPanelActions {
  /** Replace the draft with the accepted result and close the preview. */
  apply: (sessionId: PromptOptimizationPreview['sessionId']) => void
  /** Discard the current result and run another round over the same draft. */
  regenerate: (sessionId: PromptOptimizationPreview['sessionId']) => void
  /** Re-run the same draft through the system-prompt critique loop. */
  regenerateAsSystem: (sessionId: PromptOptimizationPreview['sessionId']) => void
  /** Re-run the same draft styled as one role; undefined returns to a generic rewrite.
   * @param sessionId - Session whose preview is open.
   * @param role - role slug to style the round with, or undefined for no role.
   */
  regenerateAsRole: (sessionId: PromptOptimizationPreview['sessionId'], role: string | undefined) => void
  /** Abort any in-flight round and close the preview. */
  cancel: (sessionId: PromptOptimizationPreview['sessionId']) => void
  /** List the host's selectable role definitions; a failing or empty listing keeps the read-only role badge. */
  loadRoles: () => Promise<readonly PromptRoleSummary[]>
  /** Execute one substituted check command in the Session workspace. */
  verifyCheck: (sessionId: PromptOptimizationPreview['sessionId'], criterion: string, command: string) => Promise<PromptVerifyResult>
  /** Save the accepted result into the durable prompt library. */
  saveToLibrary: (sessionId: PromptOptimizationPreview['sessionId'], title: string, text: string) => Promise<void>
}

/** Inject face shared by the mount: preview verbs plus the state hook source. */
export interface PreviewPanelInjected extends PreviewPanelActions {
  hooks: { optimization: { getSnapshot(): OptimizationSnapshot; subscribe(listener: () => void): () => void } }
}

/** Composer-chain owner props plus the injected preview verbs. */
export type PreviewPanelProps =
  Pick<PropsRuntime<'conversation.composer'>, 'sessionId'>
  & { matched: PromptOptimizationPreview }
  & PropsLocale<'prompt-optimizer'> & InjectFace<PreviewPanelInjected>

/** `<placeholder>` tokens a check command template may carry. */
const PLACEHOLDER_PATTERN = /<([A-Za-z_][A-Za-z0-9_.-]*)>/g

/** Longest auto-derived library title. */
const TITLE_MAX_CHARS = 30

/**
 * Unique placeholder names a command template declares.
 * @param command - check command template from an acceptance criterion.
 * @returns distinct `<name>` tokens in first-appearance order.
 */
function placeholdersOf(command: string): readonly string[] {
  return [...new Set([...command.matchAll(PLACEHOLDER_PATTERN)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined))]
}

/**
 * Substitute filled values into a command template; unfilled tokens stay verbatim.
 * @param command - check command template.
 * @param values - filled placeholder values by name.
 * @returns the command with every filled token replaced.
 */
function fillPlaceholders(command: string, values: Readonly<Record<string, string>>): string {
  return command.replace(PLACEHOLDER_PATTERN, (token, name: string) => {
    const value = values[name]
    return value !== undefined && value.trim() !== '' ? value : token
  })
}

/** First non-empty line of a text, clipped for use as a library title. */
function titleOf(text: string): string {
  const line = text.split('\n').map(entry => entry.trim()).find(entry => entry !== '') ?? ''
  return line.slice(0, TITLE_MAX_CHARS)
}

/** Live state of one criterion's runnable check. */
interface CheckState {
  readonly values: Readonly<Record<string, string>>
  readonly running: boolean
  readonly result: PromptVerifyResult | undefined
  readonly error: string | undefined
}

const CHECK_IDLE: CheckState = { values: {}, running: false, result: undefined, error: undefined }

/** Library-button view state. */
interface LibraryState {
  readonly saving: boolean
  readonly saved: boolean
  readonly error: string | undefined
}

const LIBRARY_IDLE: LibraryState = { saving: false, saved: false, error: undefined }

/** Render one Session's optimization preview in the composer seat. */
export function PreviewPanel(props: PreviewPanelProps) {
  const { matched, apply, regenerate, regenerateAsSystem, regenerateAsRole, cancel, loadRoles } = props
  const { verifyCheck, saveToLibrary, useOptimization, t } = props
  const state = useOptimization(snapshot => snapshot[matched.sessionId])
  const roles = usePromptRoles(loadRoles)
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [library, setLibrary] = useState<LibraryState>(LIBRARY_IDLE)
  const [critiqueCopyFailed, setCritiqueCopyFailed] = useState(false)
  if (state === undefined) return null
  const ready = state.phase === 'ready' && state.result !== undefined

  const runCheck = (criterion: string, template: string): void => {
    const current = checks[criterion] ?? CHECK_IDLE
    setChecks(draft => ({ ...draft, [criterion]: { ...current, running: true, error: undefined } }))
    void (async () => {
      try {
        const result = await verifyCheck(matched.sessionId, criterion, fillPlaceholders(template, current.values))
        setChecks(draft => ({ ...draft, [criterion]: { values: current.values, running: false, result, error: undefined } }))
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setChecks(draft => ({ ...draft, [criterion]: { values: current.values, running: false, result: undefined, error: message } }))
      }
    })()
  }

  const save = (): void => {
    const result = state.result
    if (result === undefined || library.saving || library.saved) return
    setLibrary({ saving: true, saved: false, error: undefined })
    void (async () => {
      try {
        await saveToLibrary(matched.sessionId, titleOf(result.optimizedText), result.optimizedText)
        setLibrary({ saving: false, saved: true, error: undefined })
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setLibrary({ saving: false, saved: false, error: message })
      }
    })()  }

  const copyCritique = (): void => {
    const critique = state.result?.critique ?? []
    setCritiqueCopyFailed(false)
    void (async () => {
      try {
        // Raw entry text only; the localized prefix is display chrome, not checklist content.
        await navigator.clipboard.writeText(critique.map(item => `- ${item}`).join('\n'))
      } catch {
        setCritiqueCopyFailed(true)
      }
    })()
  }

  return (
    <div className={css.frame}>
      <section className={css.card} aria-label={t('previewTitle')}>
        <header className={css.header}>
          {state.phase === 'running' ? <StateDot state="ongoing" /> : null}
          <span className={css.title}>{t('previewTitle')}</span>
          {state.queueItemId !== undefined
            ? <span className={css.roleBadge} data-testid="optimization-queue">{t('queueBadge')}</span>
            : null}
          {roles.length > 0
            ? <RoleSelector
              roles={roles}
              selected={state.role}
              disabled={state.phase === 'running'}
              label={t('roleLabel')}
              noneLabel={t('roleNone')}
              noMatchesLabel={t('roleNoMatches')}
              onPick={(role) => { regenerateAsRole(matched.sessionId, role) }}
            />
            : state.role !== undefined
              ? <span className={css.roleBadge} data-testid="optimization-role">{t('roleUsed', { role: state.role })}</span>
              : null}
        </header>
        <div className={css.body}>
          <div className={css.column}>
            <h4 className={css.columnTitle}>{t('original')}</h4>
            <pre className={css.text} data-testid="optimization-original">{state.draft}</pre>
          </div>
          <div className={css.column}>
            <h4 className={css.columnTitle}>{t('optimized')}</h4>
            {ready
              ? <pre className={css.text} data-testid="optimization-result">{state.result.optimizedText}</pre>
              : <div className={css.text} data-testid="optimization-pending">
                {state.phase === 'running' ? t('optimizing') : t('failed', { message: state.error ?? '' })}
              </div>}
          </div>
        </div>
        {ready && state.result.changes.length > 0
          ? <ul className={css.changes} data-testid="optimization-changes">
            {state.result.changes.map(change => <li key={change}>{change}</li>)}
          </ul>
          : null}
        {ready && state.result.critique !== undefined && state.result.critique.length > 0
          ? <div className={css.critique}>
            <ul className={css.changes} data-testid="optimization-critique">
              {state.result.critique.map(item => <li key={item}>{t('critiqueItem', { text: item })}</li>)}
            </ul>
            <div className={css.critiqueActions}>
              <Button size="sm" type="button" onClick={() => { copyCritique() }}>
                {t('copyCritique')}
              </Button>
              {critiqueCopyFailed
                ? <span className={css.failed} data-testid="critique-copy-error" role="alert">{t('copyCritiqueFailed')}</span>
                : null}
            </div>
          </div>
          : null}
        {ready && state.result.acceptance.length > 0
          ? <ul className={css.changes} data-testid="optimization-acceptance">
            {state.result.acceptance.map((criterion) => {
              const mechanical = criterion.kind === 'mechanical' && criterion.commandTemplate !== undefined
              const check = mechanical ? checks[criterion.text] ?? CHECK_IDLE : undefined
              const template = criterion.commandTemplate ?? ''
              const names = check === undefined ? [] : placeholdersOf(template)
              const unfilled = names.some(name => (check?.values[name] ?? '').trim() === '')
              return (
                <li key={criterion.text} className={css.criterion}>
                  <span>
                    {mechanical
                      ? t('acceptanceMechanical', { text: criterion.text, command: criterion.commandTemplate })
                      : t('acceptanceLlm', { text: criterion.text })}
                  </span>
                  {check !== undefined
                    ? <div className={css.checkRow} data-testid="criterion-check">
                      {names.map(name => (
                        <input
                          key={name} className={css.checkInput} aria-label={name} placeholder={name}
                          value={check.values[name] ?? ''}
                          onChange={(event) => {
                            setChecks(draft => ({
                              ...draft,
                              [criterion.text]: {
                                values: { ...draft[criterion.text]?.values, [name]: event.target.value },
                                running: false,
                                result: undefined,
                                error: undefined,
                              },
                            }))
                          }}
                        />
                      ))}
                      <Button
                        size="sm" type="button" disabled={check.running || unfilled}
                        onClick={() => { runCheck(criterion.text, template) }}
                      >
                        {check.running ? t('verifying') : t('runCheck')}
                      </Button>
                      {check.result !== undefined
                        ? <span
                          className={check.result.passed ? css.passed : css.failed}
                          data-testid="criterion-check-result"
                        >
                          {check.result.passed ? t('checkPassed') : t('checkFailed')}
                        </span>
                        : null}
                      {check.error !== undefined ? <span className={css.failed}>{check.error}</span> : null}
                      {check.result !== undefined
                        ? <pre className={css.checkOutput} data-testid="criterion-check-output">{check.result.output}</pre>
                        : null}
                    </div>
                    : null}
                </li>
              )
            })}
          </ul>
          : null}
        {ready && state.result.changes.length === 0
          ? <p className={css.noChanges}>{t('emptyChanges')}</p>
          : null}
        {state.phase === 'failed'
          ? <p className={css.error} data-testid="optimization-error" role="alert">
            {t('failed', { message: state.error ?? '' })}
          </p>
          : null}
        {library.error !== undefined
          ? <p className={css.error} data-testid="library-error" role="alert">
            {t('saveLibraryError', { message: library.error })}
          </p>
          : null}
        <footer className={css.footer}>
          <Button size="sm" type="button" onClick={() => { cancel(matched.sessionId) }} aria-label={t('cancel')}>
            <IconCloseOutlineRegular size={14} />
          </Button>
          {state.phase === 'failed'
            ? <Button size="sm" type="button" onClick={() => { regenerate(matched.sessionId) }}>
              <IconRefreshOutlineRegular size={14} />
              {t('regenerate')}
            </Button>
            : null}
          {ready
            ? <Button size="sm" type="button" onClick={() => { regenerateAsSystem(matched.sessionId) }}>
              {t('optimizeAsSystem')}
            </Button>
            : null}
          {ready
            ? <Button
              size="sm" type="button"
              disabled={library.saving || library.saved}
              onClick={() => { save() }}
              data-testid="save-library"
            >
              {library.saved ? t('savedLibrary') : t('saveLibrary')}
            </Button>
            : null}
          <Button
            size="sm" type="button" variant="primary" className={css.primary}
            disabled={!ready || (state.apply === undefined && state.queueItemId === undefined)}
            onClick={() => { apply(matched.sessionId) }}
          >
            <IconCheckOutlineRegular size={14} />
            {t(state.queueItemId === undefined ? 'apply' : 'queueApply')}
          </Button>
        </footer>
      </section>
    </div>
  )
}
