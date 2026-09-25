// @vitest-environment happy-dom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  bindFixedPreviewToolbar,
  prepareLabelOutputClone,
  stripElementIds,
} from './label-preview-dom'

beforeEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('stripElementIds', () => {
  it('removes IDs from the root and every descendant', () => {
    const root = document.createElement('section')
    root.id = 'label-root'
    root.innerHTML = '<div id="label-content"><span id="label-text">Label</span></div>'

    stripElementIds(root)

    expect(root.id).toBe('')
    expect(root.querySelector('[id]')).toBeNull()
  })
})

describe('prepareLabelOutputClone', () => {
  it('removes live text-editing affordances without changing token output', () => {
    const label = document.createElement('div')
    label.innerHTML = '<div data-label-element-id="text" data-label-text-editing contenteditable="true"><strong><span data-template-token-chip contenteditable="false" draggable="false">PETG</span></strong></div>'
    prepareLabelOutputClone(label)
    expect(label.querySelector('[data-label-text-editing], [data-template-token-chip], [contenteditable], [draggable]')).toBeNull()
    expect(label.querySelector('strong')?.textContent).toBe('PETG')
  })

  it('clips overflowing artwork to physical label dimensions and removes margin guides', () => {
    const page = document.createElement('section')
    page.innerHTML = '<div class="label-preview" data-label-interactive style="overflow:visible;width:60mm;height:40mm;--inner-border-style:0.3mm solid black"><div data-label-element-id="shape" style="left:-5mm;width:20mm"></div><div data-label-margin-guide data-label-editor-chrome></div></div>'
    prepareLabelOutputClone(page)
    const label = page.querySelector<HTMLElement>('.label-preview')!
    expect(label.style.overflow).toBe('hidden')
    expect(label.style.width).toBe('60mm')
    expect(label.style.height).toBe('40mm')
    expect(label.querySelector<HTMLElement>('[data-label-element-id]')!.style.left).toBe('-5mm')
    expect(label.querySelector('[data-label-margin-guide]')).toBeNull()
    expect(label.style.getPropertyValue('--inner-border-style')).toBe('0.3mm solid black')
  })

  it.each([900, 901])('removes editor-only state and focus semantics at %ipx while preserving rendered label elements', width => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    const root = document.createElement('section')
    root.id = 'label-root'
    root.className = 'label-preview is-selected is-designer-output-only'
    root.setAttribute('aria-hidden', 'true')
    root.setAttribute('data-label-interactive', '')
    root.innerHTML = `
      <div id="content" class="is-selected" data-label-element-id="text" data-label-interaction-bound tabindex="0" role="button" aria-label="Text element">Label</div>
      <button data-editor-handle>Resize</button>
      <div data-label-editor-chrome>Toolbar</div>
    `

    prepareLabelOutputClone(root)

    expect(root.id).toBe('')
    expect(root.hasAttribute('data-label-interactive')).toBe(false)
    expect(root.classList.contains('is-designer-output-only')).toBe(false)
    expect(root.hasAttribute('aria-hidden')).toBe(false)
    expect(root.querySelector('[data-editor-handle]')).toBeNull()
    expect(root.querySelector('[data-label-editor-chrome]')).toBeNull()
    expect(root.querySelector('[data-label-element-id="text"]')?.textContent).toBe('Label')
    expect(root.querySelector('.is-selected')).toBeNull()
    expect(root.querySelector('[data-label-interaction-bound]')).toBeNull()
    const outputElement = root.querySelector('[data-label-element-id="text"]')
    expect(outputElement?.hasAttribute('tabindex')).toBe(false)
    expect(outputElement?.hasAttribute('role')).toBe(false)
    expect(outputElement?.hasAttribute('aria-label')).toBe(false)
  })
})

describe('bindFixedPreviewToolbar', () => {
  it('positions the preview toolbar and restores its inline styles', () => {
    const previewRoot = document.createElement('section')
    const toolbar = document.createElement('div')
    toolbar.className = 'preview-zoom-bar'
    previewRoot.appendChild(toolbar)
    document.body.appendChild(previewRoot)
    Object.defineProperty(previewRoot, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 20, left: 10, width: 400 }),
    })

    const binding = bindFixedPreviewToolbar({ previewRoot })

    expect(toolbar.style.position).toBe('fixed')
    expect(toolbar.style.top).toBe('20px')
    expect(toolbar.style.left).toBe('210px')
    expect(toolbar.style.transform).toBe('translateX(-50%)')

    binding.restore()

    expect(toolbar.style.position).toBe('')
    expect(toolbar.style.top).toBe('')
    expect(toolbar.style.left).toBe('')
    expect(toolbar.style.transform).toBe('')
  })

  it('centers the toolbar within the visible part of a clipped preview', () => {
    const previewRoot = document.createElement('section')
    const toolbar = document.createElement('div')
    toolbar.className = 'preview-zoom-bar'
    previewRoot.appendChild(toolbar)
    document.body.appendChild(previewRoot)
    vi.stubGlobal('innerWidth', 800)
    Object.defineProperty(previewRoot, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 20, left: 700, right: 1100, width: 400 }),
    })

    bindFixedPreviewToolbar({ previewRoot })

    expect(toolbar.style.left).toBe('750px')
  })

  it('leaves the toolbar untouched when its caller is inactive', () => {
    const previewRoot = document.createElement('section')
    const toolbar = document.createElement('div')
    toolbar.className = 'preview-zoom-bar'
    previewRoot.appendChild(toolbar)

    bindFixedPreviewToolbar({
      previewRoot,
      isActive: () => false,
    })

    expect(toolbar.getAttribute('style')).toBeNull()
  })

  it('uses the latest caller activation policy for an existing preview root', () => {
    const previewRoot = document.createElement('section')
    const toolbar = document.createElement('div')
    toolbar.className = 'preview-zoom-bar'
    previewRoot.appendChild(toolbar)

    bindFixedPreviewToolbar({
      previewRoot,
      isActive: () => false,
    })
    bindFixedPreviewToolbar({ previewRoot })

    expect(toolbar.style.position).toBe('fixed')
  })

  it('destroys listeners and pending animation work, then permits a fresh binding', () => {
    const previewRoot = document.createElement('section')
    const toolbar = document.createElement('div')
    toolbar.className = 'preview-zoom-bar'
    previewRoot.appendChild(toolbar)
    document.body.appendChild(previewRoot)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(19)
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')

    const binding = bindFixedPreviewToolbar({ previewRoot })
    window.dispatchEvent(new Event('resize'))
    binding.destroy()

    expect(cancelFrame).toHaveBeenCalledWith(19)
    expect(toolbar.style.position).toBe('')

    requestFrame.mockClear()
    window.dispatchEvent(new Event('resize'))
    expect(requestFrame).not.toHaveBeenCalled()

    const replacement = bindFixedPreviewToolbar({ previewRoot })
    expect(replacement).not.toBe(binding)
    replacement.destroy()
  })
})
