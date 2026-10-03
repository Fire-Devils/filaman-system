import { labelAssetContentUrl } from './assets'
import { cropImageBox } from './crop-box'
import type { FreeformEditorController } from './editor-state'
import type { LabelImageCrop } from './types'

interface CropEditorOptions {
  root: ParentNode
  controller: FreeformEditorController
  isEditable: () => boolean
  onChange: () => void
  translate?: (key: string, fallback: string) => string
}

const fullImage = (): LabelImageCrop => ({ x: 0, y: 0, w: 1, h: 1 })
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function bindImageCropEditor(options: CropEditorOptions) {
  const dialog = options.root.querySelector<HTMLDialogElement>('#freeform-image-crop-dialog')
  const trigger = options.root.querySelector<HTMLButtonElement>('#freeform-image-crop')
  if (!dialog || !trigger) return null
  const image = dialog.querySelector<HTMLImageElement>('img')!
  const stage = dialog.querySelector<HTMLElement>('[data-crop-stage]')!
  const selection = dialog.querySelector<HTMLElement>('[data-crop-selection]')!
  const apply = dialog.querySelector<HTMLButtonElement>('[data-crop-action="apply"]')!
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!
  const translate = options.translate ?? ((_key: string, fallback: string) => fallback)
  const controller = options.controller
  const cleanups: Array<() => void> = []
  let target: { id: string; assetId: string } | null = null
  let draft = fullImage()
  let loaded = false
  let gesture: { id: number; x: number; y: number; width: number; height: number; corner: string; crop: LabelImageCrop } | null = null
  const listen = (node: EventTarget, name: string, handler: EventListener) => {
    node.addEventListener(name, handler)
    cleanups.push(() => node.removeEventListener(name, handler))
  }
  const render = () => {
    Object.assign(selection.style, { left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` })
    selection.hidden = !loaded
    apply.disabled = !loaded
  }
  const close = () => { gesture = null; target = null; if (dialog.open) dialog.close() }
  const validTarget = () => {
    const current = target && controller.getElement(target.id)
    return options.isEditable() && !controller.isDestroyed() && current?.type === 'image'
      && current.id === controller.getSelectedId() && current.assetId === target?.assetId
  }
  const sync = () => {
    const selected = controller.getSelectedElement()
    trigger.disabled = !options.isEditable() || selected?.type !== 'image' || !selected.assetId
    if (dialog.open && !validTarget()) close()
  }
  const adjust = (original: LabelImageCrop, dx: number, dy: number, corner: string) => {
    if (!corner) {
      draft = { ...original, x: clamp(original.x + dx, 0, 1 - original.w), y: clamp(original.y + dy, 0, 1 - original.h) }
    } else {
      const left = corner.includes('w') ? clamp(original.x + dx, 0, original.x + original.w - 0.01) : original.x
      const top = corner.includes('n') ? clamp(original.y + dy, 0, original.y + original.h - 0.01) : original.y
      const right = corner.includes('e') ? clamp(original.x + original.w + dx, left + 0.01, 1) : original.x + original.w
      const bottom = corner.includes('s') ? clamp(original.y + original.h + dy, top + 0.01, 1) : original.y + original.h
      draft = { x: left, y: top, w: right - left, h: bottom - top }
    }
    render()
  }
  listen(trigger, 'click', () => {
    const selected = controller.getSelectedElement()
    if (!options.isEditable() || selected?.type !== 'image' || !selected.assetId) return
    target = { id: selected.id, assetId: selected.assetId }
    draft = selected.crop ? { ...selected.crop } : fullImage()
    loaded = false
    status.textContent = translate('labelDesigner.cropLoading', 'Loading image…')
    image.src = controller.getAssets().find(asset => asset.id === selected.assetId)?.content_url ?? labelAssetContentUrl(selected.assetId)
    render()
    dialog.showModal()
  })
  listen(image, 'load', () => {
    if (!dialog.open || !validTarget()) return
    loaded = image.naturalWidth > 0 && image.naturalHeight > 0
    status.textContent = loaded ? '' : translate('labelDesigner.imageLoadFailed', 'Could not load image')
    render()
  })
  listen(image, 'error', () => {
    loaded = false
    status.textContent = translate('labelDesigner.imageLoadFailed', 'Could not load image')
    render()
  })
  listen(dialog, 'close', () => { target = null; gesture = null; trigger.focus() })
  listen(dialog, 'click', event => {
    const action = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-crop-action]')?.dataset.cropAction : undefined
    if (action === 'cancel') close()
    if (action === 'reset') { draft = fullImage(); render() }
    if (action === 'apply' && loaded && validTarget() && target) {
      const id = target.id
      const element = controller.getElement(id)
      if (element?.type !== 'image') return
      const geometry = cropImageBox(element, draft, { width: image.naturalWidth, height: image.naturalHeight }, controller.getLabel())
      controller.updateElement(id, { ...geometry, crop: { ...draft } })
      close()
      options.onChange()
    }
  })
  listen(selection, 'pointerdown', event => {
    const pointer = event as PointerEvent
    if (!loaded || pointer.button !== 0) return
    const bounds = stage.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const corner = pointer.target instanceof Element ? pointer.target.closest<HTMLElement>('[data-crop-handle]')?.dataset.cropHandle ?? '' : ''
    gesture = { id: pointer.pointerId, x: pointer.clientX, y: pointer.clientY, width: bounds.width, height: bounds.height, corner, crop: { ...draft } }
    selection.setPointerCapture(pointer.pointerId)
    pointer.preventDefault()
  })
  listen(selection, 'pointermove', event => {
    const pointer = event as PointerEvent
    if (!gesture || gesture.id !== pointer.pointerId) return
    adjust(gesture.crop, (pointer.clientX - gesture.x) / gesture.width, (pointer.clientY - gesture.y) / gesture.height, gesture.corner)
  })
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(selection, name, () => { gesture = null })
  listen(selection, 'keydown', event => {
    const key = event as KeyboardEvent
    if (!loaded || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key.key)) return
    key.preventDefault()
    const step = key.shiftKey ? 0.1 : 0.01
    const corner = key.target instanceof HTMLElement ? key.target.dataset.cropHandle ?? '' : ''
    adjust(draft, key.key === 'ArrowLeft' ? -step : key.key === 'ArrowRight' ? step : 0, key.key === 'ArrowUp' ? -step : key.key === 'ArrowDown' ? step : 0, corner)
  })
  sync()
  return { sync, destroy() { close(); cleanups.splice(0).forEach(cleanup => cleanup()) } }
}
