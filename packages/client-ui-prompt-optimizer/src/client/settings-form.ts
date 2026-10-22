/** Staged default-role preference using the shared Plugins form model. */
import { SettingsFormModel, settingsTextField, type SettingsFieldState,
  type SettingsFormActions, type SettingsFormScope, type SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PromptOptimizerSettings } from 'dsh-prompt-optimizer/types'

/** Slug shape a staged default-role draft must have before the save leaves it. */
const ROLE_SLUG = /^[a-z0-9][a-z0-9-]*$/

/** Current drafts and the shared form status. */
export interface PromptOptimizerFormState extends SettingsFormShell {
  defaultRole: SettingsFieldState
}

/** Registration-side form observable and edit callbacks. */
export interface PromptOptimizerFormInjected extends SettingsFormActions {
  hooks: { settingsForm: SnapshotStore<PromptOptimizerFormState> }
}

/**
 * Stages default-role edits until the reader saves them. An empty draft clears
 * the override; the host's `PROMPT_OPTIMIZER_ROLE_NOT_FOUND` remains the
 * authority on whether a slug names a listed role.
 */
export class PromptOptimizerSettingsForm {
  private readonly form: SettingsFormModel<PromptOptimizerSettings>
  private readonly state: SnapshotStore<PromptOptimizerFormState>

  /** @param scope - Host-backed configuration form for the `prompt-optimizer` namespace. */
  constructor(scope: SettingsFormScope<PromptOptimizerSettings>) {
    this.form = new SettingsFormModel(scope, [{
      ...settingsTextField('defaultRole'),
      parse: (text) => {
        const role = text.trim()
        return role === '' ? { kind: 'clear' } : ROLE_SLUG.test(role) ? { kind: 'set', value: role } : undefined
      },
    }])
    this.state = this.form.bind(() => ({ ...this.form.shell(), defaultRole: this.form.field('defaultRole') }))
  }

  /**
   * Build the registration face for the settings card.
   * @returns draft observable and shared edit/save actions.
   */
  inject(): PromptOptimizerFormInjected { return { hooks: { settingsForm: this.state }, ...this.form.actions() } }
  /** Release the accepted-value subscription. */
  dispose(): void { this.form.dispose() }
}
