import type { LabelDesignElement, LabelDesignV2, LabelTextElement } from './types'

/**
 * Release-owned, editable reconstructions of the eight 3D Filament Profiles
 * swatch layouts, observed 2026-09-07 at /my/spools/details/21472.
 * Geometry below uses the reference's 10 SVG units per millimetre. Content is
 * bound to FilaMan records; no source spool data, logos, or QR URLs are bundled.
 */
export interface StandardLabelPreset {
  name: string
  data: { version: 2; design: LabelDesignV2 }
}

const material = '{filament.type}{ {filament.subtype}}'
const color = '{{filament.color}}'
const rgb = '{{filament.color_hex}}'
const slots = [
  ['Nozzle:', '{{filament.extruder_temp}}'],
  ['Bed Temp:', '{{filament.bed_temp}}'],
  ['Flow Ratio:', '{{extra.filament.flow_ratio}}'],
  ['Dry Time:', '{{extra.filament.dry_time_hours}h}'],
] as const

function layout(width: number, height: number) {
  const elements: LabelDesignElement[] = []
  const box = (x: number, y: number, w: number, h: number) => ({
    id: `standard-${elements.length + 1}`, x: x / 10, y: y / 10,
    w: w / 10, h: h / 10, z: elements.length,
  })
  const text = (template: string, x: number, y: number, w: number, h: number, size: number, options: Partial<LabelTextElement> = {}) => {
    elements.push({
      ...box(x, y, w, Math.max(30, h)), type: 'text', template,
      fontFamily: 'Roboto Condensed', fontSizeMm: size / 10, fontWeight: 400,
      italic: false, underline: false, align: 'left', color: '#000000',
      wrap: false, fitToWidth: !options.wrap, ...options,
    })
  }
  const logo = (x: number, y: number, w: number, h: number) => {
    elements.push({ ...box(x, y, w, h), type: 'manufacturerLogo', objectFit: 'contain', align: 'center' })
  }
  const qr = (x: number, y: number, size: number) => {
    elements.push({ ...box(x, y, size, size), type: 'qr', mode: 'simple', linkMode: 'spool', urlTemplate: '' })
  }
  const band = (x: number, y: number, w: number, h: number, size: number, inset = 4) => {
    elements.push({
      ...box(x, y, w, h), type: 'shape', shape: 'rectangle',
      fill: '#000000', stroke: '', strokeWidthMm: 0, radiusMm: 0,
    })
    text(material, x + inset, y + (h - size * 1.2) / 2, w - inset * 2, h, size, { fontWeight: 700, color: '#FFFFFF' })
  }
  const line = (x: number, y: number, w: number) => {
    elements.push({
      ...box(x, y, w, 1), type: 'shape', shape: 'rectangle',
      fill: '#CCCCCC', stroke: '', strokeWidthMm: 0, radiusMm: 0,
    })
  }
  const rows = (baseline: number, valueWidth: number) => slots.forEach(([label, value], index) => {
    const y = baseline + index * 24 - 20
    text(label, 14, y, 124, 30, 20)
    text(value, 142, y, valueWidth, 30, 20)
  })
  return {
    text, logo, qr, band, line, rows,
    design: { version: 2, label: { widthMm: width, heightMm: height, marginMm: 0, border: false }, elements } satisfies LabelDesignV2,
  }
}

function createStandards(): StandardLabelPreset[] {
  const presets: StandardLabelPreset[] = []
  const add = (name: string, l: ReturnType<typeof layout>) => presets.push({
    name: `${name} (${l.design.label.widthMm} × ${l.design.label.heightMm} mm)`,
    data: { version: 2, design: l.design },
  })

  const classic = layout(40, 30)
  classic.logo(14, 10, 372, 50)
  classic.band(14, 64, 260, 36, 30)
  classic.text(color, 14, 100, 260, 80, 30, { fontWeight: 600, wrap: true })
  classic.text(rgb, 285, 66, 105, 72, 24)
  classic.rows(209, 95)
  classic.qr(250, 150, 140)
  add('Classic', classic)

  const expanded = layout(50, 30)
  expanded.logo(14, 10, 372, 50)
  expanded.band(14, 64, 372, 45, 40.5)
  expanded.text(color, 14, 110, 330, 80, 30, { fontWeight: 600, wrap: true })
  expanded.text(rgb, 390, 76, 105, 72, 24)
  expanded.rows(216, 195)
  expanded.qr(350, 150, 140)
  add('Expanded', expanded)

  const compact = layout(40, 25)
  compact.logo(14, 10, 372, 50)
  compact.qr(10, 80, 140)
  compact.band(160, 80, 230, 36, 30)
  compact.text(color, 160, 116, 230, 69, 30, { wrap: true })
  compact.text(rgb, 160, 190, 230, 30, 24)
  add('Compact', compact)

  const slim = layout(40, 12)
  slim.qr(6, 6, 108)
  slim.logo(124, 8, 270, 32)
  slim.band(124, 46, 270, 24, 21)
  slim.text(color, 124, 74, 270, 36, 24, { fontWeight: 600 })
  add('Slim', slim)

  const slicers = layout(40, 30)
  slicers.text('{filament.manufacturer}', 14, 6, 372, 50, 42, { fontWeight: 700 })
  slicers.text('{filament.type}', 14, 50, 188, 55, 46, { fontWeight: 700 })
  slicers.text('{{filament.subtype}}', 14, 98, 188, 41, 34, { fontWeight: 700 })
  slicers.text(color, 14, 137, 188, 140, 36, { wrap: true })
  slicers.qr(206, 92, 190)
  add('Optimized for slicers', slicers)

  const vertical = layout(30, 40)
  vertical.logo(14, 8, 272, 50)
  vertical.band(14, 66, 272, 36, 27)
  vertical.text(color, 14, 102, 272, 80, 48, { wrap: true })
  vertical.text(rgb, 14, 183, 272, 30, 24)
  vertical.line(14, 222, 272)
  vertical.qr(152, 248, 138)
  slots.forEach(([label, value], index) => {
    vertical.text(label, 14, 240 + index * 38, 130, 30, 12)
    vertical.text(value, 14, 254 + index * 38, 130, 30, 15)
  })
  add('Vertical', vertical)

  const bold = layout(30, 40)
  bold.logo(12, 8, 272, 50)
  bold.band(0, 66, 300, 60, 36, 10)
  bold.text(color, 12, 130, 276, 90, 42, { fontWeight: 600, wrap: true })
  bold.line(12, 225, 276)
  bold.qr(80, 240, 140)
  add('Vertical Bold', bold)

  const narrow = layout(25, 40)
  narrow.logo(12, 8, 226, 50)
  narrow.band(12, 66, 226, 36, 24)
  narrow.text(color, 12, 104, 226, 59, 36, { wrap: true })
  narrow.text(rgb, 12, 166, 226, 30, 20)
  narrow.line(12, 190, 226)
  narrow.qr(30, 200, 190)
  add('Vertical Compact', narrow)
  return presets
}

const standards = createStandards()

/** A working copy prevents edits or account saves from changing release defaults. */
export function getStandardLabelPresets(): StandardLabelPreset[] {
  return structuredClone(standards)
}
