/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  clampNumber,
  DESIGNER_DEFAULTS,
  DESIGNER_KEY,
  FILAMENT_TOKENS,
  SPOOL_TOKENS,
  loadDesignerSettingsFromStorage,
  mergeDesignerSettings,
  normalizeQrSettings,
  persistDesignerSettings,
  type DesignerExtraField,
  type LabelDesignerSettings,
} from './label-designer'
import {
  buildFilamentSwatchBackground,
  getReadableTextColorForColors,
  getFilamentSwatchColors,
} from './label-template'

const PRESETS_KEY = 'filaman-label-presets-v1'
const PRESETS_SCHEMA_VERSION = 1
const TOKENS_OPEN_KEY = 'filaman-tokens-open'

interface DesignerModifier {
  key: string
  label: string
  title: string
  className?: string
  wrap: (token: string) => string
}

interface FormFieldSetter {
  id: string
  value: string | number | boolean
  rangePartnerId?: string
}

interface LabelPreset {
  name: string
  settings: LabelDesignerSettings
}

export interface LabelDesignerEditorOptions {
  extraFields?: DesignerExtraField[]
  /** Controls which token groups appear in the picker. 'spool' adds the Spool group. Defaults to 'spool'. */
  entityType?: 'spool' | 'filament'
  getFilamentColorHex?: () => string | null | undefined
  getFilamentColorHexes?: () => string | null | undefined
  getFilamentMultiColorStyle?: () => string | null | undefined
  onChange: () => void | Promise<void>
  safeSetLocalStorage?: (key: string, value: string) => boolean
  translate?: (key: string, fallback: string) => string
  /** localStorage key used to store designer presets. Must be unique per entity type. */
  presetsKey: string
  /** localStorage key used to store the active designer working settings. */
  settingsKey?: string
  /** Label for the entity type (e.g. 'Spool' or 'Filament'). Used for entity-specific UI text. Defaults to 'Spool'. */
  entityLabel?: string
  /** localStorage key of another entity's presets to show as a read-only section in the dropdown. */
  crossPresetsKey?: string
  /** Label for the own-presets optgroup header (shown when crossPresetsKey is provided). */
  ownPresetsLabel?: string
  /** Label for the cross-presets optgroup header. */
  crossPresetsLabel?: string
}

export interface LabelDesignerEditorController {
  loadSettings: () => void
  refreshExtraFields: (extraFields: DesignerExtraField[]) => void
  refreshPresetList: (selectName?: string) => void
  refreshTokenAreas: () => void
}

const DESIGNER_MODIFIERS: DesignerModifier[] = [
  { key: 'bold', label: 'B', title: 'Bold', className: 'ds-modifier-bold', wrap: (token) => `**${token}**` },
  { key: 'italic', label: 'I', title: 'Italic', className: 'ds-modifier-italic', wrap: (token) => `*${token}*` },
  { key: 'underline', label: 'U', title: 'Underline', className: 'ds-modifier-underline', wrap: (token) => `__${token}__` },
  { key: 'inverse', label: '◐', title: 'Inverse', className: 'ds-modifier-inverse', wrap: (token) => `==${token}==` },
  { key: 'colorInverse', label: '◐', title: 'Color Hex Inverse', className: 'ds-modifier-color-inverse', wrap: (token) => `@@${token}@@` },
  { key: 'caps', label: '⇧', title: 'Uppercase', className: 'ds-modifier-caps', wrap: (token) => `^^${token}^^` },
]

const FIELD_IDS = [
  'ds-width','ds-height','ds-margin','ds-logo-space','ds-logo-manual',
  'ds-title-size','ds-title-gap','ds-title2-size','ds-title2-gap',
  'ds-qr-size','ds-info-size','ds-info-gap','ds-info2-size',
  'ds-title-tpl','ds-title2-tpl','ds-qr-url-tpl','ds-info-tpl','ds-info2-tpl',
]

const CHECK_IDS = [
  'ds-border','ds-logo-show','ds-logo-fit','ds-title-show','ds-title-fit',
  'ds-divider-above','ds-divider-below','ds-title2-show','ds-title2-fit',
  'ds-title2-divider-above','ds-title2-divider-below','ds-qr-show',
  'ds-info-show','ds-info2-show','ds-info2-vsep',
]

const SELECT_IDS = ['ds-qr-mode']

const SLIDER_PAIRS: [string, string][] = [
  ['ds-margin-range', 'ds-margin'],
  ['ds-logo-space-range', 'ds-logo-space'],
  ['ds-logo-manual-range', 'ds-logo-manual'],
  ['ds-title-size-range', 'ds-title-size'],
  ['ds-title-gap-range', 'ds-title-gap'],
  ['ds-title2-size-range', 'ds-title2-size'],
  ['ds-title2-gap-range', 'ds-title2-gap'],
  ['ds-qr-size-range', 'ds-qr-size'],
  ['ds-info-size-range', 'ds-info-size'],
  ['ds-info-gap-range', 'ds-info-gap'],
  ['ds-info2-size-range', 'ds-info2-size'],
]

function parseJsonOrNull(raw: string | null): any | null {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function safeGetLocalStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetLocalStorageItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeRemoveLocalStorageItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore blocked storage.
  }
}

function migrateStoredValue(fromKey: string, toKey: string, setItem: (key: string, value: string) => boolean) {
  const value = safeGetLocalStorageItem(fromKey)
  if (!value || safeGetLocalStorageItem(toKey)) return
  if (setItem(toKey, value)) safeRemoveLocalStorageItem(fromKey)
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function cloneSettings(settings: LabelDesignerSettings): LabelDesignerSettings {
  return JSON.parse(JSON.stringify(settings)) as LabelDesignerSettings
}

function sameSettings(a: LabelDesignerSettings | null, b: LabelDesignerSettings) {
  if (!a) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function setElementValue(id: string, value: string | number | boolean) {
  const el = byId(id)
  if (!el) return
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') el.checked = Boolean(value)
    else el.value = String(value)
  } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    el.value = String(value)
  }
}

function setFormFields(fields: FormFieldSetter[]) {
  for (const { id, value, rangePartnerId } of fields) {
    setElementValue(id, value)
    if (rangePartnerId) setElementValue(rangePartnerId, value)
  }
}

function setSecondaryPanelState(toggleId: string, panelId: string, isOpen: boolean) {
  const panel = byId(panelId)
  const toggle = byId(toggleId)
  if (panel) panel.style.display = isOpen ? '' : 'none'
  toggle?.classList.toggle('ds-secondary-open', isOpen)
}

function setAlignGroup(groupId: string, value: string) {
  const group = byId(groupId)
  if (!group) return
  group.dataset.value = value
  group.querySelectorAll<HTMLButtonElement>('.ds-align-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.align === value)
  })
}

function setPillGroup(groupId: string, value: string) {
  const group = byId(groupId)
  if (!group) return
  group.dataset.value = value
  group.querySelectorAll<HTMLButtonElement>('.ds-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === value)
  })
}

function syncQrModeControl() {
  const select = byId<HTMLSelectElement>('ds-qr-mode')
  const label = byId('ds-qr-mode-current-label')
  const icon = byId('ds-qr-mode-current-icon')
  const menu = byId('ds-qr-mode-menu')
  if (!select || !label || !icon) return
  const value = select.value
  const selectedOption = select.selectedOptions[0]
  label.textContent = selectedOption?.textContent?.trim() || value
  icon.textContent = value === 'logo' ? 'FilaMan' : ''
  icon.classList.toggle('is-visible', value === 'logo' || value === 'colorLogo')
  icon.classList.toggle('is-wordmark', value === 'logo')
  icon.classList.toggle('is-color-logo', value === 'colorLogo')
  menu?.querySelectorAll<HTMLButtonElement>('.ds-mode-option').forEach(option => {
    option.setAttribute('aria-selected', String(option.dataset.mode === value))
  })
}

function syncLogoManualControls() {
  const fit = byId<HTMLInputElement>('ds-logo-fit')?.checked ?? true
  const wrap = byId<HTMLElement>('ds-logo-manual-wrap')
  const manualRange = byId<HTMLInputElement>('ds-logo-manual-range')
  const manualNum = byId<HTMLInputElement>('ds-logo-manual')
  if (wrap) wrap.hidden = fit
  if (manualRange) manualRange.disabled = fit
  if (manualNum) manualNum.disabled = fit
}

