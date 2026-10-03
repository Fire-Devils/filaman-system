import {
  buildFilamentSwatchBackground,
  getFilamentColorTheme,
  getFilamentSwatchColors,
  parseTemplate,
  renderSelectableTemplate,
  type SpoolData,
} from '../label-template'
import { canvasToQrImage, decorateQrCenter, ensureQrCodeLoaded, getQrCodeConstructor } from '../qr-code'
import { normalizeLabelDesign } from './normalize'
import { prepareCroppedImage } from './cropped-image'
import { getQrModuleCount } from './qr-readability'
import { fitLabelText, type TextFitTarget } from './text-fit'
import { t } from '../i18n'
import type { LabelDesignElement, LabelDesignV2 } from './types'

export interface RenderFreeformLabelOptions {
  element: HTMLElement
  design: LabelDesignV2
  data: SpoolData
  logoUrl?: string | null
  resolveAssetUrl?: (assetId: string) => string | null | Promise<string | null>
  previewBorder?: boolean
  interactive?: boolean
  isStale?: () => boolean
  entityPath?: 'spools' | 'filaments'
}

function applyGeometry(node: HTMLElement, element: LabelDesignElement) {
  node.dataset.labelElementId = element.id
  node.dataset.labelElementType = element.type
  node.style.position = 'absolute'
  node.style.left = `${element.x}mm`
  node.style.top = `${element.y}mm`
  node.style.width = `${element.w}mm`
  node.style.height = `${element.h}mm`
  node.style.zIndex = String(element.z)
  node.style.boxSizing = 'border-box'
  node.style.overflow = 'hidden'
}

function createImage(src: string, alt: string) {
  const image = document.createElement('img')
  image.src = src
  image.alt = alt
  image.draggable = false
  image.style.display = 'block'
  image.style.width = '100%'
  image.style.height = '100%'
  image.style.objectFit = 'contain'
  return image
}

function appendCroppedImage(
  container: HTMLElement,
  image: HTMLImageElement,
  element: Extract<LabelDesignElement, { type: 'image' }>,
) {
  if (!element.crop) {
    container.appendChild(image)
    return
  }
  const { x, y, w, h } = element.crop
  container.style.containerType = 'size'
  const viewport = document.createElement('div')
  viewport.dataset.labelImageCropViewport = ''
  viewport.style.width = 'min(100cqw, calc(100cqh * var(--label-image-crop-aspect)))'
  viewport.style.position = 'absolute'
  viewport.style.left = '50%'
  viewport.style.top = '50%'
  viewport.style.transform = 'translate(-50%, -50%)'
  viewport.style.overflow = 'hidden'
  viewport.style.visibility = 'hidden'
  image.style.position = 'absolute'
  image.style.maxWidth = 'none'
  image.style.maxHeight = 'none'
  image.style.width = `${100 / w}%`
  image.style.height = `${100 / h}%`
  image.style.left = `${-100 * x / w}%`
  image.style.top = `${-100 * y / h}%`
  image.dataset.labelImageCropAspectFactor = String(w / h)
  viewport.appendChild(image)
  prepareCroppedImage(image)
  container.appendChild(viewport)
}

function showImagePlaceholder(node: HTMLElement, assetId: string) {
  const message = t(assetId ? 'labelDesigner.imageLoadFailed' : 'labelDesigner.chooseImage')
  const color = assetId ? '#b91c1c' : '#64748b'
  node.dataset.labelOutputError = `${message} (${assetId || node.dataset.labelElementId})`
  node.textContent = message
  node.style.color = color
  node.style.border = `0.2mm dashed ${color}`
  node.style.fontSize = '2.5mm'
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', node.dataset.labelOutputError)
}

