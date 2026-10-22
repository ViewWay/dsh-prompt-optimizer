/** Default-role configuration on the plugin bundle's page. */
import { useEffect, useId, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PromptRoleSummary } from 'dsh-prompt-optimizer/types'
import { Button, SettingsForm, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { PromptOptimizerFormInjected } from './settings-form.ts'
import css from './PromptOptimizerSettings.module.css'

/** Settings form plus the host roles listing that feeds the picker. */
export interface PromptOptimizerSettingsInjected extends PromptOptimizerFormInjected {
  /** List the host's selectable role definitions; a failing listing keeps the staged text editable. */
  loadRoles: () => Promise<readonly PromptRoleSummary[]>
}

/** Bundle-config owner share plus the injected form and roles verb. */
export type PromptOptimizerSettingsProps =
  PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS> & InjectFace<PromptOptimizerSettingsInjected>

/**
 * Render the staged default-role preference: a picker over the host's listed
 * roles with an unstyled default and a marked option for a stored slug that no
 * longer resolves.
 * @param props - staged form state, save actions, and the roles verb.
 * @returns the bundle's default-role card.
 */
export function PromptOptimizerSettings(props: PromptOptimizerSettingsProps) {
  const { t } = props
  const roleId = useId()
  const state = props.useSettingsForm(value => value)
  const [roles, setRoles] = useState<readonly PromptRoleSummary[]>([])
  const [rolesFailed, setRolesFailed] = useState(false)
  useEffect(() => {
    let alive = true
    // A failing listing keeps the field a plain staged slug; the card stays usable.
    void props.loadRoles().then(
      (summaries) => { if (alive) { setRoles(summaries); setRolesFailed(false) } },
      (error: unknown) => { void error; if (alive) { setRoles([]); setRolesFailed(true) } },
    )
    return () => { alive = false }
  }, [props.loadRoles])
  const disabled = !state.writable || state.saving
  const stored = state.defaultRole.text.trim()
  const missingRole = stored !== '' && !roles.some(summary => summary.id === stored)
  return <SettingsForm labels={{
    unavailable: t('settingsUnavailable'), readOnly: t('settingsReadOnly'), saveFailed: t('settingsSaveFailed'),
    save: t('settingsSave'), saving: t('settingsSaving'),
  }} state={state} onSave={props.save} onDiscard={props.discard}>
    <div className={css.field}>
      <div className={css.toolbar}>
        <label htmlFor={roleId}>{t('settingsDefaultRole')}</label>
        {state.defaultRole.overridden
          ? <><Tag tone="neutral">{t('settingsDefaultRoleHint')}</Tag>
            <Button size="sm" disabled={disabled} onClick={() => { props.resetField('defaultRole') }}>{t('settingsReset')}</Button></>
          : <span className={css.hint}>{t('settingsDefaultRoleHint')}</span>}
      </div>
      <select id={roleId} value={stored} disabled={disabled} aria-invalid={state.defaultRole.invalid || undefined}
        onChange={(event) => { props.edit('defaultRole', event.target.value) }}>
        <option value="">{t('roleNone')}</option>
        {missingRole && <option value={stored} disabled>{t('settingsRoleUnavailableOption', { role: stored })}</option>}
        {roles.map(summary => <option key={summary.id} value={summary.id}>{summary.name}</option>)}
      </select>
      {state.defaultRole.invalid && <p role="status">{t('settingsRoleUnavailableOption', { role: stored })}</p>}
      {rolesFailed && !state.defaultRole.invalid && <p role="status" className={css.hint}>{t('settingsRolesUnavailable')}</p>}
    </div>
  </SettingsForm>
}
