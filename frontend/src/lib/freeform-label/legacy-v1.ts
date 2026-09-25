/**
 * Frozen compatibility contract for FilaMan label designer schema v1.
 *
 * Keep this bridge for at least three months after the release that introduces
 * schema v2. Do not set a removal date until that release date is known.
 * New editor code must not add dependencies on this module.
 */

export interface LegacyLabelDesignerSettings {
  logo: {
    show: boolean
    spaceMm: number
    scaleToFit: boolean
    manualSizeMm: number
    align: 'left' | 'center' | 'right'
  }
  label: { width: number; height: number; marginMm: number; border: boolean }
  title: LegacyTitleSettings
  title2: LegacyTitleSettings
  qr: {
    show: boolean
    mode: 'simple' | 'logo' | 'colorLogo'
    sizeMm: number
    position: 'left' | 'right'
    vAlign: 'top' | 'center' | 'bottom'
    linkMode: 'spool' | 'url'
    urlTemplate: string
  }
  info: LegacyInfoSettings & { marginMm: number }
  info2: LegacyInfoSettings & { vsep: boolean }
}

export interface LegacyTitleSettings {
  show: boolean
  sizeMm: number
  marginMm: number
  fitToWidth: boolean
  align: 'left' | 'center' | 'right'
  template: string
  dividerAbove: boolean
  dividerBelow: boolean
}

export interface LegacyInfoSettings {
  show: boolean
  sizeMm: number
  hAlign: 'left' | 'center' | 'right'
  vAlign: 'top' | 'center' | 'bottom'
  template: string
}

export const LEGACY_DESIGNER_DEFAULTS: LegacyLabelDesignerSettings = {
  logo: { show: true, spaceMm: 6, scaleToFit: true, manualSizeMm: 6, align: 'left' },
  label: { width: 60, height: 40, marginMm: 1, border: false },
  title: { show: true, sizeMm: 4, marginMm: 0, fitToWidth: true, align: 'left', template: '{filament.name}', dividerAbove: false, dividerBelow: true },
  title2: { show: false, sizeMm: 3.5, marginMm: 0, fitToWidth: true, align: 'left', template: '', dividerAbove: false, dividerBelow: false },
  qr: { show: true, mode: 'logo', sizeMm: 18, position: 'right', vAlign: 'bottom', linkMode: 'spool', urlTemplate: '' },
  info: { show: true, sizeMm: 2.5, marginMm: 0, hAlign: 'left', vAlign: 'bottom', template: '{filament.type}\n{filament.color}\nDiameter: {filament.diameter} mm' },
  info2: { show: false, vsep: false, sizeMm: 2.5, hAlign: 'left', vAlign: 'bottom', template: '' },
}
