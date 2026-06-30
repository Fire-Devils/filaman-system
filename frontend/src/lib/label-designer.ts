/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getReadableTextColor,
  normalizeHexColor,
  parseTemplate,
  renderTemplateText,
  type SpoolData,
} from './label-template'
import { updateLabelPrintPageStyle } from './label-print-style'
import { canvasToQrImage, ensureQrCodeLoaded, getQrCodeConstructor } from './qr-code'

export const DESIGNER_KEY = 'filaman-label-designer-v1'
export const DESIGNER_SCHEMA_VERSION = 1
export const DESIGNER_PRINT_DPI = 600
const MM_TO_PX = 96 / 25.4
const ALIGN_VALUES = ['left', 'center', 'right'] as const
const QR_MODE_VALUES = ['simple', 'logo', 'colorLogo'] as const
const QR_POSITION_VALUES = ['left', 'right'] as const
const VALIGN_VALUES = ['top', 'center', 'bottom'] as const
const QR_LINK_VALUES = ['spool', 'url'] as const
const DEFAULT_PRESET_NAME = 'Default'

export interface LabelDesignerSettings {
  logo:   { show: boolean; spaceMm: number; scaleToFit: boolean; manualSizeMm: number; align: 'left'|'center'|'right' }
  label:  { width: number; height: number; marginMm: number; border: boolean }
  title:  { show: boolean; sizeMm: number; marginMm: number; fitToWidth: boolean; align: 'left'|'center'|'right'; template: string; dividerAbove: boolean; dividerBelow: boolean }
  title2: { show: boolean; sizeMm: number; marginMm: number; fitToWidth: boolean; align: 'left'|'center'|'right'; template: string; dividerAbove: boolean; dividerBelow: boolean }
  qr:     { show: boolean; mode: 'simple'|'logo'|'colorLogo'; sizeMm: number; position: 'left'|'right'; vAlign: 'top'|'center'|'bottom'; linkMode: 'spool'|'url'; urlTemplate: string }
  info:   { show: boolean; sizeMm: number; marginMm: number; hAlign: 'left'|'center'|'right'; vAlign: 'top'|'center'|'bottom'; template: string }
  info2:  { show: boolean; vsep: boolean; sizeMm: number; hAlign: 'left'|'center'|'right'; vAlign: 'top'|'center'|'bottom'; template: string }
}

export const DESIGNER_DEFAULTS: LabelDesignerSettings = {
  logo:   { show: true, spaceMm: 6, scaleToFit: true, manualSizeMm: 6, align: 'left' },
  label:  { width: 60, height: 40, marginMm: 1, border: false },
  title:  { show: true, sizeMm: 4, marginMm: 0, fitToWidth: true, align: 'left', template: '{filament.name}', dividerAbove: false, dividerBelow: true },
  title2: { show: false, sizeMm: 3.5, marginMm: 0, fitToWidth: true, align: 'left', template: '', dividerAbove: false, dividerBelow: false },
  qr:     { show: true, mode: 'logo', sizeMm: 18, position: 'right', vAlign: 'bottom', linkMode: 'spool', urlTemplate: '' },
  info:   { show: true, sizeMm: 2.5, marginMm: 0, hAlign: 'left', vAlign: 'bottom',
            template: '{filament.type}\n{filament.color}\nExt: {filament.extruder_temp}°C\nBed: {filament.bed_temp}°C' },
  info2:  { show: false, vsep: false, sizeMm: 2.5, hAlign: 'left', vAlign: 'bottom', template: '' },
}

/** Token chips shown in the Filament group — available on all 4 print pages. */
export const FILAMENT_TOKENS: { token: string; label: string }[] = [
  { token: '{color_swatch[1]}',                  label: 'color_swatch' },
  { token: '{id}',                               label: 'id' },
  { token: '{filament.id}',                      label: 'filament_id' },
  { token: '{filament.name}',                    label: 'name' },
  { token: '{filament.manufacturer}',            label: 'manufacturer' },
  { token: '{filament.manufacturer_id}',         label: 'manufacturer_id' },
  { token: '{filament.type}',                    label: 'type' },
  { token: '{filament.subtype}',                 label: 'subtype' },
  { token: '{filament.manufacturer_color_name}', label: 'color_name' },
  { token: '{filament.color}',                   label: 'color' },
  { token: '{filament.colors}',                  label: 'colors' },
  { token: '{filament.color_hex}',               label: 'color_hex' },
  { token: '{filament.color_hexes}',             label: 'color_hexes' },
  { token: '{filament.color_mode}',              label: 'color_mode' },
  { token: '{filament.multi_color_style}',       label: 'multi_color_style' },
  { token: '{filament.extruder_temp}',           label: 'extruder_temp' },
  { token: '{filament.bed_temp}',                label: 'bed_temp' },
  { token: '{filament.raw_material_weight_g}',   label: 'raw_material_weight_g' },
  { token: '{filament.diameter}',                label: 'diameter' },
  { token: '{filament.finish}',                  label: 'finish' },
  { token: '{filament.density}',                 label: 'density' },
  { token: '{filament.price}',                   label: 'price' },
  { token: '{filament.default_spool_weight_g}',  label: 'default_spool_wt' },
  { token: '{filament.spool_outer_diameter_mm}', label: 'spool_outer_dia' },
  { token: '{filament.spool_width_mm}',          label: 'spool_width' },
  { token: '{filament.spool_material}',          label: 'spool_material' },
  { token: '{filament.shop_url}',                label: 'shop_url' },
]

