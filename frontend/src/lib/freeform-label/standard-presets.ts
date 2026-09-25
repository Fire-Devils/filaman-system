import type { LabelDesignElement, LabelDesignV2, LabelKind, LabelTextElement } from './types'

/**
 * Release-owned, editable label layouts based on 3D Filament Profiles
 * swatch layouts observed 2026-09-07 at /my/spools/details/21472.
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
type DetailSlot = readonly [label: string, field: string, value: string]

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
  const rows = (baseline: number, valueWidth: number, slots: readonly DetailSlot[]) => slots.forEach(([label, field, value], index) => {
    const y = baseline + index * 24 - 20
    text(`[if={${field}}]${label}[/if]`, 14, y, 124, 30, 20)
    text(`[if={${field}}]${value}[/if]`, 142, y, valueWidth, 30, 20)
  })
  return {
    text, logo, qr, band, rows,
    design: { version: 2, label: { widthMm: width, heightMm: height, marginMm: 0, border: false }, elements } satisfies LabelDesignV2,
  }
}

function createStandards(kind: LabelKind): StandardLabelPreset[] {
  const presets: StandardLabelPreset[] = []
  const add = (name: string, l: ReturnType<typeof layout>) => presets.push({
    name: `${name} (${l.design.label.widthMm} × ${l.design.label.heightMm} mm)`,
    data: { version: 2, design: l.design },
  })

  const slots: readonly DetailSlot[] = kind === 'spool'
    ? [
        ['ID:', 'id', '{id}'],
        ['Diameter:', 'filament.diameter', '{filament.diameter} mm'],
        ['Stocked in:', 'stocked_in_at', '{stocked_in_at|date}'],
      ]
    : [
        ['ID:', 'id', '{id}'],
        ['Diameter:', 'filament.diameter', '{filament.diameter} mm'],
        ['Weight:', 'filament.raw_material_weight_g', '{filament.raw_material_weight_g} g'],
      ]
  const classic = layout(40, 30)
  classic.logo(14, 10, 372, 50)
  classic.band(0, 64, 400, 36, 30, 14)
  classic.text(`${color}[if={filament.color_hex}] · {filament.color_hex}[/if]`, 14, 100, 226, 80, 30, { fontWeight: 600, wrap: true })
  classic.rows(209, 95, slots)
  classic.qr(250, 150, 140)
  add('Classic', classic)

  const qrFocused = layout(40, 30)
  qrFocused.text('{filament.manufacturer}', 14, 6, 372, 50, 42, { fontWeight: 700 })
  qrFocused.text('{filament.type}', 14, 50, 188, 55, 46, { fontWeight: 700 })
  qrFocused.text('{{filament.subtype}}', 14, 98, 188, 41, 34, { fontWeight: 700 })
  qrFocused.text(color, 14, 137, 188, 78, 36, { wrap: true })
  qrFocused.text(rgb, 14, 218, 188, 28, 22)
  qrFocused.text('#{id}', 14, 248, 188, 30, 24, { fontWeight: 600 })
  qrFocused.qr(206, 92, 190)
  add('QR focused', qrFocused)
  return presets
}

const standards = {
  spool: createStandards('spool'),
  filament: createStandards('filament'),
}

/** A working copy prevents edits or account saves from changing release defaults. */
export function getStandardLabelPresets(kind: LabelKind = 'spool'): StandardLabelPreset[] {
  return structuredClone(standards[kind])
}
