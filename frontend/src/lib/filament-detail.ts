import { escapeHtml, formatNumericRange } from './extra-fields'
import {
  getAlphaPercent,
  normalizeHexCode,
  toCssColor,
  toOpaqueRgbHex,
} from './colors'

export interface FilamentDetailRow {
  labelKey: string
  value: string
  href?: string
}

export interface FilamentDetailSection {
  key: string
  titleKey: string
  rows: FilamentDetailRow[]
}

interface FilamentDetailDisplay {
  price?: string
  finish?: string
  discontinued?: string
  spoolTitleKey?: string
}

interface FilamentDetailData {
  [key: string]: unknown
  material_type?: string | null
  material_subgroup?: string | null
  finish_type?: string | null
  diameter_mm?: number | null
  density_g_cm3?: number | null
  is_discontinued?: boolean | null
  raw_material_weight_g?: number | null
  default_spool_weight_g?: number | null
  spool_outer_diameter_mm?: number | null
  spool_width_mm?: number | null
  spool_material?: string | null
  extruder_temp_range_c?: unknown
  bed_temp_range_c?: unknown
  chamber_temp_c?: number | null
  softening_temp_c?: number | null
  drying_temp_c?: number | null
  drying_time_hours?: number | null
  cooling_fan_range_percent?: unknown
  max_volumetric_speed_mm3_s?: number | null
  flow_ratio?: number | null
  pressure_advance_k?: number | null
  ams_compatibility?: string[] | null
  build_plate_compatibility?: string[] | null
  manufacturer_sku?: string | null
  shop_url?: string | null
  datasheet_url?: string | null
  image_url?: string | null
}