/** Token chips shown in the Spool group — only on spool print pages. */
export const SPOOL_TOKENS: { token: string; label: string }[] = [
  { token: '{lot_number}',             label: 'lot_number' },
  { token: '{external_id}',            label: 'external_id' },
  { token: '{rfid_uid}',               label: 'rfid_uid' },
  { token: '{location}',               label: 'location' },
  { token: '{status}',                 label: 'status' },
  { token: '{purchase_date}',          label: 'purchase_date' },
  { token: '{purchase_price}',         label: 'purchase_price' },
  { token: '{remaining_weight_g}',     label: 'remaining_weight_g' },
  { token: '{initial_total_weight_g}', label: 'initial_weight_g' },
  { token: '{empty_spool_weight_g}',   label: 'empty_spool_wt' },
  { token: '{low_weight_threshold_g}', label: 'low_weight_g' },
  { token: '{stocked_in_at}',          label: 'stocked_in_at' },
  { token: '{last_used_at}',           label: 'last_used_at' },
]

/** @deprecated use FILAMENT_TOKENS. Kept for backwards compatibility. */
export const DESIGNER_TOKENS = FILAMENT_TOKENS

function safeGetLocalStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeRemoveLocalStorageItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore blocked storage.
  }
}

function loadDefaultDesignerPresetSettings(presetsKey?: string): LabelDesignerSettings | null {
  if (!presetsKey) return null
  const raw = safeGetLocalStorageItem(presetsKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const presets = Array.isArray(parsed) ? parsed : parsed?.presets
    if (!Array.isArray(presets)) return null
    const preset = presets.find((item: any) => item?.name === DEFAULT_PRESET_NAME && item?.settings)
    return preset ? mergeDesignerSettings(preset.settings) : null
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

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function readTemplate(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.slice(0, 8000) : fallback
}

function readChoice<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

export function normalizeQrSettings(rawQr: any): LabelDesignerSettings['qr'] {
  const merged = { ...DESIGNER_DEFAULTS.qr, ...(rawQr ?? {}) } as any
  const rawMode = merged.mode
  const hadNoneMode = rawMode === 'none'
  const legacyMode = rawMode === 'colorLogo'
    ? 'colorLogo'
    : rawMode === 'logo'
      ? 'logo'
      : rawMode === 'icon'
        ? (merged.colorLogo ? 'colorLogo' : 'logo')
        : 'simple'
  const mode = readChoice(legacyMode, QR_MODE_VALUES, DESIGNER_DEFAULTS.qr.mode)
  const show = merged.show !== undefined ? readBoolean(merged.show, !hadNoneMode) : !hadNoneMode
  return {
    ...DESIGNER_DEFAULTS.qr,
    ...merged,
    show,
    mode,
    sizeMm: clampNumber(Number(merged.sizeMm), 8, 40, DESIGNER_DEFAULTS.qr.sizeMm),
    position: readChoice(merged.position, QR_POSITION_VALUES, DESIGNER_DEFAULTS.qr.position),
    vAlign: readChoice(merged.vAlign, VALIGN_VALUES, DESIGNER_DEFAULTS.qr.vAlign),
    linkMode: readChoice(merged.linkMode, QR_LINK_VALUES, DESIGNER_DEFAULTS.qr.linkMode),
    urlTemplate: readTemplate(merged.urlTemplate, DESIGNER_DEFAULTS.qr.urlTemplate),
  }
}

export function mergeDesignerSettings(raw: any): LabelDesignerSettings {
  const candidate = raw && typeof raw === 'object' ? raw : {}
  const merged = {
    ...DESIGNER_DEFAULTS,
    ...candidate,
    logo:  { ...DESIGNER_DEFAULTS.logo,  ...(candidate.logo ?? {}) },
    label: { ...DESIGNER_DEFAULTS.label, ...(candidate.label ?? {}) },
    title: { ...DESIGNER_DEFAULTS.title, ...(candidate.title ?? {}) },
    title2: { ...DESIGNER_DEFAULTS.title2, ...(candidate.title2 ?? {}) },
    qr: normalizeQrSettings(candidate.qr),
    info:  { ...DESIGNER_DEFAULTS.info,  ...(candidate.info ?? {}) },
    info2: { ...DESIGNER_DEFAULTS.info2, ...(candidate.info2 ?? {}) },
  }
  return {
    logo: {
      show: readBoolean(merged.logo.show, DESIGNER_DEFAULTS.logo.show),
      spaceMm: clampNumber(Number(merged.logo.spaceMm), 2, 20, DESIGNER_DEFAULTS.logo.spaceMm),
      scaleToFit: readBoolean(merged.logo.scaleToFit, DESIGNER_DEFAULTS.logo.scaleToFit),
      manualSizeMm: clampNumber(Number(merged.logo.manualSizeMm), 2, 20, DESIGNER_DEFAULTS.logo.manualSizeMm),
      align: readChoice(merged.logo.align, ALIGN_VALUES, DESIGNER_DEFAULTS.logo.align),
    },
    label: {
      width: clampNumber(Number(merged.label.width), 20, 300, DESIGNER_DEFAULTS.label.width),
      height: clampNumber(Number(merged.label.height), 10, 200, DESIGNER_DEFAULTS.label.height),
      marginMm: clampNumber(Number(merged.label.marginMm), 0, 6, DESIGNER_DEFAULTS.label.marginMm),
      border: readBoolean(merged.label.border, DESIGNER_DEFAULTS.label.border),
    },
    title: {
      show: readBoolean(merged.title.show, DESIGNER_DEFAULTS.title.show),
      sizeMm: clampNumber(Number(merged.title.sizeMm), 1, 20, DESIGNER_DEFAULTS.title.sizeMm),
      marginMm: clampNumber(Number(merged.title.marginMm), -1, 4, DESIGNER_DEFAULTS.title.marginMm),
      fitToWidth: readBoolean(merged.title.fitToWidth, DESIGNER_DEFAULTS.title.fitToWidth),
      align: readChoice(merged.title.align, ALIGN_VALUES, DESIGNER_DEFAULTS.title.align),
      template: readTemplate(merged.title.template, DESIGNER_DEFAULTS.title.template),
      dividerAbove: readBoolean(merged.title.dividerAbove, DESIGNER_DEFAULTS.title.dividerAbove),
      dividerBelow: readBoolean(merged.title.dividerBelow, DESIGNER_DEFAULTS.title.dividerBelow),
    },
    title2: {
      show: readBoolean(merged.title2.show, DESIGNER_DEFAULTS.title2.show),
      sizeMm: clampNumber(Number(merged.title2.sizeMm), 1, 20, DESIGNER_DEFAULTS.title2.sizeMm),
      marginMm: clampNumber(Number(merged.title2.marginMm), -1, 4, DESIGNER_DEFAULTS.title2.marginMm),
      fitToWidth: readBoolean(merged.title2.fitToWidth, DESIGNER_DEFAULTS.title2.fitToWidth),
      align: readChoice(merged.title2.align, ALIGN_VALUES, DESIGNER_DEFAULTS.title2.align),
      template: readTemplate(merged.title2.template, DESIGNER_DEFAULTS.title2.template),
      dividerAbove: readBoolean(merged.title2.dividerAbove, DESIGNER_DEFAULTS.title2.dividerAbove),
      dividerBelow: readBoolean(merged.title2.dividerBelow, DESIGNER_DEFAULTS.title2.dividerBelow),
    },
    qr: normalizeQrSettings(merged.qr),
    info: {
      show: readBoolean(merged.info.show, DESIGNER_DEFAULTS.info.show),
      sizeMm: clampNumber(Number(merged.info.sizeMm), 1, 10, DESIGNER_DEFAULTS.info.sizeMm),
      marginMm: clampNumber(Number(merged.info.marginMm), -1, 4, DESIGNER_DEFAULTS.info.marginMm),
      hAlign: readChoice(merged.info.hAlign, ALIGN_VALUES, DESIGNER_DEFAULTS.info.hAlign),
      vAlign: readChoice(merged.info.vAlign, VALIGN_VALUES, DESIGNER_DEFAULTS.info.vAlign),
      template: readTemplate(merged.info.template, DESIGNER_DEFAULTS.info.template),
    },
    info2: {
      show: readBoolean(merged.info2.show, DESIGNER_DEFAULTS.info2.show),
      vsep: readBoolean(merged.info2.vsep, DESIGNER_DEFAULTS.info2.vsep),
      sizeMm: clampNumber(Number(merged.info2.sizeMm), 1, 10, DESIGNER_DEFAULTS.info2.sizeMm),
      hAlign: readChoice(merged.info2.hAlign, ALIGN_VALUES, DESIGNER_DEFAULTS.info2.hAlign),
      vAlign: readChoice(merged.info2.vAlign, VALIGN_VALUES, DESIGNER_DEFAULTS.info2.vAlign),
      template: readTemplate(merged.info2.template, DESIGNER_DEFAULTS.info2.template),
    },
  }
}

export function loadDesignerSettingsFromStorage(options: { presetsKey?: string; settingsKey?: string } = {}): LabelDesignerSettings {
  const defaultPresetSettings = loadDefaultDesignerPresetSettings(options.presetsKey)
  const fallback = defaultPresetSettings ?? DESIGNER_DEFAULTS
  const storageKey = options.settingsKey ?? DESIGNER_KEY
  const raw = safeGetLocalStorageItem(storageKey)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.version === 'number' && parsed.version >= DESIGNER_SCHEMA_VERSION && parsed.settings) {
      return mergeDesignerSettings(parsed.settings)
    }
    return mergeDesignerSettings(parsed)
  } catch {
    safeRemoveLocalStorageItem(storageKey)
    return fallback
  }
}

