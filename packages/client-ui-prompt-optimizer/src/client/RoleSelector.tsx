/** Header role picker: native select for short lists, filterable input+list beyond the threshold. */
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { PromptRoleSummary } from '@yimiliya/dsh-prompt-optimizer/types'
import css from './RoleSelector.module.css'

/** Role lists longer than this swap the native select for the searchable picker; the no-role entry is extra. */
const FILTER_THRESHOLD = 60

/** One pickable entry; the empty id is the no-role choice. */
interface RoleOption {
  readonly id: string
  readonly name: string
}

/** Props of the preview-header role picker. */
export interface RoleSelectorProps {
  readonly roles: readonly PromptRoleSummary[]
  readonly selected: string | undefined
  readonly disabled: boolean
  readonly label: string
  readonly noneLabel: string
  readonly noMatchesLabel: string
  readonly onPick: (role: string | undefined) => void
}

/**
 * Render the role picker for the preview header: a native `<select>` up to
 * FILTER_THRESHOLD roles, an input+list combobox beyond it. Both forms share
 * the same onPick contract (undefined for the no-role entry).
 */
export function RoleSelector(props: RoleSelectorProps) {
  const { roles } = props
  if (roles.length > FILTER_THRESHOLD) return <RoleCombo {...props} />
  const { selected, disabled, label, noneLabel, onPick } = props
  return (
    <select
      className={css.roleSelect}
      data-testid="optimization-role"
      aria-label={label}
      value={selected ?? ''}
      disabled={disabled}
      onChange={(event) => { onPick(event.target.value === '' ? undefined : event.target.value) }}
    >
      <option value="">{noneLabel}</option>
      {roles.map(summary => <option key={summary.id} value={summary.id}>{summary.name}</option>)}
    </select>
  )
}

/** Filterable combobox shown when the role listing overloads the native select. */
function RoleCombo({ roles, selected, disabled, label, noneLabel, noMatchesLabel, onPick }: RoleSelectorProps) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const activeRef = useRef<HTMLLIElement | null>(null)

  const allOptions: readonly RoleOption[] = [{ id: '', name: noneLabel }, ...roles]
  const needle = query.trim().toLowerCase()
  const options = needle === ''
    ? allOptions
    : allOptions.filter(option =>
      option.name.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle))

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
  }, [disabled])

  useEffect(() => {
    // aria-activedescendant movement alone does not scroll the list.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const pick = (option: RoleOption): void => {
    setQuery('')
    setActiveIndex(-1)
    setOpen(false)
    onPick(option.id === '' ? undefined : option.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Confirming an IME composition sends keydown too; none of it is picker input.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      if (options.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(current => current < 0
        ? (delta > 0 ? 0 : options.length - 1)
        : (current + delta + options.length) % options.length)
      return
    }
    if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && activeIndex < options.length) {
        event.preventDefault()
        pick(options[activeIndex]!)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (query !== '') { setQuery(''); setActiveIndex(-1) } else { setOpen(false) }
    }
  }

  const activeId = open && activeIndex >= 0 && activeIndex < options.length ? `${listId}-${activeIndex}` : undefined
  const selectedName = selected === undefined ? noneLabel : roles.find(role => role.id === selected)?.name ?? selected

  return (
    <div className={css.roleCombo} data-testid="optimization-role">
      <input
        className={css.roleFilter}
        type="text"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        placeholder={selectedName}
        value={query}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => { setOpen(true) }}
        onBlur={() => { setOpen(false); setQuery(''); setActiveIndex(-1) }}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          setActiveIndex(event.target.value.trim() === '' ? -1 : 0)
        }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled
        ? <ul className={css.roleList} id={listId} role="listbox">
          {options.length === 0
            ? <li className={css.roleOption} role="option" aria-disabled="true" aria-selected="false">{noMatchesLabel}</li>
            : options.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${index}`}
                ref={index === activeIndex ? activeRef : undefined}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? css.roleOptionActive : css.roleOption}
                // mousedown keeps focus in the input, so blur cannot close over the click.
                onMouseDown={(event) => { event.preventDefault(); pick(option) }}
              >
                {option.name}
              </li>
            ))}
        </ul>
        : null}
    </div>
  )
}
