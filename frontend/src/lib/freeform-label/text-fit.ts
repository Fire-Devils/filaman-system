import { t } from '../i18n'

export interface TextFitTarget {
  node: HTMLElement
  minimumMm: number
  maxLines: number
  legacyTitle?: boolean
  fitToWidth?: boolean
}

function renderedLineCount(content: HTMLElement): number {
  const range = document.createRange()
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const rects: DOMRect[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    // Container rectangles can span several lines (e.g. inverse banners).
    if (node.nodeType === Node.TEXT_NODE) {
      range.selectNodeContents(node)
      rects.push(...range.getClientRects())
    } else if (!node.hasChildNodes()) rects.push(...(node as HTMLElement).getClientRects())
  }
  let lines = 0
  let top = -Infinity
  let bottom = -Infinity
  for (const rect of rects.filter(rect => rect.height > 0).sort((a, b) => a.top - b.top)) {
    // Glyph bounds can slightly overlap adjacent line boxes. Same-line fragments
    // overlap by at least half the smaller fragment, even with mixed inline sizes.
    const overlap = Math.min(bottom, rect.bottom) - Math.max(top, rect.top)
    if (lines === 0 || overlap < Math.min(bottom - top, rect.height) / 2) {
      lines += 1
      top = rect.top
      bottom = rect.bottom
    } else {
      top = Math.max(top, rect.top)
      bottom = Math.min(bottom, rect.bottom)
    }
  }
  return lines
}

/** Measure actual resolved text on attached clones, including detached export roots. */
export async function fitLabelText(targets: TextFitTarget[]): Promise<void> {
  if (targets.length === 0) return
  const measurement = document.createElement('div')
  measurement.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;'
  const clones = targets.map(({ node }) => node.cloneNode(true) as HTMLElement)
  measurement.append(...clones)
  document.body.appendChild(measurement)
  try {
    // Trigger layout/font discovery before waiting for the fonts used by the clones.
    for (const clone of clones) void clone.offsetWidth
    if (document.fonts) await document.fonts.ready
    clones.forEach((clone, index) => {
      const { node, minimumMm, maxLines, legacyTitle, fitToWidth = true } = targets[index]
      const width = clone.clientWidth
      if (width <= 0) return
      const content = clone.firstElementChild as HTMLElement
      const fits = () => {
        if (legacyTitle) return content.scrollWidth <= width
        // Measure the content itself: centered/bottom-aligned overflow can extend
        // above the box without increasing the box's scrollHeight.
        return Math.max(clone.scrollWidth, content.scrollWidth) <= width
          && content.scrollHeight <= clone.clientHeight
          && renderedLineCount(content) <= maxLines
      }
      if (fitToWidth && !fits()) {
        let high = Number.parseFloat(clone.style.fontSize)
        let low = Math.min(minimumMm, high)
        clone.style.fontSize = `${low}mm`
        if (fits()) {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const middle = (low + high) / 2
            clone.style.fontSize = `${middle}mm`
            if (fits()) low = middle
            else high = middle
          }
        }
        clone.style.fontSize = `${low}mm`
        node.style.fontSize = clone.style.fontSize
        if (!fits()) {
          node.dataset.labelOutputError = t('labelDesigner.textDoesNotFit')
          node.style.outline = '1px solid #dc2626'
        }
      }
      if (legacyTitle) {
        const height = content.getBoundingClientRect().height
        if (height > 0) node.style.height = `${height / (96 / 25.4)}mm`
      }
    })
  } finally {
    measurement.remove()
  }
}
