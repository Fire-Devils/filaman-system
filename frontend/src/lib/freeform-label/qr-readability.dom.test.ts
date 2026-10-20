// @vitest-environment happy-dom

import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'

import CanvasTextToolbar from '../../components/freeform-label/CanvasTextToolbar.astro'
import ElementInspector from '../../components/freeform-label/ElementInspector.astro'
import { bindFreeformEditorDom, type BindFreeformEditorDomOptions } from './editor-dom'
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

afterEach(() => { Reflect.deleteProperty(window, 'QRCode'); vi.restoreAllMocks() })

async function renderEditor(moduleCounts: number[], options: Partial<BindFreeformEditorDomOptions> = {}) {
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
  const binding = bindFreeformEditorDom({ root: document, controller, editable: false, ...options })
  await binding.ready
  return { binding, controller }
}

describe('QR readability advisory', () => {
  it.each(['spools', 'filaments'] as const)('shows batch guidance on a direct Designer load for %s without the legacy encoder', async entityPath => {
    expect('QRCode' in window).toBe(false)
    const { binding, controller } = await renderEditor([21], {
      getQrEntityIds: () => [1, 222], entityPath,
    })
    controller.updateSelected({ linkMode: 'url', urlTemplate: 'https://example.test/long' })
    binding.sync()
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    expect(recommendation.textContent).toContain('200 DPI: 18.8 mm')
    expect(recommendation.textContent).toContain('300 DPI: 12.6 mm')
    expect(document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!.hidden).toBe(false)
    binding.destroy()
  })
  it('encodes every current batch URL instead of trusting representative or stale DOM metadata', async () => {
    const encode = vi.spyOn(QRCode, 'create')
    const { binding, controller } = await renderEditor([21], {
      getQrEntityIds: () => [1, 222], entityPath: 'filaments',
    })
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    expect(recommendation.textContent).toContain('18.8 mm')
    expect(encode.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/filaments/1', '/filaments/222'])
    controller.updateSelected({ w: 15 })
    binding.sync()
    expect(encode).toHaveBeenCalledTimes(2)
    expect(document.querySelector('#freeform-qr-readability-note')?.textContent).toContain('1.9 mm')
    controller.updateSelected({ linkMode: 'url', urlTemplate: 'https://example.test/long' })
    binding.sync()
    expect(encode.mock.calls.slice(-2).map(([url]) => url)).toEqual(['https://example.test/long/filaments/1', 'https://example.test/long/filaments/222'])
    expect(recommendation.textContent).toContain('18.8 mm')
    controller.updateSelected({ urlTemplate: 'https://example.test/' + 'long/'.repeat(20) })
    binding.sync()
    expect(recommendation.textContent).not.toContain('18.8 mm')
    expect(recommendation.textContent).toContain('200 DPI:')
    binding.destroy()
  })
  it('keeps the centered logo choices above the label and the size advice below geometry inputs', async () => {
    const { binding } = await renderEditor([37])
    const toolbar = document.querySelector('#freeform-text-toolbar')!
    const inspector = document.querySelector('#freeform-element-inspector')!
    const advisory = document.querySelector('#freeform-qr-readability-heading')!
    const recommendation = document.querySelector('#freeform-qr-readability-recommendation')!

    expect(toolbar.querySelector('legend')?.textContent).toBe('QR Code Center Logo')
    expect(toolbar.querySelector('.freeform-qr-readability')).toBeNull()
    expect(inspector.contains(recommendation)).toBe(true)
    expect(inspector.querySelector('#freeform-layer-position')?.nextElementSibling?.firstElementChild).toBe(advisory)
    expect(advisory.textContent).toBe('QR print guidance')
    expect(advisory.classList.contains('freeform-geometry-heading')).toBe(true)
    expect(advisory.nextElementSibling).toBe(recommendation)
    binding.destroy()
  })

  it('distinguishes the two resolution thresholds without marking geometry invalid', async () => {
    const { binding, controller } = await renderEditor([37])
    const width = document.querySelector<HTMLInputElement>('[data-element-prop="w"]')!
    const height = document.querySelector<HTMLInputElement>('[data-element-prop="h"]')!
    const widthIcon = width.closest('label')!.querySelector<HTMLElement>('[data-qr-size-warning]')!
    const heightIcon = height.closest('label')!.querySelector<HTMLElement>('[data-qr-size-warning]')!
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!

    expect(recommendation.textContent).toContain('200 DPI: 18.8 mm')
    expect(recommendation.textContent).toContain('300 DPI: 12.6 mm')
    controller.updateSelected({ w: 12.5 })
    binding.sync()
    expect(controller.getSelectedElement()).toMatchObject({ w: 12.5, h: 12.5 })
    expect(warning.textContent).toContain('200 DPI by 6.3 mm')
    const warning300 = document.querySelector<HTMLElement>('#freeform-qr-readability-warning-300')!
    expect(warning300.textContent).toContain('300 DPI by 0.1 mm')
    expect(warning300.hidden).toBe(false)
    expect(width.hasAttribute('aria-invalid')).toBe(false)
    expect(widthIcon.hidden).toBe(false)
    expect(height.hasAttribute('aria-invalid')).toBe(false)
    expect(heightIcon.hidden).toBe(false)

    controller.updateSelected({ w: 12.6 })
    binding.sync()
    expect(warning.textContent).toContain('200 DPI')
    expect(warning.textContent).not.toContain('300 DPI')
    expect(warning300.hidden).toBe(true)
    expect(width.getAttribute('aria-describedby')).toContain('freeform-qr-readability-warning')
    expect(widthIcon.hidden).toBe(false)

    controller.updateSelected({ w: 18.8 })
    binding.sync()
    expect(width.hasAttribute('aria-invalid')).toBe(false)
    expect(widthIcon.hidden).toBe(true)
    expect(height.hasAttribute('aria-invalid')).toBe(false)
    expect(heightIcon.hidden).toBe(true)
    expect(warning.hidden).toBe(true)
    binding.destroy()
  })

  it('uses the densest rendered batch QR and warns without restricting its geometry', async () => {
    const { binding, controller } = await renderEditor([37, 41])
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!

    expect(recommendation.textContent).toContain('200 DPI: 20.9 mm')
    expect(recommendation.textContent).toContain('300 DPI: 13.9 mm')
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain('200 DPI by 7.9 mm')
    expect(controller.getSelectedElement()).toMatchObject({ w: 13, h: 13 })

    controller.updateSelected({ w: 20.9 })
    binding.sync()

    expect(warning.hidden).toBe(true)
    expect(controller.getSelectedElement()).toMatchObject({ w: 20.9, h: 20.9 })
    binding.destroy()
  })

  it('keeps quiet-zone and test-print advice when module metadata is unavailable', async () => {
    const { binding } = await renderEditor([])
    const recommendation = document.querySelector<HTMLElement>('#freeform-qr-readability-recommendation')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!
    const note = document.querySelector<HTMLElement>('#freeform-qr-readability-note')!

    expect(recommendation.textContent).toContain('after the code is rendered')
    expect(warning.hidden).toBe(true)
    expect(note.textContent).toContain('4-module')
    expect(note.textContent).toContain('actual size')
    expect(note.textContent).toContain('test scanning')
    binding.destroy()
  })

  it('uses one square size input for QR and restores separate dimensions for text', async () => {
    const { binding, controller } = await renderEditor([37], { editable: true })
    const width = document.querySelector<HTMLInputElement>('[data-element-prop="w"]')!
    const height = document.querySelector<HTMLInputElement>('[data-element-prop="h"]')!
    expect(width.getAttribute('aria-label')).toBe('Side length (mm)')
    expect(height.closest('label')!.hidden).toBe(true)
    width.value = '15'
    width.dispatchEvent(new Event('change', { bubbles: true }))
    binding.sync()
    expect(controller.getSelectedElement()).toMatchObject({ w: 15, h: 15 })
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!
    expect(warning.textContent).toContain('200 DPI by 3.8 mm')
    controller.addElement('text')
    binding.sync()
    expect(width.getAttribute('aria-label')).toBe('Width (mm)')
    expect(height.closest('label')!.hidden).toBe(false)
    binding.destroy()
  })

  it('groups the logo caution and shortfall below the 200 DPI recommendation', async () => {
    const { binding, controller } = await renderEditor([37])
    controller.updateSelected({ mode: 'logo', w: 15 })
    binding.sync()
    const logo = document.querySelector<HTMLElement>('#freeform-qr-readability-logo')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!
    expect(logo.parentElement).toBe(warning.parentElement)
    expect(logo.parentElement?.previousElementSibling?.textContent).toContain('200 DPI: 18.8 mm')
    expect(logo.parentElement?.nextElementSibling?.textContent).toContain('300 DPI: 12.6 mm')
    binding.destroy()
  })

  it('keeps the logo caution independent of size and clears it when decoration is disabled', async () => {
    const { binding, controller } = await renderEditor([37])
    const logo = document.querySelector<HTMLElement>('#freeform-qr-readability-logo')!
    const warning = document.querySelector<HTMLElement>('#freeform-qr-readability-warning')!
    expect(logo?.hidden).toBe(true)
    for (const mode of ['logo', 'colorLogo'] as const) {
      controller.updateSelected({ w: 20, mode })
      binding.sync()
      expect(warning.hidden).toBe(true)
      expect(logo.hidden).toBe(false)
      expect(logo.textContent).toContain('disable the logo')
    }
    controller.updateSelected({ mode: 'simple' })
    binding.sync()
    expect(logo.hidden).toBe(true)
    binding.destroy()
  })

  it('shows a rounded-up clear border using the least dense batch code at its current size', async () => {
    const { binding, controller } = await renderEditor([37, 41])
    const note = document.querySelector<HTMLElement>('#freeform-qr-readability-note')!
    controller.updateSelected({ w: 15 })
    binding.sync()
    expect(note.textContent).toContain('1.7 mm')
    expect(note.textContent).toContain('automatic')
    controller.updateSelected({ w: 20 })
    binding.sync()
    expect(note.textContent).toContain('2.2 mm')
    const boundary = document.querySelector<HTMLElement>('#freeform-qr-readability-boundary')!
    expect(boundary.hidden).toBe(false)
    controller.updateSelected({ x: 5, y: 5 })
    binding.sync()
    expect(boundary.hidden).toBe(true)
    controller.updateSelected({ x: 2.2, y: 2.2 })
    binding.sync()
    expect(boundary.hidden).toBe(true) // The outline may occupy the existing 1 mm label margin.
    binding.destroy()
  })

  it('allows an outline snapped exactly to the paper edge despite floating-point rounding', async () => {
    const { binding, controller } = await renderEditor([37])
    controller.updateSelected({ x: 30, y: 5, w: 30 / (1 + 4 / 37) })
    binding.sync()
    expect(document.querySelector<HTMLElement>('#freeform-qr-readability-boundary')!.hidden).toBe(true)
    binding.destroy()
  })

  it('checks the rendered position after legacy empty-logo collapse', async () => {
    const { binding, controller } = await renderEditor([37])
    controller.updateSelected({ x: 5, y: 8, w: 16 })
    const qr = document.querySelector<HTMLElement>('[data-qr-module-count]')!
    qr.style.top = '1.5mm'
    binding.sync()
    expect(document.querySelector<HTMLElement>('#freeform-qr-readability-boundary')!.hidden).toBe(false)
    binding.destroy()
  })
})
