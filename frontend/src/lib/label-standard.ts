/* eslint-disable @typescript-eslint/no-explicit-any */
import { canvasToQrImage, ensureQrCodeLoaded, getQrCodeConstructor } from './qr-code'
import { LABEL_EXPORT_DPI } from './label-export'
import { updateLabelPrintPageStyle } from './label-print-style'
import {
  buildFilamentSwatchBackground,
  getFilamentSwatchColors,
} from './label-template'

const MM_PER_INCH = 25.4
const MIN_QR_PIXEL_SIZE = 256

function getPrintQrPixelSize(sizeMm: number) {
  return Math.max(MIN_QR_PIXEL_SIZE, Math.round(sizeMm * (LABEL_EXPORT_DPI / MM_PER_INCH)))
}

export interface StandardExtraField {
  label: string
  value: string
}

export interface StandardLabelData {
  id: string | number
  designation: string
  manufacturer: string
  material: string
  colorName: string
  hexCode: string
  colorHexes: string
  multiColorStyle: string
  extraFields: StandardExtraField[]
  /** Override the QR code URL. Defaults to /spools/{id} if omitted. */
  qrUrl?: string
}

export interface StandardLabelSettings {
  widthMm: number
  heightMm: number
  fontScale: number
  qrSizeMm: number
  showLogo: boolean
  showQR: boolean
  showID: boolean
  showManufacturer: boolean
  showMaterial: boolean
  showColor: boolean
  showColorSwatch: boolean
  showColorHex: boolean
  zoom?: number | null
}

export interface RenderStandardLabelOptions {
  element: HTMLElement
  data: StandardLabelData
  settings: StandardLabelSettings
  logoUrl?: string | null
  isStale?: () => boolean
  updatePageStyle?: boolean
  pageStyleId?: string
}

function toStringValue(value: unknown) {
  return value === undefined || value === null ? '' : String(value)
}

function cleanHex(value: unknown) {
  return toStringValue(value).replace(/^#/, '').trim()
}

function setHidden(element: HTMLElement, hidden: boolean) {
  element.style.display = hidden ? 'none' : ''
}

function requiredElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`Standard label layout is missing ${selector}`)
  return element
}

export function getStandardLabelDimensions(settings: StandardLabelSettings) {
  return {
    widthMm: settings.widthMm,
    heightMm: settings.heightMm,
  }
}

export function buildStandardLabelHtml() {
  return `
    <div class="label-id-corner"></div>
    <div class="label-top"><img class="label-logo" alt=""/><div class="label-mfr-text"></div></div>
    <div class="label-divider"></div>
    <div class="label-middle">
      <div class="label-middle-left">
        <div class="label-designation"></div>
        <div class="label-color-row"><div class="label-color-swatch"></div><span class="label-color-name"></span></div>
      </div>
      <div class="label-hex-code"></div>
    </div>
    <div class="label-bottom">
      <div class="label-bottom-left">
        <div class="label-extra-fields"></div>
      </div>
      <div class="label-qr"></div>
    </div>
  `
}

export function ensureStandardLabelLayout(container: HTMLElement) {
  if (
    container.querySelector('.label-id-corner') &&
    container.querySelector('.label-top') &&
    container.querySelector('.label-bottom')
  ) return
  container.innerHTML = buildStandardLabelHtml()
}

export function buildStandardLabelDataFromFlat(data: {
  id: unknown
  designation?: unknown
  manufacturer?: unknown
  material?: unknown
  colorName?: unknown
  hexCode?: unknown
  colorHexes?: unknown
  multiColorStyle?: unknown
  extraFields?: StandardExtraField[]
  qrUrl?: string
}): StandardLabelData {
  return {
    id: toStringValue(data.id),
    designation: toStringValue(data.designation),
    manufacturer: toStringValue(data.manufacturer),
    material: toStringValue(data.material),
    colorName: toStringValue(data.colorName),
    hexCode: cleanHex(data.hexCode),
    colorHexes: toStringValue(data.colorHexes),
    multiColorStyle: toStringValue(data.multiColorStyle),
    extraFields: data.extraFields ?? [],
    qrUrl: data.qrUrl,
  }
}

