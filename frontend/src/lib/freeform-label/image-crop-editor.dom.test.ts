// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import ImageCropDialog from '../../components/freeform-label/ImageCropDialog.astro'
import { bindImageCropEditor } from './image-crop-editor'
import { createFreeformEditorController } from './editor-state'
import { loadFreeformLabelDesign, persistFreeformLabelDesign } from './editor-storage'

afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks() })

async function setup() {
  const container = await AstroContainer.create()
  document.body.innerHTML = '<button id="freeform-image-crop">Crop</button>' + await container.renderToString(ImageCropDialog)
  const controller = createFreeformEditorController()
  controller.addImage('original-file')
  controller.updateSelected({ x: 10, y: 5, w: 20, h: 12 })
  const original = controller.getSelectedElement()!
  const change = vi.fn()
  let editable = true
  const binding = bindImageCropEditor({ root: document, controller, isEditable: () => editable, onChange: change })!
  const dialog = document.querySelector<HTMLDialogElement>('dialog')!
  const image = dialog.querySelector<HTMLImageElement>('img')!
  const open = () => {
    document.querySelector<HTMLButtonElement>('#freeform-image-crop')!.click()
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 })
    image.dispatchEvent(new Event('load'))
  }
  const key = (selector: string, name: string, count = 1, shiftKey = false) => {
    for (let index = 0; index < count; index++) dialog.querySelector(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }))
  }
  const halve = () => key('[data-crop-handle="e"]', 'ArrowLeft', 5, true)
  const action = (name: string) => dialog.querySelector<HTMLButtonElement>(`[data-crop-action="${name}"]`)!.click()
  return { controller, original, binding, dialog, image, open, key, halve, action, change, readonly: () => { editable = false; binding.sync() } }
}

describe('image crop editor', () => {
  it('keeps changes as a draft until Apply, tightens the box, and preserves the source and Undo', async () => {
    const s = await setup()
    s.open()
    s.halve()
    s.key('[data-crop-selection]', 'ArrowRight', 25)
    expect(s.controller.getSelectedElement()).toEqual(s.original)
    s.action('apply')
    expect(s.controller.getSelectedElement()).toMatchObject({ ...s.original, x: expect.closeTo(16), w: expect.closeTo(8), crop: { x: expect.closeTo(0.25), y: 0, w: expect.closeTo(0.5), h: 1 } })
    expect(s.dialog.open).toBe(false)
    expect(s.controller.undo().elements.find(element => element.id === s.original.id)).toEqual(s.original)
    expect(s.change).toHaveBeenCalledOnce()
    s.binding.destroy()
  })

  it('cancels drafts and resets an existing crop without changing the uploaded file', async () => {
    const s = await setup()
    s.open(); s.halve(); s.action('cancel')
    expect(s.controller.getSelectedElement()).toEqual(s.original)
    s.open(); s.halve(); s.action('apply')
    s.open(); s.action('reset'); s.action('apply')
    expect(s.controller.getSelectedElement()).toEqual({ ...s.original, x: 12, w: 16, crop: { x: 0, y: 0, w: 1, h: 1 } })
    s.binding.destroy()
  })

  it('supports keyboard crop adjustments and clamps them to the image', async () => {
    const s = await setup()
    s.open(); s.halve()
    const selection = s.dialog.querySelector<HTMLElement>('[data-crop-selection]')!
    selection.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    s.key('[data-crop-selection]', 'ArrowRight', 9, true)
    s.action('apply')
    expect(s.controller.getSelectedElement()).toMatchObject({ crop: { x: expect.closeTo(0.5), y: 0, w: expect.closeTo(0.5), h: 1 } })
    s.binding.destroy()
  })

  it('discards a draft when selection, source, or editability changes', async () => {
    const s = await setup()
    s.open(); s.halve(); s.controller.updateSelected({ assetId: 'replacement' }); s.binding.sync()
    expect(s.dialog.open).toBe(false)
    s.open(); s.controller.clearSelection(); s.binding.sync()
    expect(s.dialog.open).toBe(false)
    s.controller.select(s.original.id); s.open(); s.readonly()
    expect(s.dialog.open).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('#freeform-image-crop')!.disabled).toBe(true)
    s.binding.destroy()
  })

  it('does not apply an image that failed to load', async () => {
    const s = await setup()
    document.querySelector<HTMLButtonElement>('#freeform-image-crop')!.click()
    s.image.dispatchEvent(new Event('error'))
    expect(s.dialog.querySelector<HTMLButtonElement>('[data-crop-action="apply"]')!.disabled).toBe(true)
    expect(s.dialog.querySelector('[role="status"]')!.textContent).not.toBe('')
    s.binding.destroy()
  })

  it('resizes a crop from a pointer-driven corner and fits selection bounds to it', async () => {
    const s = await setup()
    s.open()
    const stage = s.dialog.querySelector<HTMLElement>('[data-crop-stage]')!
    const selection = s.dialog.querySelector<HTMLElement>('[data-crop-selection]')!
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
    Object.defineProperty(selection, 'setPointerCapture', { value: vi.fn(), configurable: true })
    s.dialog.querySelector('[data-crop-handle="nw"]')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0, bubbles: true }))
    selection.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 100, clientY: 75 }))
    selection.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    s.action('apply')
    expect(s.controller.getSelectedElement()).toMatchObject({ ...s.original, x: 16, y: 8, w: 12, h: 9, crop: { x: 0.25, y: 0.25, w: 0.75, h: 0.75 } })
    s.binding.destroy()
  })

  it('clears the old crop when replacing the image and restores it with Undo', async () => {
    const s = await setup()
    s.open(); s.halve(); s.action('apply')
    const cropped = s.controller.getSelectedElement()
    s.controller.updateSelected({ assetId: 'new-file' })
    expect(s.controller.getSelectedElement()).toMatchObject({ assetId: 'new-file' })
    expect(s.controller.getSelectedElement()).not.toHaveProperty('crop')
    expect(s.controller.undo().elements.find(element => element.id === s.original.id)).toEqual(cropped)
    s.binding.destroy()
  })

  it('preserves the applied crop and tight bounds through saved working-design reload', async () => {
    const s = await setup()
    s.open(); s.halve(); s.action('apply')
    const design = s.controller.getDesign()
    persistFreeformLabelDesign('crop-working', design)
    expect(loadFreeformLabelDesign({ settingsKey: 'crop-working', presetsKey: 'crop-presets', kind: 'spool' })).toEqual(design)
    s.binding.destroy()
  })

  it('keeps a thin full-source reset tight after saving and reloading', async () => {
    const s = await setup()
    const openThin = () => {
      s.open()
      Object.defineProperty(s.image, 'naturalWidth', { configurable: true, value: 10000 })
      Object.defineProperty(s.image, 'naturalHeight', { configurable: true, value: 100 })
    }
    openThin(); s.halve(); s.action('apply')
    openThin(); s.action('reset'); s.action('apply')
    const reset = s.controller.getSelectedElement()!
    expect(reset.w / reset.h).toBeCloseTo(100)
    persistFreeformLabelDesign('thin-reset', s.controller.getDesign())
    const saved = loadFreeformLabelDesign({ settingsKey: 'thin-reset', presetsKey: 'none', kind: 'spool' }).elements.find(element => element.id === reset.id)!
    expect(saved.w / saved.h).toBeCloseTo(100)
    s.binding.destroy()
  })
})
