/** One-way compatibility adapter for FilaMan schema v1 presets. */
import {
  LEGACY_DESIGNER_DEFAULTS,
  type LegacyInfoSettings,
  type LegacyLabelDesignerSettings,
  type LegacyTitleSettings,
} from './legacy-v1'
import { normalizeLabelDesign, type NormalizeLabelDesignOptions } from './normalize'
import { normalizeTemplateEmphasis } from './template-selection'
import { createLabelElementId } from './id'
import type {
  LabelDesignElement,
  LabelDesignerPresetData,
  LabelElementIdFactory,
  LabelKind,
} from './types'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, numberOr(value, fallback)))
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function choiceOr<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

function titleSettings(raw: unknown, defaults: LegacyTitleSettings): LegacyTitleSettings {
  const value = record(raw)
  return {
    show: boolOr(value.show, defaults.show),
    sizeMm: bounded(value.sizeMm, defaults.sizeMm, 1, 20),
    marginMm: bounded(value.marginMm, defaults.marginMm, -1, 4),
    fitToWidth: boolOr(value.fitToWidth, defaults.fitToWidth),
    align: choiceOr(value.align, ['left', 'center', 'right'], defaults.align),
    template: stringOr(value.template, defaults.template),
    dividerAbove: boolOr(value.dividerAbove, defaults.dividerAbove),
    dividerBelow: boolOr(value.dividerBelow, defaults.dividerBelow),
  }
}

function infoSettings(raw: unknown, defaults: LegacyInfoSettings): LegacyInfoSettings {
  const value = record(raw)
  return {
    show: boolOr(value.show, defaults.show),
    sizeMm: bounded(value.sizeMm, defaults.sizeMm, 1, 10),
    hAlign: choiceOr(value.hAlign, ['left', 'center', 'right'], defaults.hAlign),
    vAlign: choiceOr(value.vAlign, ['top', 'center', 'bottom'], defaults.vAlign),
    template: stringOr(value.template, defaults.template),
  }
}

