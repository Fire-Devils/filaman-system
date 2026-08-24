import {
  getLabelSheetLayout,
} from './label-sheet'
import type {
  LabelOutputMode,
  LabelSheetSettings,
} from './label-sheet'

const PRINT_HOST_ID = 'filaman-label-print-host'
const PRINT_STYLE_ID = 'filaman-label-print-style'
const PRINTING_CLASS = 'filaman-label-printing'
const PRINT_CLEANUP_DELAY_MS = 60_000
const FRAME_FALLBACK_DELAY_MS = 50

let cleanupTimer: ReturnType<typeof setTimeout> | undefined

export interface LabelBrowserPrintJob {
  kind: 'individual' | 'sheet'
  widthMm: number
  heightMm: number
  pages: HTMLElement[]
  printGrid: boolean
}

export interface LabelBrowserPrintSource {
  outputMode: LabelOutputMode
  previewRoot: HTMLElement
  individualPages: HTMLElement[]
  individualDimensions: { widthMm: number; heightMm: number }
  sheetSettings: LabelSheetSettings
}

function assertValidJob(job: LabelBrowserPrintJob) {
  if (job.kind !== 'individual' && job.kind !== 'sheet') {
    throw new Error('Unsupported label output mode')
  }
  if (
    !Number.isFinite(job.widthMm)
    || !Number.isFinite(job.heightMm)
    || job.widthMm <= 0
    || job.heightMm <= 0
  ) {
    throw new Error('Label print dimensions must be positive numbers')
  }
  if (
    job.pages.length === 0
    || job.pages.some(page => !(page instanceof HTMLElement))
  ) {
    throw new Error('Label print job requires at least one valid page')
  }
}

export function createLabelBrowserPrintJob(
  source: LabelBrowserPrintSource,
): LabelBrowserPrintJob {
  let job: LabelBrowserPrintJob
  if (source.outputMode === 'individual') {
    job = {
      kind: 'individual',
      widthMm: source.individualDimensions.widthMm,
      heightMm: source.individualDimensions.heightMm,
      pages: source.individualPages,
      printGrid: false,
    }
  } else if (source.outputMode === 'sheet') {
    const layout = getLabelSheetLayout(source.sheetSettings)
    job = {
      kind: 'sheet',
      widthMm: layout.paperWidthMm,
      heightMm: layout.paperHeightMm,
      pages: Array.from(
        source.previewRoot.querySelectorAll<HTMLElement>(
          '.label-sheet-page',
        ),
      ),
      printGrid: source.sheetSettings.printGrid,
    }
  } else {
    throw new Error('Unsupported label output mode')
  }
  assertValidJob(job)
  return job
}

function removeElementIds(root: HTMLElement) {
  root.removeAttribute('id')
  root.querySelectorAll('[id]').forEach(element => {
    element.removeAttribute('id')
  })
}

function resetPreviewSurface(element: HTMLElement) {
  element.style.zoom = '1'
  element.style.transform = 'none'
  element.style.transformOrigin = 'unset'
  element.style.boxShadow = 'none'
  element.style.border = 'none'
  element.style.borderRadius = '0'
}

function normalizePrintClone(
  clone: HTMLElement,
  kind: LabelBrowserPrintJob['kind'],
  printGrid: boolean,
) {
  clone.style.zoom = '1'
  clone.style.transform = 'none'
  clone.style.transformOrigin = 'unset'

  if (clone.classList.contains('label-wrapper')) {
    clone.style.removeProperty('width')
    clone.style.removeProperty('height')
    clone.style.removeProperty('flex')
    clone.style.removeProperty('overflow')
  }

  const previewSurfaces: HTMLElement[] = []
  if (clone.classList.contains('label-preview')) {
    previewSurfaces.push(clone)
  }
  previewSurfaces.push(...Array.from(clone.children).filter(
    (child): child is HTMLElement => (
      child instanceof HTMLElement
      && child.classList.contains('label-preview')
    ),
  ))
  previewSurfaces.forEach(resetPreviewSurface)

  if (kind === 'sheet') {
    clone.style.position = 'static'
    clone.style.left = 'auto'
    clone.style.top = 'auto'
    clone.style.outline = 'none'
    clone.classList.toggle('label-sheet-print-grid', printGrid)
  }
}

