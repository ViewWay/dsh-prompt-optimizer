// @vitest-environment jsdom
/** Trigger and panel behavior with directly-fed props and stub framework hooks. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { PromptOptimizerSettings as PromptOptimizerSettingsSection } from 'dsh-prompt-optimizer/types'
import { PromptOptimizerSettingsForm } from '../src/client/settings-form.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { OptimizeButton, type OptimizeButtonProps } from '../src/client/OptimizeButton.tsx'
import { QueueItemOptimizeEntry, type QueueItemOptimizeEntryProps } from '../src/client/QueueItemOptimizeEntry.tsx'
import { PreviewPanel, type PreviewPanelProps } from '../src/client/PreviewPanel.tsx'
import { PromptOptimizerSettings, type PromptOptimizerSettingsProps } from '../src/client/PromptOptimizerSettings.tsx'
import { createOptimizationStore, PromptOptimizationPreview, type OptimizationSnapshot, type OptimizationState } from '../src/client/optimization.ts'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { PromptOptimizeResult } from 'dsh-prompt-optimizer/types'

const SESSION = 'session-1' as SessionId
const t: OptimizeButtonProps['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? (commonZh as Record<string, string>)[key] ?? key
  let text = template
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}
afterEach(cleanup)

function inputActions(setDraft = vi.fn()): InputActions {
  return {
    captureInsertion: () => { throw new Error('unused') },
    insertText: () => false,
    setDraft,
    persistDraft: () => {},
    addAttachments: () => false,
    removeAttachment: () => {},
    pruneAttachments: () => {},
    submit: () => {},
  }
}

type StartMock = ReturnType<typeof vi.fn<(sessionId: SessionId, text: string, apply: (text: string) => void, role?: string) => void>>

function buttonProps(overrides: Partial<OptimizeButtonProps> & { draft?: string; state?: OptimizationState | undefined } = {}): {
  props: OptimizeButtonProps
  start: StartMock
  setDraft: ReturnType<typeof vi.fn>
} {
  const store = createOptimizationStore()
  if (overrides.state !== undefined) {
    store.update((draft) => { draft[SESSION] = overrides.state! })
  }
  const start = vi.fn<(sessionId: SessionId, text: string, apply: (text: string) => void, role?: string) => void>(), setDraft = vi.fn()
  const inputState: InputState = {
    draft: overrides.draft ?? '',
    attachmentIds: [],
    draftRev: 0,
    phase: 'plain',
    occurrences: [],
    queue: [],
  }
  const props: OptimizeButtonProps = {
    sessionId: SESSION,
    useInput: selector => selector(inputState),
    inputActions: inputActions(setDraft),
    start,
    startQueued: vi.fn(),
    loadRoles: vi.fn(async () => []),
    recommendRoles: vi.fn(async () => []),
    useOptimization: <T,>(selector: (snapshot: OptimizationSnapshot) => T): T => selector(store.getSnapshot()),
    t,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['draft', 'state'].includes(key))),
  }
  return { props, start, setDraft }
}

describe('OptimizeButton', () => {
  it('disables without draft text and starts a round once draft exists', () => {
    const { props } = buttonProps({ draft: '   ' })
    const { rerender } = render(<OptimizeButton {...props} />)
    const button = screen.getByRole('button', { name: zh.optimize })
    expect(button.hasAttribute('disabled')).toBe(true)

    const ready = buttonProps({ draft: '帮我写脚本', start: props.start })
    rerender(<OptimizeButton {...ready.props} />)
    const enabled = screen.getByRole('button', { name: zh.optimize })
    expect(enabled.hasAttribute('disabled')).toBe(false)
    enabled.click()
    expect(props.start).toHaveBeenCalledExactlyOnceWith(SESSION, '帮我写脚本', expect.any(Function), undefined)
  })

  it('starts a styled round straight from a recommendation chip', async () => {
    const { props } = buttonProps({
      draft: '帮我看看这段代码',
      loadRoles: vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员' }]),
      recommendRoles: vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员', score: 9, matched: ['代码'] }]),
    })
    render(<OptimizeButton {...props} />)
    const chip = await waitFor(() => screen.getByRole('button', { name: '推荐角色：代码评审员' }))
    fireEvent.click(chip)
    expect(props.start).toHaveBeenCalledExactlyOnceWith(SESSION, '帮我看看这段代码', expect.any(Function), 'imp-code-reviewer')
  })

  it('styles the first queued item straight from a recommendation chip when the draft is empty', async () => {
    const queueItem = { id: 'msg-9' as never, role: 'user', content: [{ type: 'text', text: '排队中的请求' }] }
    const startQueued = vi.fn()
    const { props } = buttonProps({
      draft: '',
      startQueued,
      loadRoles: vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员' }]),
      recommendRoles: vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员', score: 9, matched: ['请求'] }]),
    })
    const queuedProps: OptimizeButtonProps = { ...props, useInput: selector => selector({
      draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [queueItem],
    } as never) }
    render(<OptimizeButton {...queuedProps} />)
    const chip = await waitFor(() => screen.getByRole('button', { name: '推荐角色：代码评审员' }))
    fireEvent.click(chip)
    expect(startQueued).toHaveBeenCalledExactlyOnceWith(SESSION, 'msg-9', '排队中的请求', 'imp-code-reviewer')
  })

  it('optimizes the first queued item when the draft is empty', () => {
    const queueItem = { id: 'msg-9' as never, role: 'user', content: [{ type: 'text', text: '排队中的请求' }] }
    const startQueued = vi.fn()
    const { props } = buttonProps({ draft: '', startQueued })
    const queuedProps: OptimizeButtonProps = { ...props, useInput: selector => selector({
      draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [queueItem],
    } as never) }
    render(<OptimizeButton {...queuedProps} />)
    const button = screen.getByRole('button', { name: zh.optimize })
    expect(button.hasAttribute('disabled')).toBe(false)
    button.click()
    expect(startQueued).toHaveBeenCalledExactlyOnceWith(SESSION, 'msg-9', '排队中的请求', undefined)
  })

  it('renders a recommendation chip row from context ranking', async () => {
    const { props } = buttonProps({
      draft: '审阅这段 C++ 高性能代码',
      loadRoles: vi.fn(async () => [{ id: 'sys-cpp-systems-engineer', name: 'C++ 高性能系统工程师' }]),
      recommendRoles: vi.fn(async () => [{ id: 'sys-cpp-systems-engineer', name: 'C++ 高性能系统工程师', score: 7, matched: ['c++'] }]),
    })
    render(<OptimizeButton {...props} />)
    const chip = await waitFor(() => screen.getByRole('button', { name: '推荐角色：C++ 高性能系统工程师' }))
    expect(chip.textContent).toContain('C++ 高性能系统工程师')
  })

  it('hides the recommendation chips when the roles listing is empty', () => {
    const { props } = buttonProps({
      draft: '草稿',
      loadRoles: vi.fn(async () => { throw new Error('rolesDir unset') }),
      recommendRoles: vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员', score: 9, matched: [] }]),
    })
    render(<OptimizeButton {...props} />)
    return waitFor(() => { expect(screen.queryByRole('button', { name: /推荐角色/ })).toBeNull() })
  })

  it('disables while a round for the session is running', () => {
    const { props } = buttonProps({ draft: 'draft', state: { phase: 'running', draft: 'draft', previousAttempts: [], role: undefined, result: undefined, error: undefined, apply: () => {} } })
    render(<OptimizeButton {...props} />)
    expect(screen.getByRole('button', { name: zh.optimize }).hasAttribute('disabled')).toBe(true)
  })

  it('registers a draft replacement that forwards to inputActions.setDraft', () => {
    const { props, start, setDraft } = buttonProps({ draft: 'draft' })
    render(<OptimizeButton {...props} />)
    screen.getByRole('button', { name: zh.optimize }).click()
    for (const call of start.mock.calls) call[2]('替换文本')
    expect(setDraft).toHaveBeenCalledWith('替换文本')
  })
})

describe('QueueItemOptimizeEntry', () => {
  function entryProps(overrides: Partial<QueueItemOptimizeEntryProps> & {
    state?: OptimizationState | undefined
    item?: QueueItemOptimizeEntryProps['item']
  } = {}): { props: QueueItemOptimizeEntryProps; startQueued: ReturnType<typeof vi.fn> } {
    const store = createOptimizationStore()
    if (overrides.state !== undefined) store.update((draft) => { draft[SESSION] = overrides.state! })
    const startQueued = vi.fn()
    const item = overrides.item ?? { id: 'msg-9' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '排队中的请求' }] }
    const props: QueueItemOptimizeEntryProps = {
      sessionId: SESSION,
      item,
      startQueued,
      useOptimization: <T,>(selector: (snapshot: OptimizationSnapshot) => T): T => selector(store.getSnapshot()),
      t,
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['state', 'item'].includes(key))),
    }
    return { props, startQueued }
  }

  it('starts a queued round for the text-only item on click', () => {
    const { props, startQueued } = entryProps()
    render(<QueueItemOptimizeEntry {...props} />)
    screen.getByRole('button', { name: zh.queueOptimize }).click()
    expect(startQueued).toHaveBeenCalledExactlyOnceWith(SESSION, 'msg-9', '排队中的请求')
  })

  it('renders nothing for an item that is not entirely text blocks', () => {
    const { container } = render(<QueueItemOptimizeEntry {...entryProps({
      item: { id: 'msg-8' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', data: 'x' } as never] },
    }).props} />)
    expect(container.childElementCount).toBe(0)
  })

  it('disables while a round for the session is running', () => {
    const { props } = entryProps({ state: { phase: 'running', draft: 'd', previousAttempts: [], role: undefined, result: undefined, error: undefined, apply: () => {} } })
    render(<QueueItemOptimizeEntry {...props} />)
    expect(screen.getByRole('button', { name: zh.queueOptimize }).hasAttribute('disabled')).toBe(true)
  })
})

const RESULT: PromptOptimizeResult = {
  optimizedText: '优化后的提示词',
  changes: ['补充了输出格式'],
  acceptance: [
    { text: '脚本存在且可运行', kind: 'mechanical', commandTemplate: 'ls script.sh' },
    { text: '与用户确认了日志格式', kind: 'llm' },
  ],
  provider: 'current-route',
  model: 'current-model',
}

function panelProps(state: OptimizationState | undefined, actions: Partial<PreviewPanelProps> = {}): PreviewPanelProps {
  const store = createOptimizationStore()
  if (state !== undefined) store.update((draft) => { draft[SESSION] = state })
  return {
    sessionId: SESSION,
    matched: new PromptOptimizationPreview(SESSION),
    apply: vi.fn(),
    regenerate: vi.fn(),
    regenerateAsSystem: vi.fn(),
    regenerateAsRole: vi.fn(),
    cancel: vi.fn(),
    loadRoles: vi.fn(async () => []),
    verifyCheck: vi.fn(async () => ({ passed: true, exitCode: 0, timedOut: false, output: '', durationMs: 0 })),
    saveToLibrary: vi.fn(async () => {}),
    useOptimization: <T,>(selector: (snapshot: OptimizationSnapshot) => T): T => selector(store.getSnapshot()),
    t,
    ...actions,
  }
}

const READY: OptimizationState = { phase: 'ready', draft: '原始草稿', previousAttempts: [], role: undefined, result: RESULT, error: undefined, apply: () => {} }

describe('PromptOptimizerSettings', () => {
  const ROLES = [{ id: 'imp-code-reviewer', name: '代码评审员' }, { id: 'qa-engineer', name: '测试工程师' }]

  function settingsProps(section: { defaultRole?: string } = {}, roles: readonly { id: string; name: string }[] = ROLES): {
    props: PromptOptimizerSettingsProps
    scope: ReturnType<typeof stubConfigForm<PromptOptimizerSettingsSection>>
    form: PromptOptimizerSettingsForm
  } {
    const scope = stubConfigForm<PromptOptimizerSettingsSection>()
    scope.publish({ status: 'ready', value: section, base: {}, user: {}, writable: true, revision: 7 })
    const form = new PromptOptimizerSettingsForm(scope.scope)
    const { hooks, ...actions } = form.inject()
    const props = {
      view: 'page' as const, ...actions,
      loadRoles: vi.fn(async () => roles),
      useSettingsForm: bindSnapshotSelector(hooks.settingsForm),
      t,
    } as PromptOptimizerSettingsProps
    return { props, scope, form }
  }

  it('offers the listed roles and stages a picked default until the save', async () => {
    const { props, scope } = settingsProps()
    render(<PromptOptimizerSettings {...props} />)
    const select = await waitFor(() => screen.getByLabelText(zh.settingsDefaultRole))
    expect(select.textContent).toContain(zh.roleNone)
    expect(select.textContent).toContain('代码评审员')
    fireEvent.change(select, { target: { value: 'imp-code-reviewer' } })
    screen.getByRole('button', { name: zh.settingsSave }).click()
    await waitFor(() => { expect(scope.mutate).toHaveBeenCalledExactlyOnceWith(
      [{ op: 'set', path: ['defaultRole'], value: 'imp-code-reviewer' }], 7,
    ) })
  })

  it('marks a stored slug that no longer resolves as unavailable', async () => {
    const { props } = settingsProps({ defaultRole: 'imp-gone' }, [{ id: 'qa-engineer', name: '测试工程师' }])
    render(<PromptOptimizerSettings {...props} />)
    const select = await waitFor(() => screen.getByLabelText(zh.settingsDefaultRole))
    expect(select.textContent).toContain(zh.settingsRoleUnavailableOption.replace('{role}', 'imp-gone'))
    expect(select).toHaveProperty('value', 'imp-gone')
  })

  it('reports the roles listing failure without blocking the form', async () => {
    const { props } = settingsProps()
    ;(props.loadRoles as unknown as ReturnType<typeof vi.fn>) = vi.fn(async () => { throw new Error('rolesDir unset') })
    render(<PromptOptimizerSettings {...props} />)
    await waitFor(() => { expect(screen.getByText(zh.settingsRolesUnavailable)).toBeTruthy() })
    expect(screen.getByRole('button', { name: zh.settingsSave })).toBeTruthy()
  })
})

describe('PreviewPanel', () => {
  it('renders nothing without session state', () => {
    const { container } = render(<PreviewPanel {...panelProps(undefined)} />)
    expect(container.childElementCount).toBe(0)
  })

  it('shows both texts, the change notes, and applies the accepted result', () => {
    const apply = vi.fn()
    render(<PreviewPanel {...panelProps(READY, { apply })} />)
    expect(screen.getByTestId('optimization-original').textContent).toBe('原始草稿')
    expect(screen.getByTestId('optimization-result').textContent).toBe('优化后的提示词')
    expect(screen.getByTestId('optimization-changes').textContent).toContain('补充了输出格式')
    screen.getByRole('button', { name: new RegExp(zh.apply) }).click()
    expect(apply).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('annotates mechanical acceptance criteria with their check command', () => {
    render(<PreviewPanel {...panelProps(READY)} />)
    const acceptance = screen.getByTestId('optimization-acceptance')
    expect(acceptance.textContent).toContain('脚本存在且可运行（命令核验：ls script.sh）')
    expect(acceptance.textContent).toContain('与用户确认了日志格式（人工核验）')
  })

  it('omits the acceptance list for a criterion-free result', () => {
    render(<PreviewPanel {...panelProps({ ...READY, result: { ...RESULT, acceptance: [] } })} />)
    expect(screen.queryByTestId('optimization-acceptance')).toBeNull()
  })

  it('carries the running state without an apply button enabled', () => {
    const running: OptimizationState = { phase: 'running', draft: 'd', previousAttempts: [], role: undefined, result: undefined, error: undefined, apply: () => {} }
    render(<PreviewPanel {...panelProps(running)} />)
    expect(screen.getByTestId('optimization-pending').textContent).toBe(zh.optimizing)
    expect(screen.getByRole('button', { name: new RegExp(zh.apply) }).hasAttribute('disabled')).toBe(true)
  })

  it('reports failure and offers regenerate', () => {
    const regenerate = vi.fn()
    const failed: OptimizationState = { phase: 'failed', draft: 'd', previousAttempts: [], role: undefined, result: undefined, error: '断网', apply: () => {} }
    render(<PreviewPanel {...panelProps(failed, { regenerate })} />)
    expect(screen.getByTestId('optimization-error').textContent).toContain('断网')
    screen.getByRole('button', { name: new RegExp(zh.regenerate) }).click()
    expect(regenerate).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('falls back to the role badge for a role-styled round when no roles are listed', () => {
    render(<PreviewPanel {...panelProps({ ...READY, role: 'imp-code-reviewer' })} />)
    expect(screen.getByTestId('optimization-role').textContent).toBe('角色风格：imp-code-reviewer')
  })

  it('offers the header role picker and re-runs the round on change', async () => {
    const regenerateAsRole = vi.fn()
    const loadRoles = vi.fn(async () => [
      { id: 'imp-code-reviewer', name: '代码评审员' },
      { id: 'qa-engineer', name: '测试工程师' },
    ])
    render(<PreviewPanel {...panelProps(READY, { regenerateAsRole, loadRoles })} />)
    const select = await waitFor(() => screen.getByLabelText(zh.roleLabel))
    expect(select.textContent).toContain(zh.roleNone)
    expect(select.textContent).toContain('代码评审员')
    expect(select.textContent).toContain('测试工程师')
    fireEvent.change(select, { target: { value: 'qa-engineer' } })
    expect(regenerateAsRole).toHaveBeenCalledExactlyOnceWith(SESSION, 'qa-engineer')
    fireEvent.change(select, { target: { value: '' } })
    expect(regenerateAsRole).toHaveBeenLastCalledWith(SESSION, undefined)
  })

  it('marks the resolved role selected in the picker', async () => {
    const loadRoles = vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员' }])
    render(<PreviewPanel {...panelProps({ ...READY, role: 'imp-code-reviewer' }, { loadRoles })} />)
    const select = await waitFor(() => screen.getByLabelText(zh.roleLabel))
    expect(select).toHaveProperty('value', 'imp-code-reviewer')
  })

  it('disables the picker while a round is running', async () => {
    const running: OptimizationState = { phase: 'running', draft: 'd', previousAttempts: [], role: 'imp-code-reviewer', result: undefined, error: undefined, apply: () => {} }
    const loadRoles = vi.fn(async () => [{ id: 'imp-code-reviewer', name: '代码评审员' }])
    render(<PreviewPanel {...panelProps(running, { loadRoles })} />)
    const select = await waitFor(() => screen.getByLabelText(zh.roleLabel))
    expect(select.hasAttribute('disabled')).toBe(true)
  })

  it('omits the changes list and notes its absence for a note-free result', () => {
    render(<PreviewPanel {...panelProps({ ...READY, result: { ...RESULT, changes: [] } })} />)
    expect(screen.queryByTestId('optimization-changes')).toBeNull()
    expect(screen.getByText(zh.emptyChanges).textContent).toBe(zh.emptyChanges)
  })

  it('cancels through the dismiss verb', () => {
    const cancel = vi.fn()
    render(<PreviewPanel {...panelProps(READY, { cancel })} />)
    screen.getByRole('button', { name: zh.cancel }).click()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('renders critique revisions when a system-mode result carries them', () => {
    render(<PreviewPanel {...panelProps({ ...READY, result: { ...RESULT, critique: ['消除了模糊表述'] } })} />)
    expect(screen.getByTestId('optimization-critique').textContent).toContain('评审修订：消除了模糊表述')
  })

  it('reruns the same draft through the system-prompt loop on demand', () => {
    const regenerateAsSystem = vi.fn()
    render(<PreviewPanel {...panelProps(READY, { regenerateAsSystem })} />)
    screen.getByRole('button', { name: zh.optimizeAsSystem }).click()
    expect(regenerateAsSystem).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('saves the accepted result to the library on demand', async () => {
    const saveToLibrary = vi.fn(async () => {})
    render(<PreviewPanel {...panelProps(READY, { saveToLibrary })} />)
    screen.getByTestId('save-library').click()
    await waitFor(() => { expect(screen.getByTestId('save-library').textContent).toBe(zh.savedLibrary) })
    expect(saveToLibrary).toHaveBeenCalledExactlyOnceWith(SESSION, '优化后的提示词', '优化后的提示词')
  })

  it('surfaces a library save failure inline', async () => {
    const saveToLibrary = vi.fn(async () => { throw new Error('没有存储域') })
    render(<PreviewPanel {...panelProps(READY, { saveToLibrary })} />)
    screen.getByTestId('save-library').click()
    await waitFor(() => { expect(screen.getByTestId('library-error').textContent).toContain('没有存储域') })
    expect(screen.getByTestId('save-library').textContent).toBe(zh.saveLibrary)
  })

  it('keeps the run button disabled until every placeholder is filled', () => {
    const templated: OptimizationState = {
      ...READY,
      result: { ...RESULT, acceptance: [{ text: '脚本能跑通', kind: 'mechanical', commandTemplate: 'python <script>.py' }] },
    }
    render(<PreviewPanel {...panelProps(templated)} />)
    expect(screen.getByRole('button', { name: zh.runCheck }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('script'), { target: { value: 'main.py' } })
    expect(screen.getByRole('button', { name: zh.runCheck }).hasAttribute('disabled')).toBe(false)
  })

  it('fills command placeholders, runs the check, and shows the pass badge', async () => {
    const verifyCheck = vi.fn(async () => ({ passed: true, exitCode: 0, timedOut: false, output: '$ python main.py run.log\nok', durationMs: 4 }))
    const templated: OptimizationState = {
      ...READY,
      result: { ...RESULT, acceptance: [{ text: '脚本能跑通', kind: 'mechanical', commandTemplate: 'python <script>.py <log_file>' }] },
    }
    render(<PreviewPanel {...panelProps(templated, { verifyCheck })} />)
    fireEvent.change(screen.getByLabelText('script'), { target: { value: 'main' } })
    fireEvent.change(screen.getByLabelText('log_file'), { target: { value: 'run.log' } })
    screen.getByRole('button', { name: zh.runCheck }).click()
    await waitFor(() => { expect(screen.getByTestId('criterion-check-result').textContent).toBe(zh.checkPassed) })
    expect(verifyCheck).toHaveBeenCalledExactlyOnceWith(SESSION, '脚本能跑通', 'python main.py run.log')
    expect(screen.getByTestId('criterion-check-output').textContent).toContain('ok')
  })

  it('shows a failed badge for a nonzero exit', async () => {
    const verifyCheck = vi.fn(async () => ({ passed: false, exitCode: 2, timedOut: false, output: '$ ls missing.sh\nls: missing.sh: No such file', durationMs: 3 }))
    render(<PreviewPanel {...panelProps(READY, { verifyCheck })} />)
    screen.getByRole('button', { name: zh.runCheck }).click()
    await waitFor(() => { expect(screen.getByTestId('criterion-check-result').textContent).toBe(zh.checkFailed) })
  })
})
