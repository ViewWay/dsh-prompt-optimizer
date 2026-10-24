/** Composer takeover: the persisted prompt library — list, inspect, insert, re-optimize, delete. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconCopyOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptLibraryEntry } from '@yimiliya/dsh-prompt-optimizer/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptLibraryPreview } from './optimization.ts'
import css from './LibraryPanel.module.css'

/** Host verbs the mount injects: library CRUD plus the registered draft insert. */
export interface LibraryPanelInjected {
  /** List the library's entries, newest first; a failing call surfaces the error state. */
  listLibrary: () => Promise<readonly PromptLibraryEntry[]>
  /** Delete one entry by library id; a failing call surfaces the row's error. */
  deleteLibraryEntry: (sessionId: SessionId, id: string) => Promise<void>
  /** Replace the composer draft with the entry's text and close the panel. */
  insertDraft: (sessionId: SessionId, text: string) => void
  /** Replace the draft and immediately start one optimization round over the entry's text. */
  reoptimize: (sessionId: SessionId, text: string) => void
  /** Close the library panel without touching the draft. */
  closeLibrary: (sessionId: SessionId) => void
}

/** Composer-chain owner props plus the injected library verbs. */
export type LibraryPanelProps =
  Pick<PropsRuntime<'conversation.composer'>, 'sessionId'>
  & { matched: PromptLibraryPreview }
  & PropsLocale<'prompt-optimizer'> & InjectFace<LibraryPanelInjected>

/** List lifecycle of one library load. */
type ListPhase = 'loading' | 'ready' | 'failed'

/**
 * Render one library entry's stored date as a stable `YYYY-MM-DD HH:MM` label.
 * @param createdAt - ISO timestamp of the save.
 * @returns the timestamp's head without locale machinery, stable across runs.
 */
function dateLabelOf(createdAt: string): string {
  return createdAt.slice(0, 16).replace('T', ' ')
}

/** Render one Session's prompt library in the composer seat. */
export function LibraryPanel({ sessionId, listLibrary, deleteLibraryEntry, insertDraft, reoptimize, closeLibrary, t }: LibraryPanelProps) {
  const [phase, setPhase] = useState<ListPhase>('loading')
  const [entries, setEntries] = useState<readonly PromptLibraryEntry[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState<string | undefined>(undefined)

  const load = (): void => {
    setPhase('loading')
    setError(undefined)
    void (async () => {
      try {
        setEntries(await listLibrary())
        setPhase('ready')
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
        setPhase('failed')
      }
    })()
  }
  // Reload on open; the panel stays mounted only while its carrier is pending.
  useEffect(load, [listLibrary])

  const remove = (id: string): void => {
    if (deleting !== undefined) return
    setDeleting(id)
    setDeleteError(undefined)
    void (async () => {
      try {
        await deleteLibraryEntry(sessionId, id)
        setEntries(draft => draft.filter(entry => entry.id !== id))
        setArmed(undefined)
        if (expanded === id) setExpanded(undefined)
      } catch (failure) {
        setDeleteError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setDeleting(undefined)
      }
    })()
  }

  const copy = (id: string, text: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(id)
      } catch {
        setCopied(undefined)
      }
    })()
  }

  return (
    <div className={css.frame}>
      <section className={css.card} aria-label={t('libraryTitle')}>
        <header className={css.header}>
          <span className={css.title}>{t('libraryTitle')}</span>
          <Button size="sm" type="button" aria-label={t('cancel')} onClick={() => { closeLibrary(sessionId) }}>
            <IconCloseOutlineRegular size={14} />
          </Button>
        </header>
        <div className={css.body}>
          {phase === 'loading'
            ? <p className={css.hint} data-testid="library-loading">{t('libraryLoading')}</p>
            : null}
          {phase === 'failed'
            ? <div className={css.hint} data-testid="library-error" role="alert">
              <p className={css.failedText}>{t('libraryLoadFailed', { message: error ?? '' })}</p>
              <Button size="sm" type="button" onClick={() => { load() }}>{t('libraryRetry')}</Button>
            </div>
            : null}
          {phase === 'ready' && entries.length === 0
            ? <p className={css.hint} data-testid="library-empty">{t('libraryEmpty')}</p>
            : null}
          {phase === 'ready' && entries.length > 0
            ? <ul className={css.list} data-testid="library-list">
              {entries.map(entry => (
                <li key={entry.id} className={css.entry}>
                  <button
                    type="button" className={css.entryHead} data-testid="library-entry-toggle"
                    aria-expanded={expanded === entry.id}
                    onClick={() => { setExpanded(expanded === entry.id ? undefined : entry.id); setArmed(undefined) }}
                  >
                    <span className={css.entryTitle}>{entry.title}</span>
                    <span className={css.entryMeta}>{dateLabelOf(entry.createdAt)} · {t('librarySize', { count: entry.text.length })}</span>
                  </button>
                  {expanded === entry.id
                    ? <div className={css.entryBody} data-testid="library-entry-body">
                      <pre className={css.text}>{entry.text}</pre>
                      <div className={css.actions}>
                        <Button size="sm" type="button" onClick={() => { insertDraft(sessionId, entry.text) }}>
                          {t('libraryInsert')}
                        </Button>
                        <Button size="sm" type="button" onClick={() => { reoptimize(sessionId, entry.text) }}>
                          {t('libraryReoptimize')}
                        </Button>
                        <Button size="sm" type="button" aria-label={t('libraryCopy')} onClick={() => { copy(entry.id, entry.text) }}>
                          {copied === entry.id ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
                        </Button>
                        <Button
                          size="sm" type="button" disabled={deleting !== undefined}
                          aria-label={t('libraryDelete')}
                          data-testid="library-delete"
                          onClick={() => { if (armed === entry.id) remove(entry.id); else setArmed(entry.id) }}
                        >
                          {armed === entry.id ? t('libraryConfirmDelete') : <IconTrashOutlineRegular size={14} />}
                        </Button>
                      </div>
                    </div>
                    : null}
                </li>
              ))}
            </ul>
            : null}
          {deleteError !== undefined
            ? <p className={css.failedText} role="alert" data-testid="library-delete-error">
              {t('libraryDeleteFailed', { message: deleteError })}
            </p>
            : null}
        </div>
      </section>
    </div>
  )
}
