// @vitest-environment happy-dom

import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it } from 'vitest'

import CanvasTextToolbar from '../../components/freeform-label/CanvasTextToolbar.astro'
import ElementInspector from '../../components/freeform-label/ElementInspector.astro'
import { bindFreeformEditorDom } from './editor-dom'
import { createFreeformEditorController } from './editor-state'
import type { LabelDesignV2 } from './types'

const design: LabelDesignV2 = {
  version: 2,
  label: { widthMm: 60, heightMm: 40, marginMm: 1, border: false },
  elements: [{
    id: 'qr', type: 'qr', x: 2, y: 2, w: 13, h: 13, z: 0,
    mode: 'simple', linkMode: 'spool', urlTemplate: '',
  }],
}

async function renderEditor(moduleCounts: number[]) {
  const container = await AstroContainer.create()
  document.body.innerHTML = `${await container.renderToString(CanvasTextToolbar)}${await container.renderToString(ElementInspector)}<div id="freeform-canvas-host"></div>`
  const host = document.querySelector<HTMLElement>('#freeform-canvas-host')!
  const controller = createFreeformEditorController({
    initialDesign: design,
    render: () => {
      const renderedDesign = controller.getDesign()
      const preview = document.createElement('div')
      preview.className = 'label-preview'
      for (const moduleCount of moduleCounts) {
        const qr = document.createElement('div')
        qr.dataset.labelElementId = renderedDesign.elements[0].id
        qr.dataset.labelElementType = 'qr'
        qr.dataset.qrModuleCount = String(moduleCount)
        preview.append(qr)
      }
      host.replaceChildren(preview)
    },
  })
  const binding = bindFreeformEditorDom({ root: document, controller, editable: false })
  await binding.ready
  return { binding, controller }
}

describe('QR readability advisory', () => {
  it('keeps the centered logo choices above the label and the size advice below geometry inputs', async () => {
    const { binding } = await renderEditor([37])
    const toolbar = document.querySelector('#freeform-text-toolbar')!
    const inspector = document.querySelector('#freeform-element-inspector')!
    const recommendation = document.querySelector('#freeform-qr-readability-recommendation')!

    expect(toolbar.querySelector('legend')?.textContent).toBe('QR Code Center Logo')
    expect(toolbar.querySelector('.freeform-qr-readability')).toBeNull()
    expect(inspector.contains(recommendation)).toBe(true)
    expect(inspector.querySelector('.freeform-geometry-grid')?.nextElementSibling).toContain(recommendation)
    binding.destroy()
  })

  it('highlights both square QR dimensions below the encoded minimum and clears them at the threshold', async () => {
    const { binding, controller } = await renderEditor([37])
    const width = document.querySelector<HTMLInputElement>('[data-element-prop="w"]')!
    const height = document.querySelector<HTMLInputElement>('[data-element-prop="h"]')!
    const widthIcon = width.closest('label')!.querySelector<HTMLElement>('[data-qr-size-warning]')!
    const heightIcon = height.closest('label')!.querySelector<HTMLElement>('[data-qr-size-warning]')!
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!

    expect(recommendation.textContent).toContain('12.54 mm')
    controller.updateSelected({ w: 12.53 })
    binding.sync()
    expect(controller.getSelectedElement()).toMatchObject({ w: 12.53, h: 12.53 })
    expect(width.getAttribute('aria-invalid')).toBe('true')
    expect(widthIcon.hidden).toBe(false)
    expect(height.getAttribute('aria-invalid')).toBe('true')
    expect(heightIcon.hidden).toBe(false)

    controller.updateSelected({ w: 12.54 })
    binding.sync()
    expect(width.hasAttribute('aria-invalid')).toBe(false)
    expect(widthIcon.hidden).toBe(true)
    expect(height.hasAttribute('aria-invalid')).toBe(false)
    expect(heightIcon.hidden).toBe(true)
    binding.destroy()
  })

  it('uses the densest rendered batch QR and warns without restricting its geometry', async () => {
    const { binding, controller } = await renderEditor([37, 41])
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!

    expect(recommendation.textContent).toContain('13.89 mm')
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain('13.89 mm')
    expect(controller.getSelectedElement()).toMatchObject({ w: 13, h: 13 })

    controller.updateSelected({ w: 13.89 })
    binding.sync()

    expect(warning.hidden).toBe(true)
    expect(controller.getSelectedElement()).toMatchObject({ w: 13.89, h: 13.89 })
    binding.destroy()
  })

  it('keeps quiet-zone and test-print advice when module metadata is unavailable', async () => {
    const { binding } = await renderEditor([])
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!
    const note = document.querySelector<HTMLElement>('#freeform-qr-readability-note')!

    expect(recommendation.textContent).toContain('after the code is rendered')
    expect(warning.hidden).toBe(true)
    expect(note.textContent).toContain('4 modules')
    expect(note.textContent).toContain('test print')
    binding.destroy()
  })
})