function autosizeTemplateField(id: string) {
  const el = byId<HTMLTextAreaElement>(id)
  if (!el) return
  const currentHeight = el.offsetHeight || 42
  el.style.height = 'auto'
  el.style.height = `${Math.max(el.scrollHeight, currentHeight, 42)}px`
}

function autosizeTemplateFields() {
  autosizeTemplateField('ds-title-tpl')
  autosizeTemplateField('ds-title2-tpl')
}

function readDesignerSettingsFromForm(): LabelDesignerSettings {
  return mergeDesignerSettings({
    logo: {
      show: byId<HTMLInputElement>('ds-logo-show')?.checked ?? DESIGNER_DEFAULTS.logo.show,
      spaceMm: Number(byId<HTMLInputElement>('ds-logo-space')?.value ?? DESIGNER_DEFAULTS.logo.spaceMm),
      scaleToFit: byId<HTMLInputElement>('ds-logo-fit')?.checked ?? DESIGNER_DEFAULTS.logo.scaleToFit,
      manualSizeMm: Number(byId<HTMLInputElement>('ds-logo-manual')?.value ?? DESIGNER_DEFAULTS.logo.manualSizeMm),
      align: (byId('ds-logo-align-group')?.dataset.value as 'left'|'center'|'right') ?? DESIGNER_DEFAULTS.logo.align,
    },
    label: {
      width: clampNumber(Number(byId<HTMLInputElement>('ds-width')?.value), 20, 300, DESIGNER_DEFAULTS.label.width),
      height: clampNumber(Number(byId<HTMLInputElement>('ds-height')?.value), 10, 200, DESIGNER_DEFAULTS.label.height),
      marginMm: clampNumber(Number(byId<HTMLInputElement>('ds-margin')?.value), 0, 6, DESIGNER_DEFAULTS.label.marginMm),
      border: byId<HTMLInputElement>('ds-border')?.checked ?? DESIGNER_DEFAULTS.label.border,
    },
    title: {
      show: byId<HTMLInputElement>('ds-title-show')?.checked ?? DESIGNER_DEFAULTS.title.show,
      sizeMm: Number(byId<HTMLInputElement>('ds-title-size')?.value ?? DESIGNER_DEFAULTS.title.sizeMm),
      marginMm: Number(byId<HTMLInputElement>('ds-title-gap')?.value ?? DESIGNER_DEFAULTS.title.marginMm),
      fitToWidth: byId<HTMLInputElement>('ds-title-fit')?.checked ?? DESIGNER_DEFAULTS.title.fitToWidth,
      align: (byId('ds-title-align-group')?.dataset.value as 'left'|'center'|'right') ?? DESIGNER_DEFAULTS.title.align,
      template: byId<HTMLTextAreaElement>('ds-title-tpl')?.value ?? DESIGNER_DEFAULTS.title.template,
      dividerAbove: byId<HTMLInputElement>('ds-divider-above')?.checked ?? DESIGNER_DEFAULTS.title.dividerAbove,
      dividerBelow: byId<HTMLInputElement>('ds-divider-below')?.checked ?? DESIGNER_DEFAULTS.title.dividerBelow,
    },
    title2: {
      show: byId<HTMLInputElement>('ds-title2-show')?.checked ?? DESIGNER_DEFAULTS.title2.show,
      sizeMm: Number(byId<HTMLInputElement>('ds-title2-size')?.value ?? DESIGNER_DEFAULTS.title2.sizeMm),
      marginMm: Number(byId<HTMLInputElement>('ds-title2-gap')?.value ?? DESIGNER_DEFAULTS.title2.marginMm),
      fitToWidth: byId<HTMLInputElement>('ds-title2-fit')?.checked ?? DESIGNER_DEFAULTS.title2.fitToWidth,
      align: (byId('ds-title2-align-group')?.dataset.value as 'left'|'center'|'right') ?? DESIGNER_DEFAULTS.title2.align,
      template: byId<HTMLTextAreaElement>('ds-title2-tpl')?.value ?? DESIGNER_DEFAULTS.title2.template,
      dividerAbove: byId<HTMLInputElement>('ds-title2-divider-above')?.checked ?? DESIGNER_DEFAULTS.title2.dividerAbove,
      dividerBelow: byId<HTMLInputElement>('ds-title2-divider-below')?.checked ?? DESIGNER_DEFAULTS.title2.dividerBelow,
    },
    qr: {
      show: byId<HTMLInputElement>('ds-qr-show')?.checked ?? DESIGNER_DEFAULTS.qr.show,
      mode: (byId<HTMLSelectElement>('ds-qr-mode')?.value as 'simple'|'logo'|'colorLogo') ?? DESIGNER_DEFAULTS.qr.mode,
      sizeMm: clampNumber(Number(byId<HTMLInputElement>('ds-qr-size')?.value), 8, 40, DESIGNER_DEFAULTS.qr.sizeMm),
      position: (byId('ds-qr-pos-group')?.dataset.value as 'left'|'right') ?? DESIGNER_DEFAULTS.qr.position,
      vAlign: (byId('ds-qr-valign-group')?.dataset.value as 'top'|'center'|'bottom') ?? DESIGNER_DEFAULTS.qr.vAlign,
      linkMode: (byId('ds-qr-link-group')?.dataset.value as 'spool'|'url') ?? DESIGNER_DEFAULTS.qr.linkMode,
      urlTemplate: byId<HTMLInputElement>('ds-qr-url-tpl')?.value ?? DESIGNER_DEFAULTS.qr.urlTemplate,
    },
    info: {
      show: byId<HTMLInputElement>('ds-info-show')?.checked ?? DESIGNER_DEFAULTS.info.show,
      sizeMm: Number(byId<HTMLInputElement>('ds-info-size')?.value ?? DESIGNER_DEFAULTS.info.sizeMm),
      marginMm: Number(byId<HTMLInputElement>('ds-info-gap')?.value ?? DESIGNER_DEFAULTS.info.marginMm),
      hAlign: (byId('ds-info-align-group')?.dataset.value as 'left'|'center'|'right') ?? DESIGNER_DEFAULTS.info.hAlign,
      vAlign: (byId('ds-info-valign-group')?.dataset.value as 'top'|'center'|'bottom') ?? DESIGNER_DEFAULTS.info.vAlign,
      template: byId<HTMLTextAreaElement>('ds-info-tpl')?.value ?? DESIGNER_DEFAULTS.info.template,
    },
    info2: {
      show: byId<HTMLInputElement>('ds-info2-show')?.checked ?? DESIGNER_DEFAULTS.info2.show,
      vsep: byId<HTMLInputElement>('ds-info2-vsep')?.checked ?? DESIGNER_DEFAULTS.info2.vsep,
      sizeMm: Number(byId<HTMLInputElement>('ds-info2-size')?.value ?? DESIGNER_DEFAULTS.info2.sizeMm),
      hAlign: (byId('ds-info2-align-group')?.dataset.value as 'left'|'center'|'right') ?? DESIGNER_DEFAULTS.info2.hAlign,
      vAlign: (byId('ds-info2-valign-group')?.dataset.value as 'top'|'center'|'bottom') ?? DESIGNER_DEFAULTS.info2.vAlign,
      template: byId<HTMLTextAreaElement>('ds-info2-tpl')?.value ?? DESIGNER_DEFAULTS.info2.template,
    },
  })
}

