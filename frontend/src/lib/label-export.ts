import { toCanvas } from 'html-to-image'
import { stripElementIds } from './label-preview-dom'

export const LABEL_EXPORT_DPI = 600
export const LABEL_EXPORT_CSS_DPI = 96
// Label exports are intentionally rendered at print-grade 600 DPI.
export const LABEL_EXPORT_PIXEL_RATIO = LABEL_EXPORT_DPI / LABEL_EXPORT_CSS_DPI
const LABEL_CAPTURE_ATTEMPTS = 2
const LABEL_CAPTURE_VISIBLE_PIXEL_THRESHOLD = 250
const LABEL_CAPTURE_MIN_VISIBLE_PIXELS = 16
const LABEL_CAPTURE_MIN_VISIBLE_RATIO = 0.0001
const LABEL_CAPTURE_SCAN_ROWS = 64

export interface LabelCaptureOptions {
  pixelRatio?: number
  resetZoom?: boolean
  resetTransform?: boolean
}

export interface LabelPdfPage {
  dataUrl: string
  widthMm: number
  heightMm: number
}

export interface LabelPdfDocument {
  save(filename: string): void
  output(type: 'blob'): Blob
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a')
  link.download = filename
  link.href = dataUrl
  link.click()
}

function hidePreviewChromeForCapture(element: HTMLElement) {
  const previews = [
    ...(element.classList.contains('label-preview') ? [element] : []),
    ...Array.from(element.querySelectorAll<HTMLElement>('.label-preview')),
  ]

  previews.forEach(preview => {
    preview.style.borderColor = 'transparent'
    preview.style.borderRadius = '0'
    preview.style.boxShadow = 'none'
  })
}

function createOffscreenCaptureClone(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement
  stripElementIds(clone)
  const captureHost = document.createElement('div')
  captureHost.setAttribute('aria-hidden', 'true')
  captureHost.style.position = 'fixed'
  captureHost.style.left = '-100000px'
  captureHost.style.top = '0'
  captureHost.style.margin = '0'
  captureHost.style.pointerEvents = 'none'
  const captureParent = element.parentElement ?? document.body
  captureHost.appendChild(clone)
  captureParent.appendChild(captureHost)
  return clone
}

function waitForCaptureFrame() {
  return new Promise<void>(resolve => {
    const timeout = window.setTimeout(resolve, 250)

    window.requestAnimationFrame(() => {
      window.clearTimeout(timeout)
      resolve()
    })
  })
}

async function withCaptureTimerFrames<T>(capture: () => Promise<T>) {
  const requestAnimationFrame = globalThis.requestAnimationFrame
  const cancelAnimationFrame = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => window.setTimeout(
    () => callback(performance.now()),
    0,
  )
  globalThis.cancelAnimationFrame = frame => window.clearTimeout(frame)

  try {
    return await capture()
  } finally {
    globalThis.requestAnimationFrame = requestAnimationFrame
    globalThis.cancelAnimationFrame = cancelAnimationFrame
  }
}

function canvasHasVisibleContent(canvas: HTMLCanvasElement) {
  if (canvas.width <= 0 || canvas.height <= 0) return false

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Cannot validate label capture: canvas context is unavailable')
  const requiredVisiblePixels = Math.max(
    LABEL_CAPTURE_MIN_VISIBLE_PIXELS,
    Math.ceil(canvas.width * canvas.height * LABEL_CAPTURE_MIN_VISIBLE_RATIO),
  )
  let visiblePixels = 0

  for (let y = 0; y < canvas.height; y += LABEL_CAPTURE_SCAN_ROWS) {
    const height = Math.min(LABEL_CAPTURE_SCAN_ROWS, canvas.height - y)
    const pixels = context.getImageData(0, y, canvas.width, height).data
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index] < LABEL_CAPTURE_VISIBLE_PIXEL_THRESHOLD ||
        pixels[index + 1] < LABEL_CAPTURE_VISIBLE_PIXEL_THRESHOLD ||
        pixels[index + 2] < LABEL_CAPTURE_VISIBLE_PIXEL_THRESHOLD
      ) {
        visiblePixels += 1
        if (visiblePixels >= requiredVisiblePixels) return true
      }
    }
  }

  return false
}

async function renderCaptureCanvas(
  captureElement: HTMLElement,
  options: LabelCaptureOptions,
) {
  return withCaptureTimerFrames(() => toCanvas(captureElement, {
    pixelRatio: options.pixelRatio ?? LABEL_EXPORT_PIXEL_RATIO,
    backgroundColor: '#ffffff',
    // Manufacturer logos can be object URLs; cache-busting would make blob: URLs invalid.
    cacheBust: false,
    skipFonts: true,
    filter: (node: Node) => {
      if (node instanceof Element && window.getComputedStyle(node).display === 'none') {
        return false
      }

      if (node instanceof HTMLImageElement && node.classList.contains('label-logo')) {
        const src = node.getAttribute('src')?.trim() ?? ''
        return !!src && (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/'))
      }

      return true
    },
  }))
}

export async function captureLabelElement(element: HTMLElement, options: LabelCaptureOptions = {}) {
  for (let attempt = 1; attempt <= LABEL_CAPTURE_ATTEMPTS; attempt += 1) {
    const captureElement = createOffscreenCaptureClone(element)
    hidePreviewChromeForCapture(captureElement)

    if (options.resetZoom) {
      captureElement.style.zoom = '1'
    }
    if (options.resetTransform) {
      captureElement.style.transform = 'none'
      captureElement.style.transformOrigin = 'unset'
    }

    try {
      if (document.fonts?.ready) {
        await document.fonts.ready
      }
      await waitForCaptureFrame()

      const canvas = await renderCaptureCanvas(captureElement, options)
      if (canvasHasVisibleContent(canvas)) {
        return canvas.toDataURL('image/png')
      }
    } finally {
      captureElement.parentElement?.remove()
    }

    if (attempt < LABEL_CAPTURE_ATTEMPTS) {
      await waitForCaptureFrame()
    }
  }

  throw new Error('Cannot capture label: renderer returned a blank image twice')
}

export async function createLabelPagesPdf(
  pages: LabelPdfPage[],
): Promise<LabelPdfDocument | null> {
  if (pages.length === 0) return null

  const { jsPDF } = await import('jspdf')
  const first = pages[0]
  const firstOrientation = first.widthMm > first.heightMm ? 'l' : 'p'
  const pdf = new jsPDF({ orientation: firstOrientation, unit: 'mm', format: [first.widthMm, first.heightMm] })
  const imageAliases = new Map<string, string>()

  pages.forEach((page, index) => {
    const orientation = page.widthMm > page.heightMm ? 'l' : 'p'
    if (index > 0) {
      pdf.addPage([page.widthMm, page.heightMm], orientation)
    }
    const alias = imageAliases.get(page.dataUrl) ?? `label-page-${imageAliases.size}`
    imageAliases.set(page.dataUrl, alias)
    pdf.addImage(page.dataUrl, 'PNG', 0, 0, page.widthMm, page.heightMm, alias, 'FAST')
  })

  return pdf
}