function buildQrUrl(
  linkMode: 'spool' | 'url',
  templateBase: string,
  entityId: string | number,
  entityPath: 'spools' | 'filaments',
) {
  if (linkMode === 'url' && templateBase.trim()) {
    try {
      const url = new URL(templateBase.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}/${entityPath}/${encodeURIComponent(String(entityId))}`
    } catch {
      // Use the current FilaMan origin below.
    }
  }
  return `${window.location.origin}/${entityPath}/${encodeURIComponent(String(entityId))}`
}

function renderText(node: HTMLElement, element: Extract<LabelDesignElement, { type: 'text' }>, data: SpoolData, interactive = false) {
  node.style.fontFamily = `"${element.fontFamily}", sans-serif`
  node.style.fontSize = `${element.fontSizeMm}mm`
  node.style.fontWeight = String(element.fontWeight)
  node.style.fontStyle = element.italic ? 'italic' : 'normal'
  node.style.textDecoration = element.underline ? 'underline' : 'none'
  node.style.textAlign = element.align
  node.style.color = element.color
  node.style.lineHeight = '1.15'
  node.style.whiteSpace = element.wrap ? 'normal' : 'nowrap'
  node.style.textWrap = element.wrap ? 'balance' : 'nowrap'
  node.style.overflowWrap = element.wrap ? 'anywhere' : 'normal'
  if (element.legacyTextRole) {
    node.style.lineHeight = element.legacyTextRole === 'title' ? '1' : '1.4'
    node.style.textWrap = element.wrap ? 'wrap' : 'nowrap'
    node.style.overflowWrap = 'normal'
    if (element.legacyTextRole === 'title' && !element.fitToWidth) node.style.textOverflow = 'ellipsis'
  }
  node.style.display = 'flex'
  node.style.flexDirection = 'column'
  node.style.justifyContent = element.verticalAlign === 'middle' ? 'center' : element.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start'
  const content = document.createElement('div')
  content.style.width = '100%'
  content.style.flexShrink = '0'
  content.appendChild((interactive ? renderSelectableTemplate : parseTemplate)(element.template, data))
  if (element.legacyTextRole === 'title') {
    content.style.overflow = 'hidden'
    content.style.textOverflow = element.fitToWidth ? 'clip' : 'ellipsis'
    const template = element.template.trim()
    const inverse = /^==([\s\S]*?)==$/.test(template)
    const colorInverse = /^@@([\s\S]*?)@@$/.test(template)
    if (inverse || colorInverse) {
      const theme = colorInverse ? getFilamentColorTheme(data) : { background: '#000', foreground: '#fff' }
      content.style.boxSizing = 'border-box'
      content.style.padding = '0 0.6mm'
      content.style.background = theme.background
      content.style.color = theme.foreground
      const inlineInverse = content.firstElementChild as HTMLElement | null
      if (inlineInverse) inlineInverse.removeAttribute('style')
    }
  }
  node.appendChild(content)
}

async function renderQr(
  node: HTMLElement,
  element: Extract<LabelDesignElement, { type: 'qr' }>,
  data: SpoolData,
  entityPath: 'spools' | 'filaments',
) {
  const QRCode = getQrCodeConstructor()
  if (!QRCode) throw new Error('QRCode is not available')
  const entityId = entityPath === 'filaments' ? data['filament.id'] : data.id
  const qrPx = Math.min(1024, Math.max(256, Math.round(element.w * (600 / 25.4))))
  const qrCode = new QRCode(node, {
    text: buildQrUrl(element.linkMode, element.urlTemplate, entityId, entityPath),
    width: qrPx,
    height: qrPx,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H,
  })
  const moduleCount = getQrModuleCount(qrCode)
  if (moduleCount !== undefined) node.dataset.qrModuleCount = String(moduleCount)
  const canvas = node.querySelector<HTMLCanvasElement>('canvas')
  if (canvas && element.mode !== 'simple') {
    await decorateQrCenter(canvas, qrPx, element.mode === 'colorLogo')
  }
  if (canvas) {
    node.replaceChildren(canvasToQrImage(canvas, element.mode === 'simple'))
  }
  for (const child of node.querySelectorAll<HTMLElement>('canvas, img')) {
    child.style.width = '100%'
    child.style.height = '100%'
    child.style.display = 'block'
  }
}

function applyRootStyles(root: HTMLElement, design: LabelDesignV2, options: RenderFreeformLabelOptions) {
  root.style.width = `${design.label.widthMm}mm`
  root.style.height = `${design.label.heightMm}mm`
  root.style.padding = '0'
  root.style.position = 'relative'
  root.style.boxSizing = 'border-box'
  root.style.overflow = options.interactive ? 'visible' : 'hidden'
  root.style.background = '#ffffff'
  root.style.border = options.previewBorder === false ? 'none' : '1px dashed #ccc'
  root.style.setProperty('--print-label-padding', '0mm')
  root.style.setProperty('--inner-border-style', design.label.border ? '0.3mm solid black' : 'none')
  root.style.setProperty('--inner-border-inset', `${design.label.marginMm}mm`)
  root.toggleAttribute('data-label-interactive', options.interactive === true)
}

function createMarginGuide(design: LabelDesignV2) {
  const guide = document.createElement('div')
  guide.dataset.labelEditorChrome = ''
  guide.dataset.labelMarginGuide = ''
  guide.setAttribute('aria-hidden', 'true')
  Object.assign(guide.style, {
    position: 'absolute',
    inset: `${design.label.marginMm}mm`,
    pointerEvents: 'none',
    border: '1px dashed rgba(150, 150, 150, 0.7)',
    boxShadow: '0 0 0 100vmax rgba(128, 128, 128, 0.25)',
    zIndex: String(Math.max(0, ...design.elements.map(element => element.z)) + 1),
  })
  return guide
}

export async function renderFreeformLabel(options: RenderFreeformLabelOptions) {
  const design = normalizeLabelDesign(options.design)
  const emptyLegacyLogo = !options.logoUrl
    ? design.elements.find(element => element.type === 'manufacturerLogo' && element.collapseWhenEmpty)
    : undefined
  const logoDivider = emptyLegacyLogo
    ? design.elements.find(element => element.type === 'shape' && element.legacyLogoDivider)
    : undefined
  const collapsedHeight = emptyLegacyLogo
    ? emptyLegacyLogo.h + 0.5 + (logoDivider ? 0.5 + logoDivider.h : 0)
    : 0
  const hasQr = design.elements.some(element => element.type === 'qr')
  if (hasQr) await ensureQrCodeLoaded()
  if (options.isStale?.()) return

  const nodes: HTMLElement[] = []
  const fittingText: TextFitTarget[] = []
  for (const element of design.elements) {
    if (options.isStale?.()) return
    const node = document.createElement('div')
    applyGeometry(node, element)
    if (emptyLegacyLogo && (element === emptyLegacyLogo || element === logoDivider)) node.style.display = 'none'
    else if (emptyLegacyLogo && element.y > emptyLegacyLogo.y) {
      const factor = element.type === 'qr' && element.legacyVAlign === 'bottom' ? 0
        : element.type === 'qr' && element.legacyVAlign === 'center' ? 0.5 : 1
      node.style.top = `${element.y - collapsedHeight * factor}mm`
      if (element.type === 'text' && element.legacyTextRole === 'info'
        || element.type === 'shape' && element.h > element.w) {
        node.style.height = `${element.h + collapsedHeight}mm`
      }
    }
    switch (element.type) {
      case 'text':
        renderText(node, element, options.data, options.interactive)
        if (element.fitToWidth || element.legacyTextRole === 'title' && !element.wrap) fittingText.push({
          node,
          minimumMm: element.minFontSizeMm ?? (element.wrap ? 2 : 0.265),
          maxLines: element.wrap ? Math.max(2, element.template.split(/\r\n|\r|\n/).length) : 1,
          legacyTitle: element.legacyTextRole === 'title' && !element.wrap,
          fitToWidth: element.fitToWidth === true,
        })
        break
      case 'qr':
        await renderQr(node, element, options.data, options.entityPath ?? 'spools')
        break
      case 'manufacturerLogo':
        if (options.logoUrl) {
          const image = createImage(options.logoUrl, '')
          if (element.align) {
            node.style.display = 'flex'
            node.style.alignItems = 'center'
            node.style.justifyContent = element.align === 'right' ? 'flex-end' : element.align === 'center' ? 'center' : 'flex-start'
            image.style.objectPosition = `${element.align} center`
            if (element.manualSizeMm) {
              image.style.width = 'auto'
              image.style.height = element.collapseWhenEmpty
                ? `${Math.round(element.manualSizeMm * 3.78)}px` : `${Math.min(element.h, element.manualSizeMm)}mm`
              image.style.maxWidth = '100%'
              image.style.maxHeight = '100%'
            }
          }
          node.appendChild(image)
        }
        break
      case 'image': {
        const assetId = element.assetId.trim()
        let src: string | null | undefined
        try {
          src = assetId ? await options.resolveAssetUrl?.(assetId) : null
        } catch {
          src = null
        }
        if (options.isStale?.()) return
        if (src) {
          const image = createImage(src, '')
          image.addEventListener('error', () => showImagePlaceholder(node, assetId), { once: true })
          appendCroppedImage(node, image, element)
        } else {
          showImagePlaceholder(node, assetId)
        }
        break
      }
      case 'swatch': {
        const colors = getFilamentSwatchColors(
          options.data['filament.color_hexes'],
          options.data['filament.color_hex'],
        )
        node.style.background = buildFilamentSwatchBackground(
          colors,
          options.data['filament.multi_color_style'],
        ) || '#9aa0a6'
        node.style.border = '0.12mm solid rgba(0, 0, 0, 0.35)'
        node.style.borderRadius = `${element.radiusMm}mm`
        break
      }
      case 'shape':
        if (element.shape === 'line') {
          node.style.overflow = 'visible'
          const line = document.createElement('div')
          line.style.position = 'absolute'
          line.style.top = '50%'
          line.style.transform = 'translateY(-50%)'
          line.style.width = '100%'
          line.style.borderTop = element.stroke && element.strokeWidthMm > 0
            ? `${element.strokeWidthMm}mm solid ${element.stroke}`
            : 'none'
          node.appendChild(line)
          break
        }
        node.style.backgroundColor = element.fill || 'transparent'
        node.style.border = element.stroke && element.strokeWidthMm > 0
          ? `${element.strokeWidthMm}mm solid ${element.stroke}`
          : 'none'
        node.style.borderRadius = element.shape === 'circle' ? '50%' : `${element.radiusMm}mm`
        break
    }
    nodes.push(node)
  }
  await fitLabelText(fittingText)
  // V1 titles were flow rows: their resolved height moves every later row.
  design.elements.forEach((element, index) => {
    if (element.type !== 'text' || element.legacyTextRole !== 'title') return
    const hasSwatch = [...nodes[index].querySelectorAll<HTMLElement>('span')].some(span =>
      Number.parseFloat(span.style.width) > 0 && Number.parseFloat(span.style.height) > 0)
    const empty = !nodes[index].textContent?.trim() && !hasSwatch
    const resolvedHeight = Number.parseFloat(nodes[index].style.height)
    const belowIndex = element.legacyDividerBelow ? index + 1 : -1
    const below = belowIndex >= 0 ? design.elements[belowIndex] : undefined
    const shift = empty
      ? element.h + 2 * (element.legacyTitleMarginMm ?? 0) + (below?.type === 'shape' ? below.h : 0)
      : !element.wrap ? element.h - resolvedHeight : 0
    if (empty) {
      nodes[index].style.display = 'none'
      if (below?.type === 'shape') nodes[belowIndex].style.display = 'none'
    }
    if (!Number.isFinite(shift) || shift === 0) return
    design.elements.forEach((following, next) => {
      if (following.y <= element.y || next === index) return
      const factor = following.type === 'qr' && following.legacyVAlign === 'bottom' ? 0
        : following.type === 'qr' && following.legacyVAlign === 'center' ? 0.5 : 1
      nodes[next].style.top = `${Number.parseFloat(nodes[next].style.top) - shift * factor}mm`
      if (following.type === 'text' && following.legacyTextRole === 'info'
        || following.type === 'shape' && following.h > following.w) {
        nodes[next].style.height = `${Number.parseFloat(nodes[next].style.height) + shift}mm`
      }
    })
  })
  if (options.isStale?.()) return
  if (options.interactive) nodes.push(createMarginGuide(design))
  options.element.replaceChildren(...nodes)
  applyRootStyles(options.element, design, options)
}
