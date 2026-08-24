import { toPng } from 'html-to-image'

export const LABEL_EXPORT_DPI = 600
export const LABEL_EXPORT_CSS_DPI = 96
// Label exports are intentionally rendered at print-grade 600 DPI.
export const LABEL_EXPORT_PIXEL_RATIO = LABEL_EXPORT_DPI / LABEL_EXPORT_CSS_DPI

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
  const previous = previews.map(preview => ({
    preview,
    borderColor: preview.style.borderColor,
    borderRadius: preview.style.borderRadius,
    boxShadow: preview.style.boxShadow,
  }))

  previews.forEach(preview => {
    preview.style.borderColor = 'transparent'
    preview.style.borderRadius = '0'
    preview.style.boxShadow = 'none'
  })

  return () => {
    previous.forEach(({ preview, borderColor, borderRadius, boxShadow }) => {
      preview.style.borderColor = borderColor
      preview.style.borderRadius = borderRadius
      preview.style.boxShadow = boxShadow
    })
  }
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

export async function captureLabelElement(element: HTMLElement, options: LabelCaptureOptions = {}) {
  const previousZoom = element.style.zoom
  const previousTransform = element.style.transform
  const previousTransformOrigin = element.style.transformOrigin
  const restorePreviewChrome = hidePreviewChromeForCapture(element)

  if (options.resetZoom) {
    element.style.zoom = '1'
  }
  if (options.resetTransform) {
    element.style.transform = 'none'
    element.style.transformOrigin = 'unset'
  }

  try {
    if (document.fonts?.ready) {
      await document.fonts.ready
    }
    await waitForCaptureFrame()

    return await withCaptureTimerFrames(() => toPng(element, {
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
  } finally {
    restorePreviewChrome()
    if (options.resetZoom) {
      element.style.zoom = previousZoom
    }
    if (options.resetTransform) {
      element.style.transform = previousTransform
      element.style.transformOrigin = previousTransformOrigin
    }
  }
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