export function persistDesignerSettings(
  settings: LabelDesignerSettings,
  setItem: (key: string, value: string) => boolean = safeSetLocalStorageItem,
  settingsKey = DESIGNER_KEY,
) {
  const payload = JSON.stringify({
    version: DESIGNER_SCHEMA_VERSION,
    settings: mergeDesignerSettings(settings),
  })
  return setItem(settingsKey, payload)
}

export function getDesignerLabelDimensions(settings: LabelDesignerSettings) {
  return {
    widthMm: clampNumber(Number(settings.label.width), 20, 300, DESIGNER_DEFAULTS.label.width),
    heightMm: clampNumber(Number(settings.label.height), 10, 200, DESIGNER_DEFAULTS.label.height),
  }
}

export function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function buildSafeQrUrl(linkMode: 'spool'|'url', templateBase: string, entityId: string | number, entityPath = 'spools') {
  if (linkMode === 'url' && templateBase.trim()) {
    try {
      const url = new URL(templateBase.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
      const path = url.pathname.replace(/\/+$/, '')
      return `${url.origin}${path}/${entityPath}/${encodeURIComponent(String(entityId))}`
    } catch {
      // Fall through to safe default.
    }
  }
  return `${window.location.origin}/${entityPath}/${encodeURIComponent(String(entityId))}`
}

export interface DesignerExtraField {
  key: string
  label?: string
  value: unknown
  source?: string
}

export interface DesignerFlatLabelData {
  id: string | number
  // Filament profile fields
  filament_id?: unknown
  designation?: unknown
  manufacturer?: unknown
  manufacturer_id?: unknown
  type?: unknown
  subtype?: unknown
  color?: unknown
  colors?: unknown
  hex_code?: unknown
  color_hexes?: unknown
  color_mode?: unknown
  multi_color_style?: unknown
  extruder_temp?: unknown
  bed_temp?: unknown
  raw_material_weight_g?: unknown
  weight?: unknown
  diameter?: unknown
  finish?: unknown
  density?: unknown
  price?: unknown
  manufacturer_color_name?: unknown
  default_spool_weight_g?: unknown
  spool_outer_diameter_mm?: unknown
  spool_width_mm?: unknown
  spool_material?: unknown
  shop_url?: unknown
  // Spool model fields (only populated on spool print pages)
  lot_number?: unknown
  external_id?: unknown
  rfid_uid?: unknown
  location?: unknown
  status?: unknown
  purchase_date?: unknown
  purchase_price?: unknown
  remaining_weight_g?: unknown
  initial_total_weight_g?: unknown
  empty_spool_weight_g?: unknown
  low_weight_threshold_g?: unknown
  stocked_in_at?: unknown
  last_used_at?: unknown
  extraFields?: DesignerExtraField[]
}

function getApiFilamentColors(filament: any): any[] {
  const list = Array.isArray(filament?.filament_colors)
    ? filament.filament_colors
    : filament?.colors
  return Array.isArray(list) ? list : []
}

function getFilamentColorNames(filament: any): string {
  return getApiFilamentColors(filament)
    .map(color => color?.display_name_override || color?.color?.name)
    .filter(Boolean)
    .join(', ')
}

function getFilamentColorHexes(filament: any): string {
  return getApiFilamentColors(filament)
    .map(color => color?.color?.hex_code)
    .filter(Boolean)
    .join(', ')
}

export function buildSpoolDataFromFlatLabel(data: DesignerFlatLabelData): SpoolData {
  const extra: Record<string, string> = {}
  for (const ef of data.extraFields ?? []) {
    if (!ef?.key) continue
    extra[ef.key] = ef.value === undefined || ef.value === null ? '' : String(ef.value)
  }
  const rawMaterialWeight = data.raw_material_weight_g ?? data.weight
  return {
    id: data.id,
    // Filament profile
    'filament.id': toStringValue(data.filament_id ?? data.id),
    'filament.name': toStringValue(data.designation),
    'filament.type': toStringValue(data.type),
    'filament.subtype': toStringValue(data.subtype),
    // Legacy alias for older saved label templates. New defaults and token
    // pickers use the real filament field name: filament.type.
    'filament.material': toStringValue(data.type),
    'filament.color': toStringValue(data.color),
    'filament.colors': toStringValue(data.colors ?? data.color),
    'filament.color_hex': toStringValue(data.hex_code),
    'filament.color_hexes': toStringValue(data.color_hexes ?? data.hex_code),
    'filament.color_mode': toStringValue(data.color_mode),
    'filament.multi_color_style': toStringValue(data.multi_color_style),
    'filament.manufacturer': toStringValue(data.manufacturer),
    'filament.manufacturer_id': toStringValue(data.manufacturer_id),
    'filament.extruder_temp': toStringValue(data.extruder_temp),
    'filament.bed_temp': toStringValue(data.bed_temp),
    'filament.raw_material_weight_g': toStringValue(rawMaterialWeight),
    // Legacy alias for older saved label templates. New defaults and token
    // pickers use the real filament field name: filament.raw_material_weight_g.
    'filament.weight': toStringValue(rawMaterialWeight),
    'filament.diameter': toStringValue(data.diameter),
    'filament.finish': toStringValue(data.finish),
    'filament.density': toStringValue(data.density),
    'filament.price': toStringValue(data.price),
    'filament.manufacturer_color_name': toStringValue(data.manufacturer_color_name),
    'filament.default_spool_weight_g': toStringValue(data.default_spool_weight_g),
    'filament.spool_outer_diameter_mm': toStringValue(data.spool_outer_diameter_mm),
    'filament.spool_width_mm': toStringValue(data.spool_width_mm),
    'filament.spool_material': toStringValue(data.spool_material),
    'filament.shop_url': toStringValue(data.shop_url),
    // Spool model fields
    lot_number: toStringValue(data.lot_number),
    external_id: toStringValue(data.external_id),
    rfid_uid: toStringValue(data.rfid_uid),
    location: toStringValue(data.location),
    status: toStringValue(data.status),
    purchase_date: toStringValue(data.purchase_date),
    purchase_price: toStringValue(data.purchase_price),
    remaining_weight_g: toStringValue(data.remaining_weight_g),
    initial_total_weight_g: toStringValue(data.initial_total_weight_g),
    empty_spool_weight_g: toStringValue(data.empty_spool_weight_g),
    low_weight_threshold_g: toStringValue(data.low_weight_threshold_g),
    stocked_in_at: toStringValue(data.stocked_in_at),
    last_used_at: toStringValue(data.last_used_at),
    extra,
  }
}

export function buildSpoolDataFromApiSpool(spool: any): SpoolData {
  const fil = spool?.filament ?? {}
  const firstColor = getFirstFilamentColor(fil)
  const color = firstColor?.display_name_override
    || fil.manufacturer_color_name
    || firstColor?.color?.name
    || ''
  const hex = firstColor?.color?.hex_code || ''
  const formatDate = (raw: unknown) => raw ? new Date(String(raw)).toLocaleDateString() : ''
  return buildSpoolDataFromFlatLabel({
    id: spool?.id ?? '',
    // Filament profile
    filament_id: fil.id,
    designation: fil.designation,
    manufacturer: fil.manufacturer?.name,
    manufacturer_id: fil.manufacturer_id ?? fil.manufacturer?.id,
    type: fil.material_type,
    subtype: fil.material_subgroup,
    color,
    colors: getFilamentColorNames(fil),
    hex_code: hex,
    color_hexes: getFilamentColorHexes(fil),
    color_mode: fil.color_mode,
    multi_color_style: fil.multi_color_style,
    extruder_temp: fil.settings_extruder_temp,
    bed_temp: fil.settings_bed_temp,
    raw_material_weight_g: fil.raw_material_weight_g ?? fil.weight,
    weight: fil.raw_material_weight_g ?? fil.weight,
    diameter: fil.diameter_mm,
    finish: fil.finish_type,
    density: fil.density_g_cm3,
    price: fil.price,
    manufacturer_color_name: fil.manufacturer_color_name,
    default_spool_weight_g: fil.default_spool_weight_g,
    spool_outer_diameter_mm: fil.spool_outer_diameter_mm,
    spool_width_mm: fil.spool_width_mm,
    spool_material: fil.spool_material,
    shop_url: fil.shop_url,
    // Spool model fields
    lot_number: spool?.lot_number,
    external_id: spool?.external_id,
    rfid_uid: spool?.rfid_uid,
    location: spool?.location?.label ?? spool?.location?.name,
    status: spool?.status?.label,
    purchase_date: formatDate(spool?.purchase_date),
    purchase_price: spool?.purchase_price,
    remaining_weight_g: spool?.remaining_weight_g,
    initial_total_weight_g: spool?.initial_total_weight_g,
    empty_spool_weight_g: spool?.empty_spool_weight_g,
    low_weight_threshold_g: spool?.low_weight_threshold_g,
    stocked_in_at: formatDate(spool?.stocked_in_at),
    last_used_at: formatDate(spool?.last_used_at),
    extraFields: buildDesignerExtraFieldsFromApiSpool(spool),
  })
}

export function buildDesignerExtraFieldsFromApiSpool(spool: any): DesignerExtraField[] {
  return [
    ...flattenExtraFields(spool?.custom_fields, 'spool'),
    ...flattenExtraFields(spool?.filament?.custom_fields, 'filament'),
  ]
}

export function getManufacturerIdFromApiSpool(spool: any): number | null {
  const value = spool?.filament?.manufacturer?.id
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? id : null
}

export function getFirstFilamentColor(filament: any): any {
  const colorLists = [filament?.filament_colors, filament?.colors]
  for (const list of colorLists) {
    if (Array.isArray(list) && list.length > 0) return list[0] ?? {}
  }
  return {}
}

function flattenExtraFields(value: any, source: 'spool' | 'filament', prefix = ''): DesignerExtraField[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const fields: DesignerExtraField[] = []
  for (const [key, raw] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      fields.push(...flattenExtraFields(raw, source, path))
    } else {
      fields.push({
        key: `${source}.${path}`,
        label: path,
        value: raw,
        source,
      })
    }
  }
  return fields
}

function toStringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

let qrBrandLogo: HTMLImageElement | null = null
let qrBrandLogoPromise: Promise<HTMLImageElement | null> | null = null

async function loadQrBrandLogo(): Promise<HTMLImageElement | null> {
  if (qrBrandLogo) return qrBrandLogo
  if (qrBrandLogoPromise) return qrBrandLogoPromise
  qrBrandLogoPromise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      qrBrandLogo = img
      resolve(img)
    }
    img.onerror = () => resolve(null)
    img.src = window.location.origin + '/logo-qr.png'
  }).finally(() => {
    qrBrandLogoPromise = null
  })
  return qrBrandLogoPromise
}

async function decorateQrCenter(canvas: HTMLCanvasElement, qrPx: number, colorLogo: boolean) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (document.fonts?.ready) {
    await document.fonts.ready
  }

  const cx = qrPx / 2
  const cy = qrPx / 2
  const clearPad = Math.max(colorLogo ? 3 : 6, Math.round(qrPx * (colorLogo ? 0.014 : 0.03)))
  const maxMarkW = Math.round(qrPx * (colorLogo ? 0.32 : 0.34))
  const maxMarkH = Math.round(qrPx * 0.24)

  const fillClearRect = (markW: number, markH: number, padX = clearPad, padY = clearPad) => {
    const clearW = Math.round(markW + padX * 2)
    const clearH = Math.round(markH + padY * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(cx - clearW / 2, cy - clearH / 2, clearW, clearH)
  }

  if (colorLogo) {
    const logoImg = await loadQrBrandLogo()
    if (logoImg) {
      const ar = logoImg.naturalWidth > 0 && logoImg.naturalHeight > 0
        ? logoImg.naturalWidth / logoImg.naturalHeight
        : 1
      let drawW = maxMarkW
      let drawH = Math.round(drawW / ar)
      if (drawH > maxMarkH) {
        drawH = maxMarkH
        drawW = Math.round(drawH * ar)
      }
      fillClearRect(drawW, drawH)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(logoImg, cx - drawW / 2, cy - drawH / 2, drawW, drawH)
      return
    }
  }

  const fontSize = Math.max(18, Math.round(qrPx * 0.11))
  ctx.font = `700 ${fontSize}px "Space Grotesk", sans-serif`
  ;(ctx as CanvasRenderingContext2D & { textRendering?: string }).textRendering = 'geometricPrecision'
  const measured = ctx.measureText('FilaMan')
  const textW = Math.min(maxMarkW, Math.ceil(measured.width))
  const textH = Math.min(maxMarkH, Math.ceil(fontSize * 0.9))
  const textPad = clearPad + Math.max(3, Math.round(qrPx * 0.015))
  fillClearRect(textW, textH, textPad, textPad)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#000000'
  ctx.fillText('FilaMan', cx, cy)
}