function applyDesignerSettingsToForm(settings: LabelDesignerSettings) {
  const s = mergeDesignerSettings(settings)
  const rawLogo = (s as any).logo ?? {}
  const logoSpaceMm = Number(rawLogo.spaceMm ?? rawLogo.sizeMm ?? DESIGNER_DEFAULTS.logo.spaceMm)
  const logoManualMm = Number(rawLogo.manualSizeMm ?? rawLogo.sizeMm ?? DESIGNER_DEFAULTS.logo.manualSizeMm)

  setFormFields([
    { id: 'ds-logo-show', value: s.logo.show },
    { id: 'ds-logo-space', value: logoSpaceMm, rangePartnerId: 'ds-logo-space-range' },
    { id: 'ds-logo-fit', value: s.logo.scaleToFit },
    { id: 'ds-logo-manual', value: logoManualMm, rangePartnerId: 'ds-logo-manual-range' },
    { id: 'ds-width', value: s.label.width },
    { id: 'ds-height', value: s.label.height },
    { id: 'ds-margin', value: s.label.marginMm, rangePartnerId: 'ds-margin-range' },
    { id: 'ds-border', value: s.label.border },
    { id: 'ds-title-show', value: s.title.show },
    { id: 'ds-title-size', value: s.title.sizeMm, rangePartnerId: 'ds-title-size-range' },
    { id: 'ds-title-gap', value: s.title.marginMm ?? DESIGNER_DEFAULTS.title.marginMm, rangePartnerId: 'ds-title-gap-range' },
    { id: 'ds-title-fit', value: s.title.fitToWidth },
    { id: 'ds-title-tpl', value: s.title.template },
    { id: 'ds-divider-above', value: s.title.dividerAbove ?? false },
    { id: 'ds-divider-below', value: s.title.dividerBelow ?? true },
    { id: 'ds-title2-show', value: s.title2.show },
    { id: 'ds-title2-size', value: s.title2.sizeMm, rangePartnerId: 'ds-title2-size-range' },
    { id: 'ds-title2-gap', value: s.title2.marginMm ?? DESIGNER_DEFAULTS.title2.marginMm, rangePartnerId: 'ds-title2-gap-range' },
    { id: 'ds-title2-fit', value: s.title2.fitToWidth },
    { id: 'ds-title2-tpl', value: s.title2.template },
    { id: 'ds-title2-divider-above', value: s.title2.dividerAbove ?? false },
    { id: 'ds-title2-divider-below', value: s.title2.dividerBelow ?? false },
    { id: 'ds-qr-show', value: s.qr.show },
    { id: 'ds-qr-mode', value: s.qr.mode },
    { id: 'ds-qr-size', value: s.qr.sizeMm, rangePartnerId: 'ds-qr-size-range' },
    { id: 'ds-qr-url-tpl', value: s.qr.urlTemplate },
    { id: 'ds-info-show', value: s.info.show },
    { id: 'ds-info-size', value: s.info.sizeMm, rangePartnerId: 'ds-info-size-range' },
    { id: 'ds-info-gap', value: s.info.marginMm ?? DESIGNER_DEFAULTS.info.marginMm, rangePartnerId: 'ds-info-gap-range' },
    { id: 'ds-info-tpl', value: s.info.template },
    { id: 'ds-info2-show', value: s.info2.show },
    { id: 'ds-info2-vsep', value: s.info2.vsep ?? false },
    { id: 'ds-info2-size', value: s.info2.sizeMm, rangePartnerId: 'ds-info2-size-range' },
    { id: 'ds-info2-tpl', value: s.info2.template },
  ])

  setAlignGroup('ds-logo-align-group', s.logo.align)
  setAlignGroup('ds-title-align-group', s.title.align)
  setAlignGroup('ds-title2-align-group', s.title2.align)
  setAlignGroup('ds-info-align-group', s.info.hAlign)
  setAlignGroup('ds-info2-align-group', s.info2.hAlign)
  setPillGroup('ds-qr-pos-group', s.qr.position)
  setPillGroup('ds-qr-valign-group', s.qr.vAlign)
  setPillGroup('ds-qr-link-group', s.qr.linkMode)
  setPillGroup('ds-info-valign-group', s.info.vAlign)
  setPillGroup('ds-info2-valign-group', s.info2.vAlign)

  const qrUrlWrap = byId('ds-qr-url-wrap')
  setSecondaryPanelState('ds-title2-toggle', 'ds-title2-block', s.title2.show)
  setSecondaryPanelState('ds-info2-toggle', 'ds-info2-block', s.info2.show)
  syncQrModeControl()
  if (qrUrlWrap) qrUrlWrap.style.display = s.qr.linkMode === 'url' ? '' : 'none'

  syncLogoManualControls()
  autosizeTemplateFields()
}

function loadPresets(key = PRESETS_KEY): LabelPreset[] {
  const parsed = parseJsonOrNull(safeGetLocalStorageItem(key))
  if (!parsed) return []
  try {
    const payload = Array.isArray(parsed) ? { version: 0, presets: parsed } : parsed
    if (!Array.isArray(payload.presets)) return []
    return payload.presets
      .filter((p: any) => p && typeof p.name === 'string' && p.settings)
      .map((p: any) => ({
        name: p.name.trim().slice(0, 120),
        settings: mergeDesignerSettings(p.settings),
      }))
  } catch {
    safeRemoveLocalStorageItem(key)
    return []
  }
}

function savePresets(presets: LabelPreset[], setItem: (key: string, value: string) => boolean, key = PRESETS_KEY) {
  return setItem(key, JSON.stringify({
    version: PRESETS_SCHEMA_VERSION,
    presets,
  }))
}

