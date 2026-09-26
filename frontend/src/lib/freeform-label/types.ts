export const LABEL_DESIGN_VERSION = 2 as const

export const LABEL_FONT_FAMILIES = [
  'Space Grotesk',
  'Roboto Condensed',
  'Fraunces',
  'Space Mono',
] as const

export const LABEL_FONT_WEIGHTS = [400, 500, 600, 700] as const
export const LABEL_SHAPES = ['circle', 'square', 'rectangle', 'line'] as const
export type LabelShape = typeof LABEL_SHAPES[number]

export type LabelKind = 'spool' | 'filament'
export type LabelElementType =
  | 'text'
  | 'qr'
  | 'manufacturerLogo'
  | 'image'
  | 'swatch'
  | 'shape'
export type LabelFontFamily = typeof LABEL_FONT_FAMILIES[number]
export type LabelFontWeight = typeof LABEL_FONT_WEIGHTS[number]

export interface LabelElementBase {
  id: string
  type: LabelElementType
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface LabelTextElement extends LabelElementBase {
  type: 'text'
  template: string
  fontFamily: LabelFontFamily
  fontSizeMm: number
  fontWeight: LabelFontWeight
  italic: boolean
  underline: boolean
  align: 'left' | 'center' | 'right'
  /** Missing values preserve the original top-aligned layout. */
  verticalAlign?: 'top' | 'middle' | 'bottom'
  color: string
  wrap: boolean
  /** Shrink to fit; wrapping may add a second line but not extra lines beyond explicit breaks. */
  fitToWidth?: boolean
  minFontSizeMm?: number
  legacyTextRole?: 'title' | 'info'
  legacyTitleMarginMm?: number
  legacyDividerBelow?: boolean
}

export interface LabelQrElement extends LabelElementBase {
  type: 'qr'
  mode: 'simple' | 'logo' | 'colorLogo'
  linkMode: 'spool' | 'url'
  urlTemplate: string
  legacyVAlign?: 'top' | 'center' | 'bottom'
}

export interface LabelManufacturerLogoElement extends LabelElementBase {
  type: 'manufacturerLogo'
  objectFit: 'contain'
  align?: 'left' | 'center' | 'right'
  manualSizeMm?: number
  /** V1 only reserved this row when the spool had a logo. */
  collapseWhenEmpty?: boolean
}

export interface LabelImageCrop {
  x: number
  y: number
  w: number
  h: number
}

export interface LabelImageElement extends LabelElementBase {
  type: 'image'
  assetId: string
  objectFit: 'contain'
  crop?: LabelImageCrop
}

export interface LabelSwatchElement extends LabelElementBase {
  type: 'swatch'
  radiusMm: number
}

export interface LabelShapeElement extends LabelElementBase {
  type: 'shape'
  legacyLogoDivider?: boolean
  shape: LabelShape
  fill: string
  stroke: string
  strokeWidthMm: number
  radiusMm: number
}

export type LabelDesignElement =
  | LabelTextElement
  | LabelQrElement
  | LabelManufacturerLogoElement
  | LabelImageElement
  | LabelSwatchElement
  | LabelShapeElement

export interface LabelDesignV2 {
  version: typeof LABEL_DESIGN_VERSION
  label: {
    widthMm: number
    heightMm: number
    marginMm: number
    border: boolean
  }
  elements: LabelDesignElement[]
}

export interface LabelDesignerPresetData {
  version: typeof LABEL_DESIGN_VERSION
  design: LabelDesignV2
  legacy_v1?: unknown
}

export type LabelElementIdFactory = () => string
