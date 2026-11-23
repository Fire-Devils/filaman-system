import {t} from './i18n'
import {normalizeHexCode} from './colors'
import {mountPluginUiLaunchers} from './plugin-ui-launchers'

type Fields = {name: string; hex_code: string}
export type ColorPluginContext = {mode: 'create' | 'edit'; color_id: number | null; usage_count: number; fields: Fields}
function fields(value: unknown): value is Fields {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return Object.keys(data).length === 2 && typeof data.name === 'string' && typeof data.hex_code === 'string'
}
export function mountColorPluginHooks(host: HTMLElement, workspace: HTMLDialogElement, options: {
  read(): ColorPluginContext
  stage(value: Fields): void
  busy(): boolean
  openExisting(id: number, isCurrent: () => boolean, revalidate: () => Promise<boolean>): Promise<boolean>
}, signal: AbortSignal) {
  let draft: ColorPluginContext | undefined
  const controller = mountPluginUiLaunchers(host, {
    surface: 'colors.editor', get mode() { return options.read().mode }, workspace,
    contextType: 'filaman:color-context',
    query: {color_host: 'editor'},
    isEligible: () => ({enabled: workspace.open && !options.busy(), reason: options.busy() ? t('common.saving') : undefined}),
    onClose() { draft = undefined },
    async onMessage(message, session) {
      if (message.type === 'filaman:color-context') {
        draft = options.read()
        session.reply(message, {...draft, capabilities: {color_staging: true}})
      } else if (message.type === 'filaman:color-stage') {
        const current = options.read(), value = message.fields, expected = message.expected
        const unchanged = draft && current.color_id === draft.color_id && current.mode === draft.mode
          && current.fields.name === draft.fields.name && current.fields.hex_code === draft.fields.hex_code
        const matches = draft && fields(expected) && expected.name === draft.fields.name && normalizeHexCode(expected.hex_code) === draft.fields.hex_code
        const hex = fields(value) ? normalizeHexCode(value.hex_code) : ''
        if (session.isCurrent() && !options.busy() && unchanged && matches && fields(value) && value.name.trim() && value.name.trim().length <= 100 && hex) {
          // Publisher RGB suggestions leave opacity under native form control.
          options.stage({name: value.name.trim(), hex_code: hex.slice(0, 7) + current.fields.hex_code.slice(7)})
          draft = options.read()
          session.reply(message, {staged: ['name', 'hex_code'], skipped: [], fields: draft.fields})
        } else session.reply(message, {staged: [], skipped: ['name', 'hex_code']})
      } else if (message.type === 'filaman:color-open' && draft && Number.isSafeInteger(message.color_id) && (message.color_id as number) > 0) {
        const opened = !options.busy() && session.isCurrent() && await options.openExisting(message.color_id as number, session.isCurrent, session.revalidate)
        if (!opened) session.reply(message, {opened: false})
      }
    },
  }, signal)
  return {close: controller.close, updateEligibility: controller.updateEligibility, refresh() { controller.close(); return controller.refresh() }}
}