function rgba(hex: string, alpha: number): string {
  const value = toOpaqueRgbHex(hex).slice(1)
  return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`
}

type FilamentColors = {
  colors?: Array<{ color?: { hex_code?: string | null } | null }>
  multi_color_style?: string | null
} | null | undefined

function getColors(filament: FilamentColors): string[] {
  return (filament?.colors || [])
    .map((entry) => normalizeHexCode(entry.color?.hex_code))
    .filter(Boolean)
}

export function buildFilamentHeroStyle(
  filament: FilamentColors,
): string {
  const colors = getColors(filament)

  if (!colors.length) return 'background: var(--bg-soft); border: 1px solid var(--border)'

  if (colors.length === 1) {
    const color = colors[0]
    if (getAlphaPercent(color) < 100) {
      const tint = toCssColor(color)
      return `background-image: linear-gradient(${tint}, ${tint}), conic-gradient(var(--border) 25%, var(--bg-elevated) 0 50%, var(--border) 0 75%, var(--bg-elevated) 0); background-size: auto, 18px 18px; border: 1px solid ${rgba(color, 0.5)}`
    }
    return `background-image: linear-gradient(135deg, ${rgba(color, 0.3)}, ${rgba(color, 0.1)}); border: 1px solid ${rgba(color, 0.5)}`
  }

  const hasTransparency = colors.some((color) => getAlphaPercent(color) < 100)
  const tint = (color: string) => hasTransparency && getAlphaPercent(color) < 100 ? toCssColor(color) : rgba(color, 0.68)
  const checkerboard = ', conic-gradient(var(--border) 25%, var(--bg-elevated) 0 50%, var(--border) 0 75%, var(--bg-elevated) 0)'
  const backgroundSize = hasTransparency ? '; background-size: auto, 18px 18px' : ''

  if (filament?.multi_color_style === 'gradient') {
    const stops = colors.map((color, index) => `${tint(color)} ${(index * 100) / (colors.length - 1)}%`).join(', ')
    return `background-image: linear-gradient(135deg, ${stops})${hasTransparency ? checkerboard : ''}${backgroundSize}; border: 1px solid ${rgba(colors[0], 0.5)}`
  }

  const width = 100 / colors.length
  const stops = colors.map((color, index) => `${tint(color)} ${index * width}% ${(index + 1) * width}%`).join(', ')
  return `background-image: linear-gradient(to right, ${stops})${hasTransparency ? checkerboard : ''}${backgroundSize}; border: 1px solid ${rgba(colors[0], 0.5)}`
}

export function buildFilamentSwatchStyle(filament: FilamentColors): string {
  const colors = getColors(filament)
  if (!colors.length) return ''

  const cssColors = colors.map((color) => toCssColor(color))
  const hasTransparency = colors.some((color) => getAlphaPercent(color) < 100)
  const fill = colors.length === 1
    ? `linear-gradient(${cssColors[0]}, ${cssColors[0]})`
    : filament?.multi_color_style === 'gradient'
      ? `linear-gradient(90deg, ${cssColors.join(', ')})`
      : `linear-gradient(90deg, ${cssColors.map((color, index) => `${color} ${(index * 100) / colors.length}% ${((index + 1) * 100) / colors.length}%`).join(', ')})`
  const checkerboard = hasTransparency
    ? ', conic-gradient(#D1D5DB 25%, #FFFFFF 0 50%, #D1D5DB 0 75%, #FFFFFF 0)'
    : ''
  return `background-image: ${fill}${checkerboard}; background-size: ${hasTransparency ? 'auto, 8px 8px' : '100% 100%'}`
}

interface FilamentHeaderData {
  multi_color_style?: string | null
  manufacturer?: { name?: string | null } | null
  material_type?: string | null
  material_subgroup?: string | null
  designation?: string | null
  manufacturer_color_name?: string | null
  colors?: Array<{
    display_name_override?: string | null
    color?: { name?: string | null; hex_code?: string | null } | null
  }>
}

export function formatHeaderId(id: number | string): string {
  return String(id).padStart(2, '0')
}

export function buildFilamentHeaderName(filament: FilamentHeaderData): string {
  const designation = filament.designation?.trim() || ''
  const normalizedProduct = ` ${designation.toLowerCase().split(/[\s-]+/).join(' ')} `
  const appearsInProduct = (value: string) => normalizedProduct.includes(` ${value.toLowerCase().split(/[\s-]+/).join(' ')} `)
  const materialType = filament.material_type?.trim() || ''
  const variant = filament.material_subgroup?.trim() || ''
  return [
    filament.manufacturer?.name?.trim(),
    materialType && !appearsInProduct(materialType) ? materialType : '',
    variant && !appearsInProduct(variant) ? variant : '',
    designation,
  ].filter(Boolean).join(' ')
}

export function renderFilamentHeaderColors(filament: FilamentHeaderData, soldAsLabel: string): string {
  const colors = (filament.colors || []).filter(entry => entry.color)
  if (!colors.length) return ''
  const names = colors.map(entry => entry.display_name_override?.trim() || entry.color?.name?.trim() || normalizeHexCode(entry.color?.hex_code) || '—')
  const hexes = colors.map(entry => `<code>${escapeHtml(normalizeHexCode(entry.color?.hex_code) || '—')}</code>`).join('')
  const makerName = filament.manufacturer_color_name?.trim()
  const showMakerName = makerName && !names.some(name => name.toLowerCase() === makerName.toLowerCase())
  return `<div class="filament-color-list"><div class="filament-color">
    <span class="filament-color-visual" style="--color-count:${colors.length}">
      <span class="filament-color-dot" style="${buildFilamentSwatchStyle(filament)}"></span>
      <span class="filament-color-hexes" style="grid-template-columns:repeat(${colors.length},minmax(0,1fr))">${hexes}</span>
    </span>
    <span class="filament-color-labels"><span class="filament-color-name">${names.map(escapeHtml).join(' · ')}</span>${showMakerName ? `<span class="filament-color-maker-name">${escapeHtml(soldAsLabel)}: ${escapeHtml(makerName)}</span>` : ''}</span>
  </div></div>`
}

export function buildFilamentDetailSections(
  filament: FilamentDetailData,
  display: FilamentDetailDisplay = {},
): FilamentDetailSection[] {
  const row = (labelKey: string, value: unknown, suffix = '', href?: string | null): FilamentDetailRow => {
    const missing = value === null || value === undefined || value === ''
    return { labelKey, value: missing ? '—' : `${value}${suffix}`, ...(!missing && href ? { href } : {}) }
  }
  const range = (labelKey: string, value: unknown, suffix: string) => row(labelKey, formatNumericRange(value), suffix)

  return [
    {
      key: 'material',
      titleKey: 'filaments.materialDetails',
      rows: [
        row('filaments.type', filament.material_type),
        row('filaments.materialSubgroup', filament.material_subgroup),
        row('filaments.finishType', display.finish ?? filament.finish_type),
        row('filaments.diameter', filament.diameter_mm, ' mm'),
        row('filaments.densityLabel', filament.density_g_cm3, ' g/cm³'),
        row('filaments.discontinued', display.discontinued),
      ],
    },
    {
      key: 'spool',
      titleKey: display.spoolTitleKey ?? 'filaments.spoolDetails',
      rows: [
        row('filaments.rawMaterialWeightLabel', filament.raw_material_weight_g, ' g'),
        row('filaments.defaultSpoolWeightLabel', filament.default_spool_weight_g, ' g'),
        row('spools.spoolOuterDiameterLabel', filament.spool_outer_diameter_mm, ' mm'),
        row('spools.spoolWidthLabel', filament.spool_width_mm, ' mm'),
        row('spools.spoolMaterial', filament.spool_material),
        row('filaments.price', display.price),
      ],
    },
    {
      key: 'temperatures',
      titleKey: 'filaments.temperatures',
      rows: [
        range('filaments.extruderTemperatureLabel', filament.extruder_temp_range_c, ' °C'),
        range('filaments.bedTemperatureLabel', filament.bed_temp_range_c, ' °C'),
        row('filaments.chamberTemperatureLabel', filament.chamber_temp_c, ' °C'),
        row('filaments.softeningTemperatureLabel', filament.softening_temp_c, ' °C'),
      ],
    },
    {
      key: 'drying',
      titleKey: 'filaments.dryingInfo',
      rows: [
        row('filaments.dryingTemperatureLabel', filament.drying_temp_c, ' °C'),
        row('filaments.dryingTimeLabel', filament.drying_time_hours, ' h'),
      ],
    },
    {
      key: 'printBehavior',
      titleKey: 'filaments.printBehavior',
      rows: [
        range('filaments.coolingFanLabel', filament.cooling_fan_range_percent, '%'),
        row('filaments.maxVolumetricSpeedLabel', filament.max_volumetric_speed_mm3_s, ' mm³/s'),
        row('filaments.flowRatio', filament.flow_ratio),
        row('filaments.pressureAdvance', filament.pressure_advance_k),
      ],
    },
    {
      key: 'compatibilitySources',
      titleKey: 'filaments.compatibilitySources',
      rows: [
        row('filaments.amsCompatibility', filament.ams_compatibility?.join(', ')),
        row('filaments.buildPlateCompatibility', filament.build_plate_compatibility?.join(', ')),
        row('filaments.manufacturerSku', filament.manufacturer_sku),
        row('filaments.shopUrl', filament.shop_url, '', filament.shop_url),
        row('filaments.datasheetUrl', filament.datasheet_url, '', filament.datasheet_url),
        row('filaments.imageUrl', filament.image_url, '', filament.image_url),
      ],
    },
  ]
}