function normalizeLegacySettings(raw: unknown): LegacyLabelDesignerSettings {
  const value = record(raw)
  const label = record(value.label)
  const logo = record(value.logo)
  const qr = record(value.qr)
  const info = record(value.info)
  const info2 = record(value.info2)
  const rawQrMode = qr.mode
  const qrMode = rawQrMode === 'colorLogo'
    ? 'colorLogo'
    : rawQrMode === 'logo'
      ? 'logo'
      : rawQrMode === 'simple'
        ? 'simple'
      : rawQrMode === 'icon'
        ? (qr.colorLogo === true ? 'colorLogo' : 'logo')
        : LEGACY_DESIGNER_DEFAULTS.qr.mode
  return {
    label: {
      width: bounded(label.width, LEGACY_DESIGNER_DEFAULTS.label.width, 20, 300),
      height: bounded(label.height, LEGACY_DESIGNER_DEFAULTS.label.height, 10, 200),
      marginMm: bounded(label.marginMm, LEGACY_DESIGNER_DEFAULTS.label.marginMm, 0, 6),
      border: boolOr(label.border, LEGACY_DESIGNER_DEFAULTS.label.border),
    },
    logo: {
      show: boolOr(logo.show, LEGACY_DESIGNER_DEFAULTS.logo.show),
      spaceMm: bounded(logo.spaceMm, LEGACY_DESIGNER_DEFAULTS.logo.spaceMm, 2, 20),
      scaleToFit: boolOr(logo.scaleToFit, LEGACY_DESIGNER_DEFAULTS.logo.scaleToFit),
      manualSizeMm: bounded(logo.manualSizeMm, LEGACY_DESIGNER_DEFAULTS.logo.manualSizeMm, 2, 20),
      align: choiceOr(logo.align, ['left', 'center', 'right'], LEGACY_DESIGNER_DEFAULTS.logo.align),
    },
    title: titleSettings(value.title, LEGACY_DESIGNER_DEFAULTS.title),
    title2: titleSettings(value.title2, LEGACY_DESIGNER_DEFAULTS.title2),
    qr: {
      show: boolOr(qr.show, rawQrMode === 'none' ? false : LEGACY_DESIGNER_DEFAULTS.qr.show),
      mode: qrMode,
      sizeMm: bounded(qr.sizeMm, LEGACY_DESIGNER_DEFAULTS.qr.sizeMm, 8, 40),
      position: choiceOr(qr.position, ['left', 'right'], LEGACY_DESIGNER_DEFAULTS.qr.position),
      vAlign: choiceOr(qr.vAlign, ['top', 'center', 'bottom'], LEGACY_DESIGNER_DEFAULTS.qr.vAlign),
      linkMode: choiceOr(qr.linkMode, ['spool', 'url'], LEGACY_DESIGNER_DEFAULTS.qr.linkMode),
      urlTemplate: stringOr(qr.urlTemplate, LEGACY_DESIGNER_DEFAULTS.qr.urlTemplate),
    },
    info: {
      ...infoSettings(info, LEGACY_DESIGNER_DEFAULTS.info),
      marginMm: bounded(info.marginMm, LEGACY_DESIGNER_DEFAULTS.info.marginMm, -1, 4),
    },
    info2: {
      ...infoSettings(info2, LEGACY_DESIGNER_DEFAULTS.info2),
      vsep: boolOr(info2.vsep, LEGACY_DESIGNER_DEFAULTS.info2.vsep),
    },
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function migrateV1PresetData(
  rawData: unknown,
  _kind: LabelKind,
  createId: LabelElementIdFactory = createLabelElementId,
): LabelDesignerPresetData {
  const data = record(rawData)
  const source = 'settings' in data ? data.settings : rawData
  const legacy = normalizeLegacySettings(source)
  const margin = legacy.label.marginMm + (legacy.label.border ? 0.6 : 0)
  const contentW = Math.max(3, legacy.label.width - margin * 2)
  const elements: LabelDesignElement[] = []
  const id = () => createId()
  let cursorY = margin

  if (legacy.logo.show) {
    const h = Math.round(legacy.logo.spaceMm * 3.78) / (96 / 25.4)
    const w = contentW
    const x = margin
    elements.push({
      id: id(), type: 'manufacturerLogo', x, y: cursorY, w, h, z: elements.length,
      objectFit: 'contain', align: legacy.logo.align, collapseWhenEmpty: true,
      ...(!legacy.logo.scaleToFit ? { manualSizeMm: legacy.logo.manualSizeMm } : {}),
    })
    cursorY += h + 0.5
  }

  const addDivider = (legacyLogoDivider = false) => {
    // V1's 0.3mm CSS border occupies one layout pixel at 96 CSS px/in.
    const h = 25.4 / 96
    elements.push({
      id: id(), type: 'shape', x: margin, y: cursorY, w: contentW, h,
      z: elements.length, shape: 'rectangle', fill: '#000000', stroke: '',
      strokeWidthMm: 0, radiusMm: 0,
      ...(legacyLogoDivider ? { legacyLogoDivider: true } : {}),
    })
    cursorY += h
  }
  const addTitle = (title: LegacyTitleSettings) => {
    if (!title.show || !title.template.trim()) return
    if (title.dividerAbove) addDivider()
    const rowMargin = Math.max(-1, Math.min(4, title.marginMm))
    cursorY += rowMargin
    const h = Math.max(1, title.sizeMm)
    elements.push({
      id: id(), type: 'text', x: margin, y: cursorY, w: contentW, h,
      z: elements.length, template: title.template, fontFamily: 'Space Grotesk',
      fontSizeMm: title.sizeMm, fontWeight: 700, italic: false, underline: false,
      align: title.align, color: '#000000', wrap: false,
      fitToWidth: title.fitToWidth, legacyTextRole: 'title',
      legacyTitleMarginMm: rowMargin, legacyDividerBelow: title.dividerBelow,
    })
    cursorY += h + rowMargin
    if (title.dividerBelow) addDivider()
  }
  addTitle(legacy.title)
  addTitle(legacy.title2)
  if (legacy.logo.show && ![legacy.title, legacy.title2].some(title => title.show && title.template.trim())
    && legacy.title.dividerBelow) {
    cursorY += 0.5
    addDivider(true)
  }

  const remainingY = Math.min(legacy.label.height - margin - 3, cursorY + Math.max(-1, legacy.info.marginMm))
  const remainingH = Math.max(3, legacy.label.height - margin - remainingY)
  const hasInfo = legacy.info.show && !!legacy.info.template.trim()
  const hasInfo2 = legacy.info2.show
  const separator = hasInfo2 && legacy.info2.vsep
  const separatorWidth = 25.4 / 96
  const slots = [
    ...(hasInfo ? ['info'] : []),
    ...(separator ? ['separator'] : []),
    ...(hasInfo2 ? ['info2'] : []),
    ...(legacy.qr.show ? ['qr'] : []),
  ] as const
  const size = legacy.qr.sizeMm
  const infoCount = Number(hasInfo) + Number(hasInfo2)
  const infoWidth = infoCount
    ? Math.max(0, (contentW - (separator ? separatorWidth : 0) - (legacy.qr.show ? size : 0) - Math.max(0, slots.length - 1) * 1.5) / infoCount)
    : 0
  const slotWidth = (slot: typeof slots[number]) => slot === 'qr' ? size : slot === 'separator' ? separatorWidth : infoWidth
  const slotX: Record<string, number> = {}
  let slotCursor = legacy.qr.position === 'left' ? margin + contentW : margin
  for (const slot of slots) {
    const width = slotWidth(slot)
    if (legacy.qr.position === 'left') {
      slotCursor -= width
      slotX[slot] = slotCursor
      slotCursor -= 1.5
    } else {
      slotX[slot] = slotCursor
      slotCursor += width + 1.5
    }
  }
  if (legacy.qr.show) {
    const qrY = legacy.qr.vAlign === 'top'
      ? remainingY
      : legacy.qr.vAlign === 'center'
        ? remainingY + (remainingH - size) / 2
        : remainingY + remainingH - size
    elements.push({
      id: id(), type: 'qr', x: slotX.qr, y: qrY, w: size, h: size, z: elements.length,
      mode: legacy.qr.mode, linkMode: legacy.qr.linkMode, urlTemplate: legacy.qr.urlTemplate,
      legacyVAlign: legacy.qr.vAlign,
    })
  }

  const visibleInfo = [
    ...(hasInfo ? [{ section: legacy.info, slot: 'info' }] : []),
    ...(hasInfo2 ? [{ section: legacy.info2, slot: 'info2' }] : []),
  ]
  visibleInfo.forEach(({ section, slot }) => {
    elements.push({
      id: id(), type: 'text', x: slotX[slot], y: remainingY, w: infoWidth, h: remainingH,
      z: elements.length, template: section.template, fontFamily: 'Space Grotesk',
      fontSizeMm: section.sizeMm, fontWeight: 400, italic: false, underline: false,
      align: section.hAlign, verticalAlign: section.vAlign === 'center' ? 'middle' : section.vAlign,
      color: '#000000', wrap: true, legacyTextRole: 'info',
    })
  })
  if (separator) {
    elements.push({
      id: id(), type: 'shape', x: slotX.separator, y: remainingY, w: separatorWidth, h: remainingH,
      z: elements.length, shape: 'rectangle', fill: '#000000', stroke: '', strokeWidthMm: 0, radiusMm: 0,
    })
  }

  const design = normalizePresetDesign({
    version: 2,
    label: {
      widthMm: legacy.label.width,
      heightMm: legacy.label.height,
      marginMm: legacy.label.marginMm,
      border: legacy.label.border,
    },
    elements,
  }, { createId })
  return { version: 2, design, legacy_v1: clone(source) }
}

/** Upgrade persisted template syntax once at the preset/working-copy boundary. */
export function normalizePresetDesign(raw: unknown, options?: NormalizeLabelDesignOptions) {
  const design = normalizeLabelDesign(raw, options)
  for (const element of design.elements) {
    if (element.type !== 'text') continue
    const template = normalizeTemplateEmphasis(element.template)
    // Preserve legacy source if longer tags would exceed the editor's source limit.
    if (template.length <= 8000) element.template = template
  }
  return design
}

export function normalizeDesignerPresetData(
  rawData: unknown,
  kind: LabelKind,
  createId: LabelElementIdFactory = createLabelElementId,
): LabelDesignerPresetData {
  const data = record(rawData)
  if (data.version === 2 && record(data.design).version === 2) {
    const normalized: LabelDesignerPresetData = {
      version: 2,
      design: normalizePresetDesign(data.design, { createId }),
    }
    if ('legacy_v1' in data) normalized.legacy_v1 = clone(data.legacy_v1)
    return normalized
  }
  if (('version' in data && data.version !== 1) || 'design' in data) {
    throw new Error('Unsupported label preset version; the original preset has been preserved')
  }
  return migrateV1PresetData(rawData, kind, createId)
}