export function localizeLabelDesignerEditor(translate: (key: string, fallback: string) => string, entityLabel = 'Spool') {
  const translateText = (key: string, fallback: string) => {
    const value = translate(key, fallback)
    return value && value !== key ? value : fallback
  }
  const text = (id: string, key: string, fallback: string) => {
    const el = byId(id)
    if (el) el.textContent = translateText(key, fallback)
  }
  const title = (id: string, key: string, fallback: string) => {
    const el = byId(id)
    if (el) {
      const value = translateText(key, fallback)
      el.title = value
      el.setAttribute('aria-label', value)
    }
  }
  const setTitleValue = (id: string, value: string) => {
    const el = byId(id)
    if (!el) return
    el.title = value
    el.setAttribute('aria-label', value)
  }

  text('dsh-presets-text', 'spools.dsPresets', 'Label Presets')
  text('dsl-preset-saved', 'spools.dsPresetsSaved', 'Saved presets')
  text('ds-preset-load-btn', 'spools.dsPresetsLoad', 'Load')
  title('ds-preset-delete-btn', 'spools.dsPresetsDelete', 'Delete selected preset')
  text('dsl-preset-name', 'spools.dsPresetsName', 'Preset name')
  text('dsl-logo-label', 'spools.dsLogo', 'Logo')
  text('dsl-logo-space', 'spools.dsLogoSpace', 'Space height (mm)')
  text('dsl-logo-manual', 'spools.dsLogoManual', 'Max logo height (mm)')
  text('dsl-logo-fit', 'spools.dsLogoFit', 'Scale to fit bounds')
  text('dsl-logo-align', 'spools.dsJustification', 'Justification')
  text('dsl-label-label', 'spools.dsLabel', 'Label Dimensions')
  text('dsl-width', 'spools.labelWidth', 'Width (mm)')
  text('dsl-height', 'spools.labelHeight', 'Height (mm)')
  text('dsl-margin', 'spools.dsMargin', 'Margin (mm)')
  text('dsl-border', 'spools.dsBorder', 'Print Border')
  text('dsl-title-label', 'spools.dsTitle', 'Title')
  text('dsl-title-size', 'spools.dsTitleSize', 'Max font size (mm)')
  text('dsl-title-fit', 'spools.dsTitleFit', 'Fit to width')
  text('dsl-divider-above', 'spools.dsDividerAbove', 'Line above')
  text('dsl-divider-below', 'spools.dsDividerBelow', 'Line below')
  text('dsl-title-align', 'spools.dsJustification', 'Justification')
  text('dsl-title-gap', 'spools.dsTitleMargin', 'Margin (mm)')
  text('dsl-title-tpl', 'spools.dsTitleFormat', 'Title Format')
  text('dsl-title2-show', 'spools.dsTitle2Show', 'Subtitle')
  text('dsl-title2-size', 'spools.dsTitleSize', 'Max font size (mm)')
  text('dsl-title2-fit', 'spools.dsTitleFit', 'Fit to width')
  text('dsl-title2-divider-above', 'spools.dsDividerAbove', 'Line above')
  text('dsl-title2-divider-below', 'spools.dsDividerBelow', 'Line below')
  text('dsl-title2-align', 'spools.dsJustification', 'Justification')
  text('dsl-title2-gap', 'spools.dsTitleMargin', 'Margin (mm)')
  text('dsl-title2-tpl', 'spools.dsSubtitleFormat', 'Subtitle Format')
  text('dsl-qr-label', 'spools.showQRCode', 'QR Code')
  text('dsl-qr-mode', 'spools.dsQrMode', 'Mode')
  text('dso-qr-simple', 'spools.dsQrSimple', 'Simple')
  text('dso-qr-logo', 'spools.dsQrIcon', 'Logo')
  text('dso-qr-color-logo', 'spools.dsQrColorLogo', 'Color Logo')
  text('dsm-qr-simple-label', 'spools.dsQrSimple', 'Simple')
  text('dsm-qr-logo-label', 'spools.dsQrIcon', 'Logo')
  text('dsm-qr-color-logo-label', 'spools.dsQrColorLogo', 'Color Logo')
  text('dsl-qr-size', 'spools.qrSize', 'Size (mm)')
  text('dsl-qr-pos', 'spools.dsQrPosition', 'Position')
  title('dsp-qr-left', 'spools.dsLeft', 'Left')
  title('dsp-qr-right', 'spools.dsRight', 'Right')
  text('dsl-qr-valign', 'spools.dsVAlign', 'Vertical align')
  title('dsp-qr-top', 'spools.dsTop', 'Top')
  title('dsp-qr-mid', 'spools.dsMid', 'Mid')
  title('dsp-qr-bot', 'spools.dsBot', 'Bottom')
  text('dsl-qr-link', 'spools.dsQrLink', 'Link mode')
  const entityLow = entityLabel.toLowerCase()
  const entityPluralPath = entityLow + 's'
  const qrEntityPill = byId('dsp-qr-spool')
  if (qrEntityPill) qrEntityPill.textContent = `${entityLabel} URL`
  text('dsp-qr-url', 'spools.dsQrCustomUrl', 'Custom URL')
  const entityUrlExample = `${window.location.origin}/${entityPluralPath}/123`
  setTitleValue(
    'dsp-qr-spool',
    translateText('spools.dsQrSpoolUrlHelp', `Encodes the {entity} detail page on this browser origin, for example {example}.`)
      .replace('{entity}', entityLow)
      .replace('{example}', entityUrlExample),
  )
  setTitleValue(
    'dsp-qr-url',
    translateText('spools.dsQrCustomUrlHelp', `Allows entering a custom URL base instead of using this browser origin; FilaMan appends /{entityPath}/{id}.`)
      .replace('{entityPath}', entityPluralPath),
  )
  text('dsl-qr-url-tpl', 'spools.dsQrCustomBase', 'Custom URL base')
  text('dsl-info-label', 'spools.dsInfo', 'Information')
  text('dsl-info-size', 'spools.dsInfoSize', 'Text size (mm)')
  text('dsl-info-gap', 'spools.dsTitleMargin', 'Margin (mm)')
  text('dsl-info-halign', 'spools.dsJustification', 'Justification')
  text('dsl-info-valign', 'spools.dsVAlign', 'Vertical align')
  title('dsip-top', 'spools.dsTop', 'Top')
  title('dsip-mid', 'spools.dsMid', 'Mid')
  title('dsip-bot', 'spools.dsBot', 'Bottom')
  text('dsl-info-tpl', 'spools.dsInfoFormat', 'Information Format')
  text('dsl-info2-show', 'spools.dsInfo2Show', 'Side Column')
  text('dsl-info2-vsep', 'spools.dsInfo2Vsep', 'Vertical separator')
  text('dsl-info2-size', 'spools.dsInfoSize', 'Text size (mm)')
  text('dsl-info2-halign', 'spools.dsJustification', 'Justification')
  text('dsl-info2-valign', 'spools.dsVAlign', 'Vertical align')
  title('dsip2-top', 'spools.dsTop', 'Top')
  title('dsip2-mid', 'spools.dsMid', 'Mid')
  title('dsip2-bot', 'spools.dsBot', 'Bottom')
  text('dsl-info2-tpl', 'spools.dsSideColumnFormat', 'Side Column Format')

  for (const id of ['dsr-label', 'dsr-logo', 'dsr-title', 'dsr-qr', 'dsr-info']) {
    title(id, 'spools.dsResetSection', 'Reset section')
  }
  for (const id of ['ds-title-syntax-btn', 'ds-title2-syntax-btn', 'ds-info-syntax-btn', 'ds-info2-syntax-btn']) {
    title(id, 'spools.dsSyntaxHelp', 'Template syntax help')
  }
  for (const [id, key, fallback] of [
    ['ds-logo-align-group', 'spools.dsJustification', 'Justification'],
    ['ds-title-align-group', 'spools.dsJustification', 'Justification'],
    ['ds-title2-align-group', 'spools.dsJustification', 'Justification'],
    ['ds-info-align-group', 'spools.dsJustification', 'Justification'],
    ['ds-info2-align-group', 'spools.dsJustification', 'Justification'],
  ] as const) {
    const group = byId(id)
    group?.querySelectorAll<HTMLButtonElement>('.ds-align-btn').forEach(btn => {
      const align = btn.dataset.align
      const alignKey = align === 'right' ? 'spools.dsRight' : align === 'center' ? 'spools.dsMid' : 'spools.dsLeft'
      const alignFallback = align === 'right' ? 'Right' : align === 'center' ? 'Center' : 'Left'
      const label = `${translateText(key, fallback)}: ${translateText(alignKey, alignFallback)}`
      btn.title = label
      btn.setAttribute('aria-label', label)
    })
  }
}