function createPrintStyle(job: LabelBrowserPrintJob) {
  const width = `${job.widthMm}mm`
  const height = `${job.heightMm}mm`
  const style = document.createElement('style')
  style.id = PRINT_STYLE_ID
  style.textContent = `
    #${PRINT_HOST_ID} {
      display: none !important;
    }
    @page { size: ${width} ${height}; margin: 0; }
    @media print {
      html,
      body {
        box-sizing: border-box !important;
        margin: 0 !important;
        padding: 0 !important;
        width: ${width} !important;
        overflow: visible !important;
      }
      body > :not(#${PRINT_HOST_ID}) {
        display: none !important;
      }
      #${PRINT_HOST_ID} {
        display: block !important;
        box-sizing: border-box !important;
        margin: 0 !important;
        padding: 0 !important;
        width: ${width} !important;
        overflow: visible !important;
      }
      #${PRINT_HOST_ID},
      #${PRINT_HOST_ID} * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .filaman-print-page {
        box-sizing: border-box !important;
        display: block !important;
        margin: 0 !important;
        padding: 0 !important;
        width: ${width} !important;
        height: ${height} !important;
        overflow: hidden !important;
        break-after: page;
        page-break-after: always;
      }
      .filaman-print-page:last-child {
        break-after: auto;
        page-break-after: auto;
      }
      .filaman-print-page > .label-wrapper {
        margin: 0 !important;
        padding: 0 !important;
        width: auto !important;
        height: auto !important;
        overflow: visible !important;
      }
      .filaman-print-page > .label-preview,
      .filaman-print-page > .label-wrapper > .label-preview,
      .filaman-print-page > .label-sheet-page {
        box-shadow: none !important;
        border: 0 !important;
        border-radius: 0 !important;
        outline: 0 !important;
        zoom: 1 !important;
        transform: none !important;
        transform-origin: unset !important;
      }
      .filaman-print-page > .label-sheet-page {
        position: static !important;
        inset: auto !important;
      }
      .filaman-print-page:not(.filaman-print-grid) .label-sheet-cell {
        border: 0 !important;
      }
      .filaman-print-page.filaman-print-grid .label-sheet-cell {
        border: 0.2mm solid #c8c8c8 !important;
      }
      .filaman-print-page .label-sheet-label-shell::after {
        content: none !important;
        display: none !important;
      }
    }
  `
  return style
}

function createPrintHost(job: LabelBrowserPrintJob) {
  const host = document.createElement('div')
  host.id = PRINT_HOST_ID
  job.pages.forEach(sourcePage => {
    const page = document.createElement('div')
    page.className = 'filaman-print-page'
    page.classList.toggle('filaman-print-grid', job.printGrid)
    const clone = sourcePage.cloneNode(true) as HTMLElement
    removeElementIds(clone)
    normalizePrintClone(clone, job.kind, job.printGrid)
    page.appendChild(clone)
    host.appendChild(page)
  })
  return host
}

function getPageImages(pages: HTMLElement[]) {
  const images: HTMLImageElement[] = []
  pages.forEach(page => {
    if (page instanceof HTMLImageElement) images.push(page)
    images.push(...page.querySelectorAll<HTMLImageElement>('img'))
  })
  return images
}

async function waitForImage(image: HTMLImageElement) {
  if (typeof image.decode !== 'function') return
  try {
    await image.decode()
  } catch (error) {
    if (!image.complete) throw error
  }
}

async function waitForAssets(pages: HTMLElement[]) {
  const fonts = (document as Document & {
    fonts?: { ready?: Promise<unknown> }
  }).fonts
  const fontsReady = fonts?.ready
    ? Promise.resolve(fonts.ready)
    : Promise.resolve()
  await Promise.all([
    fontsReady,
    ...getPageImages(pages).map(waitForImage),
  ])
}

function waitForTimerBackedAnimationFrame() {
  return new Promise<void>(resolve => {
    let settled = false
    let animationFrameId: number | undefined
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timerId)
      if (animationFrameId !== undefined) {
        window.cancelAnimationFrame(animationFrameId)
      }
      resolve()
    }
    const timerId = setTimeout(done, FRAME_FALLBACK_DELAY_MS)
    if (typeof window.requestAnimationFrame === 'function') {
      animationFrameId = window.requestAnimationFrame(done)
    }
  })
}

export function cleanupLabelBrowserPrint() {
  if (cleanupTimer !== undefined) {
    clearTimeout(cleanupTimer)
    cleanupTimer = undefined
  }
  window.removeEventListener('afterprint', cleanupLabelBrowserPrint)
  window.removeEventListener('pagehide', cleanupLabelBrowserPrint)
  document.getElementById(PRINT_HOST_ID)?.remove()
  document.getElementById(PRINT_STYLE_ID)?.remove()
  document.body?.classList.remove(PRINTING_CLASS)
}

export async function printLabelBrowserJob(
  job: LabelBrowserPrintJob,
): Promise<void> {
  assertValidJob(job)
  cleanupLabelBrowserPrint()

  const style = createPrintStyle(job)
  const host = createPrintHost(job)
  document.head.appendChild(style)
  document.body.appendChild(host)
  document.body.classList.add(PRINTING_CLASS)

  try {
    await waitForAssets(job.pages)
    await waitForTimerBackedAnimationFrame()
    await waitForTimerBackedAnimationFrame()
    window.addEventListener('afterprint', cleanupLabelBrowserPrint, {
      once: true,
    })
    window.addEventListener('pagehide', cleanupLabelBrowserPrint, {
      once: true,
    })
    window.print()
    if (document.getElementById(PRINT_HOST_ID)) {
      cleanupTimer = setTimeout(
        cleanupLabelBrowserPrint,
        PRINT_CLEANUP_DELAY_MS,
      )
    }
  } catch (error) {
    cleanupLabelBrowserPrint()
    throw error
  }
}
