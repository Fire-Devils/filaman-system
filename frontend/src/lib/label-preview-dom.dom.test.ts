// @vitest-environment happy-dom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

import {
  bindFixedPreviewToolbar,
  stripElementIds,
} from './label-preview-dom'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
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
})