export interface RenderDesignerLabelOptions {
  element: HTMLElement
  settings: LabelDesignerSettings
  data: SpoolData
  logoUrl?: string | null
  previewBorder?: boolean
  isStale?: () => boolean
  updatePageStyle?: boolean
  pageStyleId?: string
  /** Entity path used for QR URL generation. Defaults to 'spools'. */
  entityPath?: string
}

export async function renderDesignerLabel(options: RenderDesignerLabelOptions) {
  await ensureQrCodeLoaded()
  if (options.isStale?.()) return

  const { element: labelPreview, data } = options
  const s = mergeDesignerSettings(options.settings)
  const { widthMm: w, heightMm: h } = getDesignerLabelDimensions(s)
  const marginMm = Math.max(0, Number(s.label.marginMm ?? DESIGNER_DEFAULTS.label.marginMm))
  const borderWidthMm = 0.3
  const borderTextGapMm = borderWidthMm
  const contentInsetMm = marginMm + (s.label.border ? (borderWidthMm + borderTextGapMm) : 0)
  labelPreview.style.width = w + 'mm'
  labelPreview.style.height = h + 'mm'
  labelPreview.style.padding = contentInsetMm + 'mm'
  labelPreview.style.border = options.previewBorder === false ? 'none' : '1px dashed #ccc'
  labelPreview.style.setProperty('--print-label-padding', contentInsetMm + 'mm')
  labelPreview.style.setProperty('--inner-border-style', s.label.border ? '0.3mm solid black' : 'none')
  labelPreview.style.setProperty('--inner-border-inset', marginMm + 'mm')

  labelPreview.innerHTML = ''

  const makeRule = () => {
    const r = document.createElement('div')
    r.style.borderTop = '0.3mm solid black'
    r.style.margin = '0'
    return r
  }
  const hasLogo = s.logo?.show !== false && !!options.logoUrl
  const hasTitle1 = !!(s.title.show && s.title.template.trim())
  const hasTitle2 = !!(s.title2?.show && s.title2.template.trim())

  if (hasLogo) {
    const logoRow = document.createElement('div')
    logoRow.style.padding = '0 0 0.5mm 0'
    logoRow.style.display = 'flex'
    logoRow.style.alignItems = 'center'
    const logoAlign = s.logo?.align ?? 'left'
    const logoImg = document.createElement('img')
    logoImg.src = options.logoUrl!
    const logoAny = (s.logo ?? {}) as any
    const logoSpaceMm = Number(logoAny.spaceMm ?? logoAny.sizeMm ?? DESIGNER_DEFAULTS.logo.spaceMm)
    const logoManualMm = Number(logoAny.manualSizeMm ?? logoAny.sizeMm ?? DESIGNER_DEFAULTS.logo.manualSizeMm)
    const logoSpacePx = Math.max(1, Math.round(logoSpaceMm * MM_TO_PX))
    const logoManualPx = Math.max(1, Math.round(logoManualMm * MM_TO_PX))
    const logoBox = document.createElement('div')
    logoBox.style.width = '100%'
    logoBox.style.height = logoSpacePx + 'px'
    logoBox.style.display = 'flex'
    logoBox.style.alignItems = 'center'
    logoBox.style.justifyContent = logoAlign === 'center' ? 'center' : logoAlign === 'right' ? 'flex-end' : 'flex-start'
    if (s.logo.scaleToFit) {
      logoImg.style.height = 'auto'
      logoImg.style.width = 'auto'
      logoImg.style.maxHeight = '100%'
      logoImg.style.maxWidth = '100%'
    } else {
      logoImg.style.height = logoManualPx + 'px'
      logoImg.style.width = 'auto'
      logoImg.style.maxHeight = '100%'
      logoImg.style.maxWidth = '100%'
    }
    logoBox.appendChild(logoImg)
    logoRow.appendChild(logoBox)
    logoImg.style.objectFit = 'contain'
    labelPreview.appendChild(logoRow)
  }

  const renderTitleRow = (cfg: LabelDesignerSettings['title']) => {
    const rowGapMm = Math.max(-1, Math.min(4, Number(cfg.marginMm ?? 0)))
    if (cfg.dividerAbove) {
      const r = makeRule(); r.style.marginBottom = '0'; labelPreview.appendChild(r)
    }

    const titleRow = document.createElement('div')
    titleRow.style.margin = `${rowGapMm}mm 0`
    titleRow.style.overflow = 'hidden'

    const titleEl = document.createElement('div')
    titleEl.style.textAlign = cfg.align
    titleEl.style.fontWeight = '700'
    titleEl.style.lineHeight = '1'
    titleEl.style.overflow = 'hidden'
    titleEl.style.whiteSpace = 'nowrap'
    titleEl.style.textOverflow = cfg.fitToWidth ? 'clip' : 'ellipsis'
    titleEl.style.color = 'black'

    const trimmedTemplate = cfg.template.trim()
    const rowInverseMatch = trimmedTemplate.match(/^==([\s\S]*?)==$/)
    const rowColorInverseMatch = trimmedTemplate.match(/^@@([\s\S]*?)@@$/)
    const rowInverseEnabled = !!(rowInverseMatch || rowColorInverseMatch)
    const renderTemplate = rowInverseMatch ? rowInverseMatch[1] : rowColorInverseMatch ? rowColorInverseMatch[1] : cfg.template
    if (rowInverseEnabled) {
      if (rowColorInverseMatch) {
        const bg = normalizeHexColor(data['filament.color_hex']) ?? '#000000'
        titleEl.style.backgroundColor = bg
        titleEl.style.color = getReadableTextColor(bg)
      } else {
        titleEl.style.backgroundColor = '#000'
        titleEl.style.color = '#fff'
      }
      titleEl.style.display = 'block'
      titleEl.style.width = '100%'
      titleEl.style.boxSizing = 'border-box'
      titleEl.style.padding = '0 0.6mm'
    }

    const resolvedTitleText = renderTemplateText(renderTemplate, data).trim()
    if (!resolvedTitleText) return

    const frag = parseTemplate(renderTemplate, data)
    titleEl.appendChild(frag)
    titleRow.appendChild(titleEl)
    labelPreview.appendChild(titleRow)

    if (cfg.fitToWidth) {
      const maxPx = cfg.sizeMm * 3.78
      titleEl.style.fontSize = maxPx + 'px'
      let lo = 1, hi = maxPx, bestPx = lo
      if (titleEl.scrollWidth <= titleRow.clientWidth) {
        bestPx = maxPx
      } else {
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2
          titleEl.style.fontSize = mid + 'px'
          if (titleEl.scrollWidth <= titleRow.clientWidth) { bestPx = mid; lo = mid }
          else hi = mid
        }
        titleEl.style.fontSize = bestPx + 'px'
        while (bestPx > 1 && titleEl.scrollWidth > titleRow.clientWidth) {
          bestPx -= 0.25
          titleEl.style.fontSize = bestPx + 'px'
        }
      }
      titleEl.style.fontSize = bestPx + 'px'
    } else {
      titleEl.style.fontSize = cfg.sizeMm * 3.78 + 'px'
    }

    if (cfg.dividerBelow) {
      const r = makeRule(); r.style.marginTop = '0'; labelPreview.appendChild(r)
    }
  }

  if (hasTitle1) renderTitleRow(s.title)
  if (hasTitle2) renderTitleRow(s.title2)

  if (!hasTitle1 && !hasTitle2 && hasLogo && s.title.dividerBelow) {
    const r = makeRule(); r.style.marginTop = '0.5mm'; labelPreview.appendChild(r)
  }

  const mainRow = document.createElement('div')
  mainRow.style.display = 'flex'
  mainRow.style.flex = '1'
  mainRow.style.minHeight = '0'
  mainRow.style.marginTop = (s.info.marginMm ?? 0) + 'mm'
  mainRow.style.padding = '0'
  mainRow.style.gap = '1.5mm'
  mainRow.style.flexDirection = s.qr.position === 'left' ? 'row-reverse' : 'row'
  mainRow.style.alignItems = (() => {
    const v = (s.info.show && s.info.template.trim()) ? s.info.vAlign
             : (s.info2?.show && s.info2.template.trim()) ? s.info2.vAlign
             : null
    if (!v) return 'stretch'
    return v === 'top' ? 'flex-start' : v === 'center' ? 'center' : 'flex-end'
  })()
  labelPreview.appendChild(mainRow)

  if (s.info.show && s.info.template.trim()) {
    const infoEl = document.createElement('div')
    infoEl.style.flex = '1'
    infoEl.style.minWidth = '0'
    infoEl.style.fontSize = s.info.sizeMm * 3.78 + 'px'
    infoEl.style.textAlign = s.info.hAlign
    infoEl.style.color = 'black'
    infoEl.style.overflow = 'hidden'
    infoEl.style.lineHeight = '1.4'
    infoEl.appendChild(parseTemplate(s.info.template, data))
    mainRow.appendChild(infoEl)
  }

  const showInfo2 = Boolean(s.info2?.show)
  const hasInfo2Text = showInfo2 && Boolean(s.info2.template.trim())
  if (showInfo2) {
    if (s.info2.vsep) {
      const sep = document.createElement('div')
      sep.style.width = '1px'
      sep.style.alignSelf = 'stretch'
      sep.style.minHeight = '100%'
      sep.style.background = 'black'
      sep.style.flexShrink = '0'
      mainRow.appendChild(sep)
    }
    const info2El = document.createElement('div')
    info2El.style.flex = '1'
    info2El.style.minWidth = '0'
    info2El.style.fontSize = (s.info2.sizeMm * 3.78) + 'px'
    info2El.style.textAlign = s.info2.hAlign
    info2El.style.color = 'black'
    info2El.style.overflow = 'hidden'
    info2El.style.lineHeight = '1.4'
    info2El.style.alignSelf = s.info2.vAlign === 'top' ? 'flex-start' : s.info2.vAlign === 'center' ? 'center' : 'flex-end'
    if (hasInfo2Text) {
      info2El.appendChild(parseTemplate(s.info2.template, data))
    }
    mainRow.appendChild(info2El)
  }

  if (s.qr.show) {
    const qrWrap = document.createElement('div')
    qrWrap.style.flexShrink = '0'
    qrWrap.style.width = s.qr.sizeMm + 'mm'
    qrWrap.style.height = s.qr.sizeMm + 'mm'
    qrWrap.style.alignSelf = s.qr.vAlign === 'top' ? 'flex-start' : s.qr.vAlign === 'center' ? 'center' : 'flex-end'

    const qrUrl = buildSafeQrUrl(s.qr.linkMode, s.qr.urlTemplate, data.id, options.entityPath ?? 'spools')
    const qrPx = Math.min(1024, Math.max(256, Math.round(s.qr.sizeMm * (DESIGNER_PRINT_DPI / 25.4))))

    const QRCode = getQrCodeConstructor()
    if (!QRCode) throw new Error('QRCode is not available')
    new QRCode(qrWrap, {
      text: qrUrl, width: qrPx, height: qrPx,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    })

    const canvas = qrWrap.querySelector('canvas')
    if (canvas && (s.qr.mode === 'logo' || s.qr.mode === 'colorLogo')) {
      await decorateQrCenter(canvas as HTMLCanvasElement, qrPx, s.qr.mode === 'colorLogo')
      if (options.isStale?.()) return
      qrWrap.innerHTML = ''
      qrWrap.appendChild(canvasToQrImage(canvas as HTMLCanvasElement, false))
    } else if (canvas) {
      qrWrap.innerHTML = ''
      qrWrap.appendChild(canvasToQrImage(canvas as HTMLCanvasElement, true))
    }

    mainRow.appendChild(qrWrap)
  }

  if (options.updatePageStyle !== false) {
    updateDesignerPageStyle(w, h, options.pageStyleId)
  }
}

export function updateDesignerPageStyle(widthMm: number, heightMm: number, styleId = 'page-style') {
  updateLabelPrintPageStyle({ widthMm, heightMm, styleId })
}