export function initLabelDesignerEditor(options: LabelDesignerEditorOptions): LabelDesignerEditorController {
  let extraFields = options.extraFields ?? []
  const setItem = options.safeSetLocalStorage ?? safeSetLocalStorageItem
  const effectivePresetsKey = options.presetsKey
  const effectiveSettingsKey = options.settingsKey
  const getPresets = () => loadPresets(effectivePresetsKey)
  const storePresets = (presets: LabelPreset[]) => savePresets(presets, setItem, effectivePresetsKey)
  const getCrossPresets = options.crossPresetsKey
    ? () => loadPresets(options.crossPresetsKey!)
    : null
  const CROSS_OPTION_PREFIX = '__cross__:'
  const translateRaw = options.translate ?? ((_: string, fallback: string) => fallback)
  const translate = (key: string, fallback: string) => {
    const value = translateRaw(key, fallback)
    return value && value !== key ? value : fallback
  }
  const entityLabel = options.entityLabel ?? 'Spool'
  let activePresetName: string | null = null
  let activePresetSettings: LabelDesignerSettings | null = null
  let previewTimer: ReturnType<typeof setTimeout> | null = null

  const saveDesignerSettings = () => {
    persistDesignerSettings(readDesignerSettingsFromForm(), setItem, effectiveSettingsKey)
  }

  const notifyChange = () => {
    void options.onChange()
  }

  const scheduleChange = () => {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      saveDesignerSettings()
      markActivePresetDirtyIfNeeded()
      notifyChange()
    }, 120)
  }

  function loadSettings() {
    applyDesignerSettingsToForm(loadDesignerSettingsFromStorage({
      presetsKey: effectivePresetsKey,
      settingsKey: effectiveSettingsKey,
    }))
    syncLogoManualControls()
    syncPresetStateFromCurrentSettings()
  }

  function markPresetDirty(dirty: boolean) {
    const hdr = byId('dsh-presets-text')
    if (!hdr) return
    const label = translate('spools.dsPresets', 'Label Presets')
    hdr.textContent = dirty ? `* ${label}` : label
    hdr.classList.toggle('ds-preset-dirty', dirty)
  }

  function markActivePresetDirtyIfNeeded() {
    syncPresetStateFromCurrentSettings()
  }

  function findPresetMatchingSettings(settings: LabelDesignerSettings) {
    return getPresets().find(p => sameSettings(p.settings, settings)) ?? null
  }

  function selectPresetName(name: string | null) {
    const list = byId<HTMLSelectElement>('ds-preset-list')
    if (!list) return
    if (name && Array.from(list.options).some(option => option.value === name)) {
      list.value = name
    } else {
      list.value = ''
    }
  }

  function syncPresetStateFromCurrentSettings() {
    const current = readDesignerSettingsFromForm()
    const matchingPreset = findPresetMatchingSettings(current)
    const nameInput = byId<HTMLInputElement>('ds-preset-name-input')

    if (matchingPreset) {
      activePresetName = matchingPreset.name
      activePresetSettings = cloneSettings(matchingPreset.settings)
      if (nameInput) nameInput.value = matchingPreset.name
      selectPresetName(matchingPreset.name)
      markPresetDirty(false)
    } else {
      selectPresetName(activePresetName)
      markPresetDirty(activePresetName !== null && !sameSettings(activePresetSettings, current))
    }

    updateSaveBtn()
  }

  function refreshPresetList(selectName?: string) {
    const list = byId<HTMLSelectElement>('ds-preset-list')
    if (!list) return
    const ownPresets = getPresets()
    const crossPresets = getCrossPresets?.() ?? []
    list.innerHTML = ''

    const isEmpty = ownPresets.length === 0 && crossPresets.length === 0
    if (isEmpty) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '- no saved presets -'
      opt.disabled = true
      opt.selected = true
      list.appendChild(opt)
      updateSaveBtn()
      return
    }

    const addPlaceholder = (group: HTMLElement | HTMLSelectElement, label: string, selected: boolean) => {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = label
      opt.disabled = true
      opt.selected = selected
      group.appendChild(opt)
    }

    if (getCrossPresets) {
      // Two labeled sections
      const ownGroup = document.createElement('optgroup')
      ownGroup.label = options.ownPresetsLabel ?? translate('spools.dsPresetsSaved', 'Saved presets')
      if (ownPresets.length === 0) {
        addPlaceholder(ownGroup, '- none -', false)
      } else {
        for (const p of ownPresets) {
          const opt = document.createElement('option')
          opt.value = p.name
          opt.textContent = p.name
          ownGroup.appendChild(opt)
        }
      }
      list.appendChild(ownGroup)

      const crossGroup = document.createElement('optgroup')
      crossGroup.label = options.crossPresetsLabel ?? translate('spools.dsPresetsSaved', 'Other presets')
      if (crossPresets.length === 0) {
        addPlaceholder(crossGroup, '- none -', false)
      } else {
        for (const p of crossPresets) {
          const opt = document.createElement('option')
          opt.value = CROSS_OPTION_PREFIX + p.name
          opt.textContent = p.name
          crossGroup.appendChild(opt)
        }
      }
      list.appendChild(crossGroup)

      // Select current value
      const allOptions = Array.from(list.options)
      if (selectName) {
        if (allOptions.some(o => o.value === selectName)) list.value = selectName
      } else if (!allOptions.some(o => o.selected && o.value !== '')) {
        // No valid selection — deselect to placeholder
        list.value = ''
      }
    } else {
      // Single section (no cross presets configured)
      addPlaceholder(list, translate('spools.dsPresetsSaved', 'Saved presets'), !selectName)
      for (const p of ownPresets) {
        const opt = document.createElement('option')
        opt.value = p.name
        opt.textContent = p.name
        list.appendChild(opt)
      }
      if (selectName) list.value = selectName
    }

    updateSaveBtn()
  }

  function updateSaveBtn() {
    const btn = byId<HTMLButtonElement>('ds-preset-save-btn')
    const nameInput = byId<HTMLInputElement>('ds-preset-name-input')
    const loadBtn = byId<HTMLButtonElement>('ds-preset-load-btn')
    const deleteBtn = byId<HTMLButtonElement>('ds-preset-delete-btn')
    const list = byId<HTMLSelectElement>('ds-preset-list')
    if (!btn || !nameInput) return
    const name = nameInput.value.trim()
    const selectedVal = list?.value ?? ''
    const isCrossSelected = selectedVal.startsWith(CROSS_OPTION_PREFIX)
    const currentSettings = readDesignerSettingsFromForm()
    const existingPreset = getPresets().find(p => p.name === name)
    if (!name) {
      btn.textContent = translate('spools.dsPresetsSaveNew', 'Save as New')
      btn.className = 'preset-action-btn preset-action-btn-primary'
      btn.disabled = true
    } else if (existingPreset && sameSettings(existingPreset.settings, currentSettings)) {
      btn.textContent = translate('spools.dsPresetsSavedState', 'Saved')
      btn.className = 'preset-action-btn preset-action-btn-saved'
      btn.disabled = true
    } else if (existingPreset) {
      btn.textContent = translate('spools.dsPresetsOverwrite', 'Overwrite')
      btn.className = 'preset-action-btn preset-action-btn-overwrite'
      btn.disabled = false
    } else {
      btn.textContent = translate('spools.dsPresetsSaveNew', 'Save as New')
      btn.className = 'preset-action-btn preset-action-btn-primary'
      btn.disabled = false
    }
    // Load/Delete: disabled for cross-type selections or empty
    if (loadBtn) loadBtn.disabled = !selectedVal
    if (deleteBtn) deleteBtn.disabled = !selectedVal || isCrossSelected
  }

  function getFilamentInverseChipTheme() {
    const colors = getFilamentSwatchColors(options.getFilamentColorHexes?.() ?? '', options.getFilamentColorHex?.() ?? '')
    if (colors.length === 0) return null
    const background = buildFilamentSwatchBackground(colors, options.getFilamentMultiColorStyle?.() ?? '') || colors[0]
    return {
      background,
      border: colors[0],
      foreground: getReadableTextColorForColors(colors),
    }
  }

  function buildTokenArea(areaId: string, targetId: string) {
    const area = byId(areaId)
    if (!area) return
    const tokenArea = area
    tokenArea.innerHTML = ''
    let activeModifier: DesignerModifier | null = null

    function updateModifierButtons(group: HTMLElement) {
      group.querySelectorAll<HTMLButtonElement>('.ds-modifier-chip').forEach(btn => {
        const isActive = btn.dataset.modifier === activeModifier?.key
        btn.classList.toggle('active', isActive)
        btn.setAttribute('aria-pressed', String(isActive))
      })
    }

    function insertTok(tok: string) {
      const el = byId<HTMLInputElement | HTMLTextAreaElement>(targetId)
      if (!el) return
      const formattedTok = activeModifier ? activeModifier.wrap(tok) : tok
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const before = el.value.slice(0, start)
      const after = el.value.slice(end)
      const needSpaceBefore = before.length > 0 && !/\s$/.test(before)
      const needSpaceAfter = after.length > 0 && !/^\s/.test(after)
      const insert = (needSpaceBefore ? ' ' : '') + formattedTok + (needSpaceAfter ? ' ' : '')
      el.value = before + insert + after
      el.selectionStart = el.selectionEnd = start + insert.length
      el.focus()
      if (activeModifier) {
        activeModifier = null
        updateModifierButtons(tokenArea)
      }
      if (targetId === 'ds-title-tpl' || targetId === 'ds-title2-tpl') autosizeTemplateField(targetId)
      saveDesignerSettings()
      markActivePresetDirtyIfNeeded()
      notifyChange()
    }

    function makeChip(tok: string, label: string) {
      const chip = document.createElement('button')
      chip.className = 'ds-token-chip'
      chip.type = 'button'
      chip.textContent = label
      chip.title = tok
      chip.addEventListener('click', () => insertTok(tok))
      return chip
    }

    function makeModifierChip(modifier: DesignerModifier, group: HTMLElement) {
      const modifierKey = modifier.key === 'bold'
        ? 'spools.dsModifierBold'
        : modifier.key === 'italic'
          ? 'spools.dsModifierItalic'
          : modifier.key === 'underline'
            ? 'spools.dsModifierUnderline'
            : modifier.key === 'inverse'
              ? 'spools.dsModifierInverse'
              : modifier.key === 'colorInverse'
                ? 'spools.dsModifierColorInverse'
                : 'spools.dsModifierCaps'
      const modifierTitle = translate(modifierKey, modifier.title)
      const chip = document.createElement('button')
      chip.className = `ds-modifier-chip ${modifier.className ?? ''}`.trim()
      chip.type = 'button'
      chip.textContent = modifier.label
      chip.title = translate('spools.dsModifierTooltip', '{modifier}: click, then click a token').replace('{modifier}', modifierTitle)
      chip.dataset.tooltip = modifierTitle
      chip.dataset.modifier = modifier.key
      if (modifier.key === 'colorInverse') {
        const theme = getFilamentInverseChipTheme()
        if (theme) {
          chip.classList.add('has-filament-color')
          chip.style.setProperty('--ds-filament-bg', theme.background)
          chip.style.setProperty('--ds-filament-border', theme.border)
          chip.style.setProperty('--ds-filament-fg', theme.foreground)
        }
      }
      chip.setAttribute('aria-label', translate('spools.dsModifierAria', '{modifier} token modifier').replace('{modifier}', modifierTitle))
      chip.setAttribute('aria-pressed', 'false')
      chip.addEventListener('click', () => {
        activeModifier = activeModifier?.key === modifier.key ? null : modifier
        updateModifierButtons(group)
      })
      return chip
    }

    const isOpen = safeGetLocalStorageItem(TOKENS_OPEN_KEY) !== 'false'
    const wrap = document.createElement('div')
    const toggle = document.createElement('button')
    const caret = document.createElement('span')
    const body = document.createElement('div')
    wrap.className = 'ds-token-area-wrap'
    toggle.className = 'ds-tokens-toggle'
    toggle.type = 'button'
    toggle.appendChild(document.createTextNode(translate('spools.dsAvailableTokens', 'Available tokens') + ' '))
    caret.className = 'ds-tokens-caret'
    caret.dataset.open = String(isOpen)
    toggle.appendChild(caret)
    body.className = 'ds-tokens-body'
    body.style.display = isOpen ? '' : 'none'

    const filGroup = document.createElement('div')
    const filHeader = document.createElement('div')
    const filLbl = document.createElement('div')
    const modifierGroup = document.createElement('div')
    const filChips = document.createElement('div')
    filHeader.className = 'ds-tokens-group-header'
    filLbl.className = 'ds-tokens-group-label'
    filLbl.textContent = translate('spools.filament', 'Filament')
    modifierGroup.className = 'ds-modifier-chips'
    for (const modifier of DESIGNER_MODIFIERS) modifierGroup.appendChild(makeModifierChip(modifier, modifierGroup))
    filChips.className = 'ds-token-hints'
    for (const { token, label } of FILAMENT_TOKENS) filChips.appendChild(makeChip(token, label))
    filHeader.appendChild(filLbl)
    filHeader.appendChild(modifierGroup)
    filGroup.appendChild(filHeader)
    filGroup.appendChild(filChips)
    body.appendChild(filGroup)

    // Spool model-field token group — only on spool print pages
    if (options.entityType === 'spool' || options.entityType === undefined) {
      const spoolGroup = document.createElement('div')
      const spoolLbl = document.createElement('div')
      const spoolChips = document.createElement('div')
      spoolLbl.className = 'ds-tokens-group-label'
      spoolLbl.textContent = translate('spools.dsSpool', 'Spool')
      spoolChips.className = 'ds-token-hints'
      for (const { token, label } of SPOOL_TOKENS) spoolChips.appendChild(makeChip(token, label))
      spoolGroup.appendChild(spoolLbl)
      spoolGroup.appendChild(spoolChips)
      body.appendChild(spoolGroup)
    }

    const extGroup = document.createElement('div')
    const extLbl = document.createElement('div')
    const extChips = document.createElement('div')
    extLbl.className = 'ds-tokens-group-label'
    extLbl.textContent = translate(`${entityLabel.toLowerCase()}s.extraFieldsLabel`, `${entityLabel} Extra Fields`)
    extChips.className = 'ds-token-hints'
    if (extraFields.length > 0) {
      for (const ef of extraFields) {
        if (!ef?.key) continue
        const tok = `{extra.${ef.key}}`
        const label = ef.label && ef.label !== ef.key ? ef.label : ef.key
        extChips.appendChild(makeChip(tok, label))
      }
    } else {
      const empty = document.createElement('span')
      empty.className = 'ds-tokens-empty'
      empty.textContent = translate(`${entityLabel.toLowerCase()}s.dsNoCustomFields`, `No custom fields for this ${entityLabel.toLowerCase()}`)
      extChips.appendChild(empty)
    }
    extGroup.appendChild(extLbl)
    extGroup.appendChild(extChips)
    body.appendChild(extGroup)

    toggle.addEventListener('click', () => {
      const open = body.style.display === 'none'
      body.style.display = open ? '' : 'none'
      caret.dataset.open = String(open)
      setItem(TOKENS_OPEN_KEY, String(open))
    })

    wrap.appendChild(toggle)
    wrap.appendChild(body)
    tokenArea.appendChild(wrap)
  }

  function refreshTokenAreas() {
    buildTokenArea('ds-title-token-area', 'ds-title-tpl')
    buildTokenArea('ds-title2-token-area', 'ds-title2-tpl')
    buildTokenArea('ds-info-token-area', 'ds-info-tpl')
    buildTokenArea('ds-info2-token-area', 'ds-info2-tpl')
  }

  function openSyntaxPopover(anchorBtn: HTMLElement) {
    document.querySelector<HTMLElement>('.ds-syntax-popover')?.remove()
    const pop = document.createElement('div')
    pop.className = 'ds-syntax-popover'
    const closeLabel = translate('spools.dsCloseSyntaxHelp', 'Close')
    pop.innerHTML = `
      <button class="ds-popover-close" title="${closeLabel}" aria-label="${closeLabel}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
      <h4>${translate('spools.dsSyntaxTitle', 'Print Format Syntax')}</h4>
      <table>
        <tr><td>{token}</td><td>${translate('spools.dsSyntaxTokenDesc', 'Insert token value; chips show short labels, and the <code>filament.</code> prefix is added automatically when clicked.')}<br><span class="ds-popover-eg">${translate('spools.dsSyntaxTokenEg', 'e.g. type inserts {filament.type}, which prints TPU')}</span></td></tr>
        <tr><td>{text{token}text}</td><td>${translate('spools.dsSyntaxWrapDesc', 'Wrap token with literal text; the whole wrapper is hidden if the token is empty.')}<br><span class="ds-popover-eg">${translate('spools.dsSyntaxWrapEg', 'e.g. {Ext: {filament.extruder_temp}C} prints Ext: 210C, or nothing when temp is unset')}</span></td></tr>
        <tr><td>{color_swatch[1]}</td><td>${translate('spools.dsSyntaxSwatchDesc', 'Inline color swatch from <code>filament.color_hex</code>; the bracket number sets swatch width in character units.')}<br><span class="ds-popover-eg">${translate('spools.dsSyntaxSwatchEgPrefix', 'e.g.')} <span style="display:inline-block;width:1ch;height:0.82em;background:#2A5BE8;border:1px solid rgba(0,0,0,0.28);border-radius:0.14em;vertical-align:baseline;margin:0 0.2ch;"></span> ${translate('spools.dsSyntaxSwatchEgSuffix', 'Blue; [10] is wider')}</span></td></tr>
        <tr><td>[size=120%]text[/size]</td><td>${translate('spools.dsSyntaxSizeDesc', 'Inline relative text size in percent; works with literal text, field values, and swatches.')}<br><span class="ds-popover-eg">${translate('spools.dsSyntaxSizeEg', 'e.g. [size=140%]{filament.extruder_temp}[/size]C')}</span></td></tr>
        <tr><td>**text**</td><td><strong>${translate('spools.dsModifierBold', 'Bold')}</strong></td></tr>
        <tr><td>*text*</td><td><em>${translate('spools.dsModifierItalic', 'Italic')}</em></td></tr>
        <tr><td>__text__</td><td><u>${translate('spools.dsModifierUnderline', 'Underline')}</u></td></tr>
        <tr><td>^^text^^</td><td>${translate('spools.dsSyntaxCapsDesc', 'Uppercase text and field values.')}<br><span class="ds-popover-eg">${translate('spools.dsSyntaxCapsEgPrefix', 'e.g. ^^ff6a00^^ prints')} <span style="font-style:normal">FF6A00</span> ${translate('spools.dsSyntaxCapsEgSuffix', 'in place of')} <span style="font-style:normal">ff6a00</span></span></td></tr>
        <tr><td>==text==</td><td><span style="background:#000;color:#fff;padding:0 2px;border-radius:2px">${translate('spools.dsSyntaxInverseDesc', 'Inverse text, white on black')}</span></td></tr>
        <tr><td>@@text@@</td><td>${translate('spools.dsSyntaxColorInverseDesc', 'Inverse using filament color with automatic black or white text for contrast.')}<br><span class="ds-popover-eg"><span style="background:#2A5BE8;color:#fff;padding:0 2px;border-radius:2px">${translate('spools.dsSyntaxColorInverseBlue', 'Blue uses white text')}</span> <span style="background:#F5E663;color:#000;padding:0 2px;border-radius:2px">${translate('spools.dsSyntaxColorInverseYellow', 'Yellow uses black text')}</span></span></td></tr>
        <tr><td>${translate('spools.dsSyntaxNestedLabel', 'Nested')}</td><td>${translate('spools.dsSyntaxNestedDesc', 'Text modifiers can be nested manually.')}<br><span class="ds-popover-eg">${translate('spools.dsSyntaxNestedEgPrefix', 'e.g. **__{filament.name}__** prints')} <span style="font-style:normal"><strong><u>Galaxy Black</u></strong></span></span></td></tr>
      </table>`
    pop.querySelector('.ds-popover-close')?.addEventListener('click', () => pop.remove())
    pop.style.visibility = 'hidden'
    document.body.appendChild(pop)

    const rect = anchorBtn.getBoundingClientRect()
    const gap = 8
    let left = rect.left
    let top = rect.bottom + 6
    if (left + pop.offsetWidth + gap > window.innerWidth) left = window.innerWidth - pop.offsetWidth - gap
    if (left < gap) left = gap
    if (top + pop.offsetHeight + gap > window.innerHeight) top = rect.top - pop.offsetHeight - 6
    if (top < gap) top = gap
    pop.style.left = `${left}px`
    pop.style.top = `${top}px`
    pop.style.visibility = ''

    setTimeout(() => {
      const handler = (event: MouseEvent) => {
        if (!pop.contains(event.target as Node) && event.target !== anchorBtn) {
          pop.remove()
          document.removeEventListener('click', handler)
        }
      }
      document.addEventListener('click', handler)
    }, 0)
  }

  function wireAlignGroup(groupId: string) {
    const group = byId(groupId)
    if (!group) return
    group.querySelectorAll<HTMLButtonElement>('.ds-align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setAlignGroup(groupId, btn.dataset.align!)
        saveDesignerSettings()
        markActivePresetDirtyIfNeeded()
        notifyChange()
      })
    })
  }

  function wirePillGroup(groupId: string, onChange?: (val: string) => void) {
    const group = byId(groupId)
    if (!group) return
    group.querySelectorAll<HTMLButtonElement>('.ds-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setPillGroup(groupId, btn.dataset.val!)
        saveDesignerSettings()
        onChange?.(btn.dataset.val!)
        markActivePresetDirtyIfNeeded()
        notifyChange()
      })
    })
  }

  function wireResetBtn(id: string, applyDefaults: () => void) {
    const btn = byId<HTMLButtonElement>(id)
    if (!btn) return
    btn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      applyDefaults()
      saveDesignerSettings()
      markActivePresetDirtyIfNeeded()
      notifyChange()
    })
  }

  localizeLabelDesignerEditor(translate, entityLabel)
  syncQrModeControl()
  const qrModeSelect = byId<HTMLSelectElement>('ds-qr-mode')
  const qrModeButton = byId<HTMLButtonElement>('ds-qr-mode-button')
  const qrModeMenu = byId<HTMLElement>('ds-qr-mode-menu')
  const closeQrModeMenu = () => {
    if (!qrModeMenu || !qrModeButton) return
    qrModeMenu.hidden = true
    qrModeButton.setAttribute('aria-expanded', 'false')
  }
  const toggleQrModeMenu = () => {
    if (!qrModeMenu || !qrModeButton) return
    const willOpen = qrModeMenu.hidden
    qrModeMenu.hidden = !willOpen
    qrModeButton.setAttribute('aria-expanded', String(willOpen))
  }
  qrModeButton?.addEventListener('click', (event) => {
    event.preventDefault()
    toggleQrModeMenu()
  })
  qrModeButton?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleQrModeMenu()
    } else if (event.key === 'Escape') {
      closeQrModeMenu()
    }
  })
  qrModeMenu?.querySelectorAll<HTMLButtonElement>('.ds-mode-option').forEach(option => {
    option.addEventListener('click', () => {
      if (!qrModeSelect || !option.dataset.mode) return
      qrModeSelect.value = option.dataset.mode
      syncQrModeControl()
      closeQrModeMenu()
      qrModeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
  })
  qrModeSelect?.addEventListener('change', syncQrModeControl)
  document.addEventListener('click', (event) => {
    if (!qrModeMenu || qrModeMenu.hidden) return
    const root = byId('ds-qr-mode-select')
    if (root?.contains(event.target as Node)) return
    closeQrModeMenu()
  })
  document.querySelectorAll<HTMLElement>('.ds-header-show').forEach(el => {
    el.addEventListener('click', event => event.stopPropagation())
  })
  wireAlignGroup('ds-logo-align-group')
  wireAlignGroup('ds-title-align-group')
  wireAlignGroup('ds-title2-align-group')
  wireAlignGroup('ds-info-align-group')
  wireAlignGroup('ds-info2-align-group')
  wirePillGroup('ds-qr-pos-group')
  wirePillGroup('ds-qr-valign-group')
  wirePillGroup('ds-info-valign-group')
  wirePillGroup('ds-info2-valign-group')
  wirePillGroup('ds-qr-link-group', (val) => {
    const wrap = byId('ds-qr-url-wrap')
    if (wrap) wrap.style.display = val === 'url' ? '' : 'none'
  })

  for (const id of [...FIELD_IDS, ...CHECK_IDS, ...SELECT_IDS]) {
    byId(id)?.addEventListener('change', () => {
      saveDesignerSettings()
      markActivePresetDirtyIfNeeded()
      notifyChange()
    })
  }
  byId('ds-info2-show')?.addEventListener('change', (event) => {
    setSecondaryPanelState('ds-info2-toggle', 'ds-info2-block', (event.target as HTMLInputElement).checked)
  })
  byId('ds-title2-show')?.addEventListener('change', (event) => {
    setSecondaryPanelState('ds-title2-toggle', 'ds-title2-block', (event.target as HTMLInputElement).checked)
  })
  byId('ds-logo-fit')?.addEventListener('change', syncLogoManualControls)
  for (const id of FIELD_IDS) {
    const el = byId(id)
    if (!el || (el as HTMLInputElement).type === 'checkbox') continue
    el.addEventListener('input', () => {
      if (id === 'ds-title-tpl' || id === 'ds-title2-tpl') autosizeTemplateField(id)
      scheduleChange()
    })
  }
  for (const [rangeId, numId] of SLIDER_PAIRS) {
    const range = byId<HTMLInputElement>(rangeId)
    const num = byId<HTMLInputElement>(numId)
    if (!range || !num) continue
    range.addEventListener('input', () => {
      num.value = range.value
      scheduleChange()
    })
    num.addEventListener('input', () => {
      range.value = num.value
    })
  }
  for (const id of ['ds-title-syntax-btn', 'ds-title2-syntax-btn', 'ds-info-syntax-btn', 'ds-info2-syntax-btn']) {
    byId(id)?.addEventListener('click', (event) => {
      event.stopPropagation()
      openSyntaxPopover(event.currentTarget as HTMLElement)
    })
  }

  const presetList = byId<HTMLSelectElement>('ds-preset-list')
  const presetNameInput = byId<HTMLInputElement>('ds-preset-name-input')
  const presetSaveBtn = byId<HTMLButtonElement>('ds-preset-save-btn')
  const presetLoadBtn = byId<HTMLButtonElement>('ds-preset-load-btn')
  const presetDeleteBtn = byId<HTMLButtonElement>('ds-preset-delete-btn')

  presetNameInput?.addEventListener('input', updateSaveBtn)
  presetList?.addEventListener('change', () => {
    const val = presetList.value
    if (presetNameInput) {
      presetNameInput.value = val.startsWith(CROSS_OPTION_PREFIX) ? val.slice(CROSS_OPTION_PREFIX.length) : val
    }
    updateSaveBtn()
  })
  const saveNamedPreset = () => {
    const name = presetNameInput?.value.trim() ?? ''
    if (!name) return
    const presets = getPresets()
    const idx = presets.findIndex(p => p.name === name)
    const settings = readDesignerSettingsFromForm()
    const settingsSaved = persistDesignerSettings(settings, setItem, effectiveSettingsKey)
    if (idx >= 0) presets[idx].settings = settings
    else presets.push({ name, settings })
    const presetsSaved = storePresets(presets)
    if (!settingsSaved || !presetsSaved) {
      console.warn('Failed to save label preset; browser storage may be full or blocked')
      updateSaveBtn()
      return
    }
    activePresetName = name
    activePresetSettings = cloneSettings(settings)
    markPresetDirty(false)
    refreshPresetList(name)
    updateSaveBtn()
  }
  presetSaveBtn?.addEventListener('click', saveNamedPreset)
  presetNameInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    saveNamedPreset()
  })
  presetLoadBtn?.addEventListener('click', () => {
    const val = presetList?.value ?? ''
    if (!val) return
    const isCross = val.startsWith(CROSS_OPTION_PREFIX)
    const name = isCross ? val.slice(CROSS_OPTION_PREFIX.length) : val
    const preset = isCross
      ? getCrossPresets?.().find(p => p.name === name)
      : getPresets().find(p => p.name === name)
    if (!preset) return
    const settings = mergeDesignerSettings({
      ...DESIGNER_DEFAULTS,
      ...preset.settings,
      logo: { ...DESIGNER_DEFAULTS.logo, ...preset.settings.logo },
      label: { ...DESIGNER_DEFAULTS.label, ...preset.settings.label },
      title: { ...DESIGNER_DEFAULTS.title, ...preset.settings.title },
      title2: { ...DESIGNER_DEFAULTS.title2, ...(preset.settings.title2 ?? {}) },
      qr: normalizeQrSettings((preset.settings as any).qr),
      info: { ...DESIGNER_DEFAULTS.info, ...preset.settings.info },
      info2: { ...DESIGNER_DEFAULTS.info2, ...(preset.settings.info2 ?? {}) },
    })
    applyDesignerSettingsToForm(settings)
    persistDesignerSettings(settings, setItem, effectiveSettingsKey)
    if (isCross) {
      // Cross-type load applies settings without making the source preset editable/deletable here.
      activePresetName = null
      activePresetSettings = null
      markPresetDirty(false)
      if (presetNameInput) presetNameInput.value = name
      refreshPresetList()
    } else {
      activePresetName = name
      activePresetSettings = cloneSettings(settings)
      if (presetNameInput) presetNameInput.value = name
      refreshPresetList(name)
      markPresetDirty(false)
    }
    updateSaveBtn()
    notifyChange()
  })
  presetDeleteBtn?.addEventListener('click', () => {
    const val = presetList?.value ?? ''
    // Cross-type presets are read-only — ignore delete
    if (!val || val.startsWith(CROSS_OPTION_PREFIX)) return
    storePresets(getPresets().filter(p => p.name !== val))
    if (activePresetName === val) {
      activePresetName = null
      activePresetSettings = null
      markPresetDirty(false)
    }
    if (presetNameInput) presetNameInput.value = ''
    refreshPresetList()
  })

  wireResetBtn('dsr-logo', () => {
    const d = (activePresetSettings ?? DESIGNER_DEFAULTS).logo
    setFormFields([
      { id: 'ds-logo-show', value: d.show },
      { id: 'ds-logo-space', value: d.spaceMm, rangePartnerId: 'ds-logo-space-range' },
      { id: 'ds-logo-fit', value: d.scaleToFit },
      { id: 'ds-logo-manual', value: d.manualSizeMm, rangePartnerId: 'ds-logo-manual-range' },
    ])
    syncLogoManualControls()
    setAlignGroup('ds-logo-align-group', d.align)
  })
  wireResetBtn('dsr-label', () => {
    const d = (activePresetSettings ?? DESIGNER_DEFAULTS).label
    setFormFields([
      { id: 'ds-width', value: d.width },
      { id: 'ds-height', value: d.height },
      { id: 'ds-margin', value: d.marginMm, rangePartnerId: 'ds-margin-range' },
      { id: 'ds-border', value: d.border },
    ])
  })
  wireResetBtn('dsr-title', () => {
    const base = activePresetSettings ?? DESIGNER_DEFAULTS
    setFormFields([
      { id: 'ds-title-show', value: base.title.show },
      { id: 'ds-title-size', value: base.title.sizeMm, rangePartnerId: 'ds-title-size-range' },
      { id: 'ds-title-gap', value: base.title.marginMm, rangePartnerId: 'ds-title-gap-range' },
      { id: 'ds-title-fit', value: base.title.fitToWidth },
      { id: 'ds-title-tpl', value: base.title.template },
      { id: 'ds-divider-above', value: base.title.dividerAbove },
      { id: 'ds-divider-below', value: base.title.dividerBelow },
      { id: 'ds-title2-show', value: base.title2.show },
      { id: 'ds-title2-size', value: base.title2.sizeMm, rangePartnerId: 'ds-title2-size-range' },
      { id: 'ds-title2-gap', value: base.title2.marginMm, rangePartnerId: 'ds-title2-gap-range' },
      { id: 'ds-title2-fit', value: base.title2.fitToWidth },
      { id: 'ds-title2-tpl', value: base.title2.template },
      { id: 'ds-title2-divider-above', value: base.title2.dividerAbove },
      { id: 'ds-title2-divider-below', value: base.title2.dividerBelow },
    ])
    setAlignGroup('ds-title-align-group', base.title.align)
    setAlignGroup('ds-title2-align-group', base.title2.align)
    setSecondaryPanelState('ds-title2-toggle', 'ds-title2-block', base.title2.show)
    autosizeTemplateFields()
  })
  wireResetBtn('dsr-qr', () => {
    const d = (activePresetSettings ?? DESIGNER_DEFAULTS).qr
    setFormFields([
      { id: 'ds-qr-show', value: d.show },
      { id: 'ds-qr-mode', value: d.mode },
      { id: 'ds-qr-size', value: d.sizeMm, rangePartnerId: 'ds-qr-size-range' },
      { id: 'ds-qr-url-tpl', value: d.urlTemplate },
    ])
    setPillGroup('ds-qr-pos-group', d.position)
    setPillGroup('ds-qr-valign-group', d.vAlign)
    setPillGroup('ds-qr-link-group', d.linkMode)
    const wrap = byId('ds-qr-url-wrap')
    if (wrap) wrap.style.display = d.linkMode === 'url' ? '' : 'none'
  })
  wireResetBtn('dsr-info', () => {
    const base = activePresetSettings ?? DESIGNER_DEFAULTS
    setFormFields([
      { id: 'ds-info-show', value: base.info.show },
      { id: 'ds-info-size', value: base.info.sizeMm, rangePartnerId: 'ds-info-size-range' },
      { id: 'ds-info-gap', value: base.info.marginMm ?? DESIGNER_DEFAULTS.info.marginMm, rangePartnerId: 'ds-info-gap-range' },
      { id: 'ds-info-tpl', value: base.info.template },
      { id: 'ds-info2-show', value: base.info2.show },
      { id: 'ds-info2-vsep', value: base.info2.vsep },
      { id: 'ds-info2-size', value: base.info2.sizeMm, rangePartnerId: 'ds-info2-size-range' },
      { id: 'ds-info2-tpl', value: base.info2.template },
    ])
    setAlignGroup('ds-info-align-group', base.info.hAlign)
    setAlignGroup('ds-info2-align-group', base.info2.hAlign)
    setPillGroup('ds-info-valign-group', base.info.vAlign)
    setPillGroup('ds-info2-valign-group', base.info2.vAlign)
    setSecondaryPanelState('ds-info2-toggle', 'ds-info2-block', base.info2.show)
  })

  refreshTokenAreas()
  // One-time migration: presets previously saved under the legacy key (filaman-label-presets-v1)
  // are spool presets. Copy them to the new spool key on first load, then delete the old key.
  if (effectivePresetsKey === 'filaman-spool-label-presets-v1') {
    migrateStoredValue(PRESETS_KEY, effectivePresetsKey, setItem)
  }
  if (effectiveSettingsKey === 'filaman-spool-label-designer-v1') {
    migrateStoredValue(DESIGNER_KEY, effectiveSettingsKey, setItem)
  }
  const initialPresets = getPresets()
  if (!initialPresets.some(p => p.name === 'Default')) {
    storePresets([{
      name: 'Default',
      settings: {
        logo: { show: true, spaceMm: 5.5, scaleToFit: true, manualSizeMm: 6, align: 'center' },
        label: { width: 40, height: 30, marginMm: 0.8, border: false },
        title: {
          show: true,
          sizeMm: 4,
          marginMm: 0,
          fitToWidth: true,
          align: 'center',
          template: '=={filament.type}==',
          dividerAbove: false,
          dividerBelow: false,
        },
        title2: { show: true, sizeMm: 2, marginMm: 0, fitToWidth: true, align: 'center', template: '{filament.name}', dividerAbove: false, dividerBelow: false },
        qr: { show: true, mode: 'colorLogo', sizeMm: 12, position: 'right', vAlign: 'bottom', linkMode: 'spool', urlTemplate: '' },
        info: {
          show: true,
          sizeMm: 1.6,
          marginMm: 0,
          hAlign: 'left',
          vAlign: 'top',
          template: 'ID: #{id}\nStocked: {stocked_in_at}\nSpool Weight: {empty_spool_weight_g} g\nExt Temp: {filament.extruder_temp}°C\nBed Temp: {filament.bed_temp}°C',
        },
        info2: { show: false, vsep: false, sizeMm: 2.5, hAlign: 'left', vAlign: 'bottom', template: '' },
      },
    }, ...initialPresets])
  }
  refreshPresetList()
  loadSettings()

  return {
    loadSettings,
    refreshExtraFields: (nextExtraFields) => {
      extraFields = nextExtraFields
      refreshTokenAreas()
    },
    refreshPresetList,
    refreshTokenAreas,
  }
}