function getApiFilamentColors(filament: any): any[] {
  const list = Array.isArray(filament?.filament_colors)
    ? filament.filament_colors
    : filament?.colors
  return Array.isArray(list) ? list : []
}

function getFilamentColorHexes(filament: any): string {
  return getApiFilamentColors(filament)
    .map(color => color?.color?.hex_code)
    .filter(Boolean)
    .join(', ')
}

export function buildStandardLabelDataFromApiSpool(spool: any, extraFields: StandardExtraField[] = []): StandardLabelData {
  const filament = spool?.filament ?? {}
  const colorLists = [filament?.filament_colors, filament?.colors]
  const firstColor = colorLists.find(list => Array.isArray(list) && list.length > 0)?.[0] ?? {}
  return buildStandardLabelDataFromFlat({
    id: spool?.id ?? '',
    designation: filament.designation,
    manufacturer: filament.manufacturer?.name,
    material: filament.material_type,
    colorName: firstColor?.display_name_override || filament.manufacturer_color_name || firstColor?.color?.name,
    hexCode: firstColor?.color?.hex_code,
    colorHexes: getFilamentColorHexes(filament),
    multiColorStyle: filament.multi_color_style,
    extraFields,
  })
}

export function updateStandardLabelPageStyle(widthMm: number, heightMm: number, pageStyleId = 'page-style') {
  updateLabelPrintPageStyle({ widthMm, heightMm, styleId: pageStyleId })
}

