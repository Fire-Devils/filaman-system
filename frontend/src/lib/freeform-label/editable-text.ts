import { getFilamentColorTheme, renderSelectableTemplate, type SpoolData } from '../label-template'
import type { LabelDesignElement } from './types'

/** Temporary selection/editing surface; printed text comes from the SVG renderer. */
export function renderEditableText(node: HTMLElement, element: Extract<LabelDesignElement, { type: 'text' }>, data: SpoolData) {
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
  content.appendChild(renderSelectableTemplate(element.template, data))
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
