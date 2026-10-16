import { t } from '../i18n'

export interface TextFitTarget {
  node: HTMLElement
  minimumMm: number
  legacyTitle?: boolean
  fitToWidth?: boolean
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
      const { node, minimumMm, legacyTitle, fitToWidth = true } = targets[index]
      const width = clone.clientWidth
      if (width <= 0) return
      const content = clone.firstElementChild as HTMLElement
      const fits = () => {
        if (legacyTitle) return content.scrollWidth <= width
        // Measure the content itself: centered/bottom-aligned overflow can extend
        // above the box without increasing the box's scrollHeight.
        return Math.max(clone.scrollWidth, content.scrollWidth) <= width
          && content.scrollHeight <= clone.clientHeight
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