export async function renderStandardLabel(options: RenderStandardLabelOptions) {
  if (options.isStale?.()) return

  const { element: container, data, settings } = options
  ensureStandardLabelLayout(container)

  const widthMm = settings.widthMm
  const heightMm = settings.heightMm
  const qrSizeMm = settings.qrSizeMm
  const fontScale = settings.fontScale

  container.style.width = `${widthMm}mm`
  container.style.height = `${heightMm}mm`
  container.style.setProperty('--print-label-padding', '2mm')
  container.style.setProperty('--inner-border-style', 'none')
  container.style.setProperty('--inner-border-inset', '2mm')
  if (settings.zoom !== undefined && settings.zoom !== null) {
    container.style.zoom = String(settings.zoom)
  }

  const topArea = requiredElement<HTMLElement>(container, '.label-top')
  const topDivider = requiredElement<HTMLElement>(container, '.label-divider')
  const logoImg = requiredElement<HTMLImageElement>(container, '.label-logo')
  const manufacturerText = requiredElement<HTMLElement>(container, '.label-mfr-text')

  if (settings.showLogo && options.logoUrl) {
    logoImg.src = options.logoUrl
    logoImg.style.cssText = `display:block;max-height:${fontScale * 5}mm`
    manufacturerText.style.display = 'none'
    topArea.style.display = 'flex'
    topDivider.style.display = 'block'
  } else if ((settings.showLogo || settings.showManufacturer) && data.manufacturer) {
    logoImg.removeAttribute('src')
    logoImg.style.display = 'none'
    manufacturerText.textContent = data.manufacturer
    manufacturerText.style.cssText = `display:block;font-size:${fontScale * 11}pt`
    topArea.style.display = 'flex'
    topDivider.style.display = 'block'
  } else {
    logoImg.removeAttribute('src')
    logoImg.style.display = 'none'
    manufacturerText.style.display = 'none'
    topArea.style.display = 'none'
    topDivider.style.display = 'none'
  }

  const designationElement = requiredElement<HTMLElement>(container, '.label-designation')
  const fullDesignation = [data.designation, settings.showMaterial ? data.material : ''].filter(Boolean).join(' ')
  designationElement.textContent = fullDesignation
  designationElement.style.cssText = `font-size:${fontScale * 12}pt;display:${fullDesignation ? 'block' : 'none'}`

  const colorRow = requiredElement<HTMLElement>(container, '.label-color-row')
  const colorSwatch = requiredElement<HTMLElement>(container, '.label-color-swatch')
  const colorName = requiredElement<HTMLElement>(container, '.label-color-name')
  const hexElement = requiredElement<HTMLElement>(container, '.label-hex-code')
  const hex = cleanHex(data.hexCode)
  const swatchColors = getFilamentSwatchColors(data.colorHexes, hex)
  const swatchBackground = buildFilamentSwatchBackground(swatchColors, data.multiColorStyle)

  colorSwatch.style.display = settings.showColorSwatch && swatchBackground ? 'block' : 'none'
  colorSwatch.style.background = ''
  if (settings.showColorSwatch && swatchBackground) {
    colorSwatch.style.background = swatchBackground
  }

  colorName.style.display = settings.showColor && data.colorName ? 'inline' : 'none'
  if (settings.showColor && data.colorName) {
    colorName.textContent = data.colorName
    colorName.style.fontSize = `${fontScale * 10}pt`
  }

  colorRow.style.display = (
    (settings.showColor && data.colorName) ||
    (settings.showColorSwatch && swatchBackground) ||
    (settings.showColorHex && hex)
  ) ? 'flex' : 'none'

  if (settings.showColorHex && hex) {
    hexElement.textContent = `#${hex.toUpperCase()}`
    hexElement.style.cssText = `display:block;font-size:${fontScale * 9}pt`
  } else {
    hexElement.style.display = 'none'
  }

  const idElement = requiredElement<HTMLElement>(container, '.label-id-corner')
  setHidden(idElement, !settings.showID)
  if (settings.showID) {
    idElement.textContent = `# ${data.id}`
    idElement.style.fontSize = `${fontScale * 7}pt`
  }

  const extraFieldsElement = requiredElement<HTMLElement>(container, '.label-extra-fields')
  extraFieldsElement.innerHTML = ''
  for (const extraField of data.extraFields) {
    const div = document.createElement('div')
    div.style.cssText = `font-size:${fontScale * 7}pt;color:black;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3`
    const labelSpan = document.createElement('span')
    labelSpan.style.cssText = 'color:#555;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
    labelSpan.textContent = `${extraField.label}:`
    div.appendChild(labelSpan)
    div.appendChild(document.createTextNode(` ${extraField.value}`))
    extraFieldsElement.appendChild(div)
  }

  const qrElement = requiredElement<HTMLElement>(container, '.label-qr')
  setHidden(qrElement, !settings.showQR)
  if (settings.showQR) {
    await ensureQrCodeLoaded()
    if (options.isStale?.()) return
    qrElement.innerHTML = ''
    const url = data.qrUrl ?? `${window.location.origin}/spools/${encodeURIComponent(String(data.id))}`
    const QRCode = getQrCodeConstructor()
    if (!QRCode) throw new Error('QRCode is not available')
    new QRCode(qrElement, {
      text: url,
      width: getPrintQrPixelSize(qrSizeMm),
      height: getPrintQrPixelSize(qrSizeMm),
      colorDark: '#000',
      colorLight: '#fff',
      correctLevel: QRCode.CorrectLevel.H,
    })
    qrElement.style.width = `${qrSizeMm}mm`
    qrElement.style.height = `${qrSizeMm}mm`
    const canvas = qrElement.querySelector('canvas') as HTMLCanvasElement | null
    if (canvas) {
      qrElement.innerHTML = ''
      qrElement.appendChild(canvasToQrImage(canvas))
    }
  }

  if (options.updatePageStyle !== false) {
    updateStandardLabelPageStyle(widthMm, heightMm, options.pageStyleId)
  }
}
