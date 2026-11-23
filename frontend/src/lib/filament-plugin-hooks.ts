import type { PluginDraftStageOptions } from './filament-form'
import { mountPluginUiLaunchers } from './plugin-ui-launchers'
import { t } from './i18n'

type FilamentPluginForm = {
  readPluginDraft(): Record<string, unknown>
  stagePluginDraft(units: unknown, draft: Record<string, unknown>, options?: PluginDraftStageOptions): { staged: string[]; skipped: string[] } | Promise<{ staged: string[]; skipped: string[] }>
}
export type SelectedFilament = {
  id: number; manufacturer_id: number; designation: string; material_type: string; record_token?: string
}
type Hook =
  | { mode: 'create' | 'edit'; filamentId: number | null; getRecordToken?: () => string | undefined; form: FilamentPluginForm }
  | { mode: 'selection'; selectedIds: ReadonlySet<number>; expectedFilaments?: ReadonlyMap<number, SelectedFilament> }

export function mountFilamentPluginHooks(host: HTMLElement, hook: Hook, signal?: AbortSignal) {
  let draft: Record<string, unknown> | undefined, recordToken: string | undefined
  let selection: number[] = [], expectedSelection: SelectedFilament[] = [], editEntry = 0
  const cancelAutoOpen = () => { editEntry++ }
  const controller = mountPluginUiLaunchers(host, {
    surface: hook.mode === 'selection' ? 'filaments.selection' : 'filaments.editor',
    mode: hook.mode === 'selection' ? undefined : hook.mode,
    workspace: host.closest<HTMLElement>('.fm-main') || document.body,
    contextType: 'filaman:filament-context',
    query: {filament_host: hook.mode === 'selection' ? 'selection' : 'editor'},
    isEligible: () => ({enabled: hook.mode !== 'selection' || hook.selectedIds.size > 0, reason: t('pluginLaunchers.selectRecords')}),
    onOpen() {
      selection = hook.mode === 'selection' ? [...hook.selectedIds] : []
      expectedSelection = hook.mode === 'selection' ? selection.flatMap(id => {
        const expected = hook.expectedFilaments?.get(id)
        return expected ? [{...expected}] : []
      }) : []
    },
    context: () => ({filament_ids: selection, expected_filaments: expectedSelection}),
    onClose() { draft = undefined; cancelAutoOpen() },
    async onMessage(message, session) {
      if (message.type === 'filaman:filament-context') {
        const context = hook.mode === 'selection'
          ? {mode: hook.mode, filament_ids: selection, expected_filaments: expectedSelection}
          : {mode: hook.mode, filament_id: hook.filamentId, record_token: recordToken = hook.getRecordToken?.(),
            capabilities: {color_staging: true, manufacturer_staging: hook.mode === 'create'}, fields: draft = hook.form.readPluginDraft()}
        session.reply(message, context)
      }
      if (message.type === 'filaman:filament-stage' && hook.mode !== 'selection' && draft) {
        const expectedDraft = draft, expectedToken = recordToken
        const isCurrent = () => session.isCurrent() && draft === expectedDraft && expectedToken === hook.getRecordToken?.()
        const result = await hook.form.stagePluginDraft(message.units, expectedDraft, {signal: session.signal, isCurrent})
        session.reply(message, result)
      }
    },
  }, signal)
  if (hook.mode === 'edit') {
    for (const event of ['pointerdown', 'keydown', 'input', 'submit']) document.addEventListener(event, cancelAutoOpen, {capture: true, signal: controller.signal})
  } else void controller.refresh()
  return {
    close: controller.close,
    updateEligibility: controller.updateEligibility,
    async enterEdit() {
      if (hook.mode !== 'edit') return
      const discovery = controller.refresh()
      const entry = ++editEntry
      const launchers = await discovery
      if (entry !== editEntry) return
      for (const {plugin, button} of launchers) {
        if (!plugin.legacy || plugin.editor_launcher?.allow_auto_open !== true) continue
        try { if (localStorage.getItem(`filaman:plugin:${plugin.plugin_key}:open-on-edit`) !== 'true') continue }
        catch { return }
        if (!document.querySelector('dialog[open]')) { button.focus({preventScroll: true}); void controller.open(plugin) }
        break
      }
    },
  }
}
