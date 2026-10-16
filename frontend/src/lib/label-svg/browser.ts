import wasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url'
import { createSvgRuntime } from './runtime.mjs'
import { renderSvgLabelPng } from './core.mjs'
import type { SvgInput, SvgOutput, SvgRuntime, SvgAsset, SvgBox } from './types'
import type { RenderDesignerLabelOptions } from '../label-designer'
import type { LabelDesignV2 } from '../freeform-label/types'
import { normalizeLabelDesign } from '../freeform-label/normalize'
import { renderText } from '../freeform-label/render'
import { LabelOutputAssetError } from '../label-output-readiness'
import { assertLabelRasterBudget, LabelRasterBudgetError, MAX_BATCH_RASTER_PIXELS } from '../label-export'

const fontUrls = import.meta.glob<string>('/node_modules/@fontsource/*/files/*-latin-*-normal.woff2', { query: '?url', import: 'default', eager: true })
const contexts = new WeakMap<HTMLElement, Context>()
interface Context {
  owner: HTMLElement
  input: SvgInput
  runtime?: SvgRuntime
  pending: Promise<void>
  invalid: boolean
  revision: number
  frame?: number
}

/** Standard and designer previews reuse a root; invalidate its old raster job too. */
export function clearSvgDesignerLabel(root: HTMLElement) {
  const state = contexts.get(root)
  if (state?.frame !== undefined) cancelAnimationFrame(state.frame)
  contexts.delete(root)
  if (root.hasAttribute('data-label-svg')) {
    root.style.padding = ''
    root.style.overflow = ''
    root.removeAttribute('data-label-svg')
    root.removeAttribute('data-label-interactive')
    root.removeAttribute('data-label-output-error')
  }
}

export const pngDataUrl = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return 'data:image/png;base64,' + btoa(binary)
}

async function runtime() {
  return createSvgRuntime(async (path: string) => {
    const url = path.endsWith('.wasm') ? wasmUrl : fontUrls['/node_modules/' + path]
    if (!url) throw new Error('Label font is unavailable')
    const response = await fetch(url)
    if (!response.ok) throw new Error('Label runtime could not load')
    return new Uint8Array(await response.arrayBuffer())
  })
}

async function loadImage(source: string): Promise<SvgAsset> {
  const url = new URL(source, location.href)
  if (url.protocol === 'data:') {
    // Batch logo caches contain FileReader PNG/JPEG URLs; bound them before decoding.
    if (!/^data:image\/(png|jpeg);base64,/i.test(source) || source.length > 7 * 1024 * 1024) throw new Error('Unsupported label image')
  } else if (url.origin !== location.origin || !['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('Label image must be same-origin')
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error('Label image could not load')
  const blob = await response.blob()
  if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size > 5 * 1024 * 1024) throw new Error('Unsupported label image')
  const bitmap = await createImageBitmap(blob)
  try {
    if (bitmap.width * bitmap.height > 12000000) throw new Error('Label image exceeds pixel budget')
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('Label image could not load'))
      reader.readAsDataURL(blob)
    })
    return { dataUrl, width: bitmap.width, height: bitmap.height }
  } finally { bitmap.close() }
}

function rasterNode(output: SvgOutput) {
  const image = document.createElement('img')
  image.dataset.labelSvgRaster = ''
  image.src = pngDataUrl(output.png)
  image.alt = ''
  image.draggable = false
  Object.assign(image.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' })
  return image
}

function hitTargets(options: RenderDesignerLabelOptions, input: SvgInput, output?: SvgOutput) {
  const nodes: HTMLElement[] = []
  if (!options.interactive) return nodes
  const boxes: SvgBox[] = output?.boxes ?? input.preset.design.elements.map(e => ({ ...e, hidden: false }))
  for (const box of boxes) {
    if (box.hidden) continue
    const element = input.preset.design.elements.find(e => e.id === box.id)!
    const node = document.createElement('div')
    node.dataset.labelElementId = element.id
    node.dataset.labelElementType = element.type
    node.dataset.labelEditorChrome = ''
    node.dataset.labelSvgTarget = ''
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-label', element.type)
    Object.assign(node.style, { position: 'absolute', left: box.x + 'mm', top: box.y + 'mm',
      width: box.w + 'mm', height: box.h + 'mm', boxSizing: 'border-box',
      zIndex: String(element.z + 1), overflow: 'hidden' })
    if (element.type === 'text') {
      // Temporary editing surface only; shared pixels remain the output.
      const text = output?.text.find((row: { id: string }) => row.id === element.id)
      renderText(node, { ...element, fontSizeMm: text?.size ?? element.fontSizeMm }, input.data, true)
      const content = node.firstElementChild as HTMLElement | null
      if (content) content.style.visibility = 'hidden'
    }
    const qr = output?.qrs.find((row: { id: string }) => row.id === element.id)
    if (qr) node.dataset.qrModuleCount = String(qr.modules)
    nodes.push(node)
  }
  const guide = document.createElement('div')
  guide.dataset.labelEditorChrome = ''
  guide.dataset.labelMarginGuide = ''
  Object.assign(guide.style, { position: 'absolute', inset: input.preset.design.label.marginMm + 'mm',
    border: '1px dashed rgba(150,150,150,.7)', pointerEvents: 'none' })
  nodes.push(guide)
  return nodes
}

export async function renderSvgDesignerLabel(options: RenderDesignerLabelOptions): Promise<void> {
  if (options.isStale?.()) return
  const root = options.element, design = normalizeLabelDesign(options.design)
  const input: SvgInput = { preset: { version: 2, design }, data: structuredClone(options.data), assets: {},
    origin: location.origin, entityPath: options.entityPath === 'filaments' ? 'filaments' : 'spools',
    pixelWidth: Math.round(design.label.widthMm * 300 / 25.4), pixelHeight: Math.round(design.label.heightMm * 300 / 25.4), thermal: !!options.thermalQr }
  const state: Context = { owner: root, input, revision: (contexts.get(root)?.revision ?? 0) + 1, invalid: true, pending: Promise.resolve() }
  contexts.set(root, state)
  const current = () => contexts.get(root) === state && !options.isStale?.()
  state.pending = (async () => {
    let output: SvgOutput | undefined, error: unknown
    try {
      const assetIds = [...new Set(design.elements.filter(e => e.type === 'image').map(e => e.assetId))]
      await Promise.all(assetIds.map(async id => {
        const url = await options.resolveAssetUrl?.(id)
        if (!url) throw new Error('Label image is unavailable')
        input.assets[id] = await loadImage(url)
      }))
      if (options.logoUrl && design.elements.some(e => e.type === 'manufacturerLogo')) input.assets.logo = await loadImage(options.logoUrl)
      if (!input.thermal && design.elements.some(e => e.type === 'qr' && e.mode === 'colorLogo')) input.assets.qrLogo = await loadImage('/logo-qr.png')
      state.runtime = await runtime()
      if (!current()) return
      output = renderSvgLabelPng(input, state.runtime)
    } catch (caught) { error = caught }
    if (!current() || root.querySelector('[data-label-composing]')) return
    Object.assign(root.style, { width: design.label.widthMm + 'mm', height: design.label.heightMm + 'mm',
      padding: '0', position: 'relative', boxSizing: 'border-box', overflow: options.interactive ? 'visible' : 'hidden',
      background: 'white', border: options.previewBorder === false ? 'none' : '1px dashed #ccc' })
    root.style.setProperty('--print-label-padding', '0mm')
    root.style.setProperty('--inner-border-style', 'none')
    root.dataset.labelSvg = ''
    root.toggleAttribute('data-label-interactive', !!options.interactive)
    if (!output) {
      root.dataset.labelOutputError = error instanceof Error ? error.message : 'Label could not be rendered'
      const message = document.createElement('div')
      message.setAttribute('role', 'alert')
      message.textContent = root.dataset.labelOutputError
      message.style.cssText = 'font:12px sans-serif;color:#b91c1c;pointer-events:none'
      root.replaceChildren(message, ...hitTargets(options, input))
      return
    }
    root.removeAttribute('data-label-output-error')
    root.replaceChildren(rasterNode(output), ...hitTargets(options, input, output))
    state.invalid = false
  })()
  await state.pending
}

export async function renderSvgElementOutput(element: HTMLElement, pixelWidth: number, pixelHeight: number, thermal: boolean): Promise<SvgOutput> {
  const state = contexts.get(element)
  if (!state) throw new LabelOutputAssetError('Shared label context is unavailable')
  await state.pending
  if (contexts.get(element) !== state || contexts.get(state.owner) !== state || state.invalid || !state.runtime || state.owner.querySelector('[data-label-composing]')) throw new LabelOutputAssetError(element.dataset.labelOutputError || 'Label changed or could not be rendered')
  return renderSvgLabelPng({ ...state.input, pixelWidth, pixelHeight, thermal }, state.runtime)
}

/** A sheet preview is a snapshot, not a new layout or independently editable design. */
export function bindSvgClone(source: HTMLElement, clone: HTMLElement) {
  const state = contexts.get(source)
  if (state) contexts.set(clone, state)
}

/** Prepare print-grade images before the final output clone/page composition. */
export async function prepareSvgPrintImages(roots: HTMLElement[], dpi: number) {
  const labels = roots.flatMap(root => [
    ...(root.hasAttribute('data-label-svg') ? [root] : []),
    ...root.querySelectorAll<HTMLElement>('[data-label-svg]'),
  ])
  const rendered = new Map<Context, string>()
  const pending: Array<{ label: HTMLElement; state: Context; url: string }> = []
  let pixels = 0
  for (const label of labels) {
    const state = contexts.get(label)
    if (!state) throw new LabelOutputAssetError('Shared label context is unavailable')
    let url = rendered.get(state)
    if (!url) {
      const dimensions = state.input.preset.design.label
      assertLabelRasterBudget(dimensions)
      const width = Math.round(dimensions.widthMm * dpi / 25.4), height = Math.round(dimensions.heightMm * dpi / 25.4)
      pixels += width * height
      if (pixels > MAX_BATCH_RASTER_PIXELS) throw new LabelRasterBudgetError('batch', 'This batch is too large to export safely')
      url = pngDataUrl((await renderSvgElementOutput(label, width, height, false)).png)
      rendered.set(state, url)
    }
    pending.push({ label, state, url })
  }
  if (pending.some(({ label, state }) => contexts.get(label) !== state || contexts.get(state.owner) !== state || state.invalid)) throw new LabelOutputAssetError('Label changed during output preparation')
  for (const { label, url } of pending) {
    const image = label.querySelector<HTMLImageElement>('[data-label-svg-raster]')
    if (!image) throw new LabelOutputAssetError('Shared label raster is unavailable')
    image.src = url
  }
}

/** Repaint the shared raster during a gesture without replacing its live handles. */
export function redrawSvgGesture(root: HTMLElement, design: LabelDesignV2) {
  const state = contexts.get(root)
  if (!state?.runtime) return
  state.input.preset.design = normalizeLabelDesign(design)
  state.invalid = true
  if (state.frame !== undefined) return
  state.frame = requestAnimationFrame(() => {
    state.frame = undefined
    if (contexts.get(root) !== state) return
    try {
      const output = renderSvgLabelPng(state.input, state.runtime)
      root.querySelector('[data-label-svg-raster]')?.replaceWith(rasterNode(output))
      root.removeAttribute('data-label-output-error')
      state.invalid = false
    } catch (error) {
      root.dataset.labelOutputError = error instanceof Error ? error.message : 'Label could not be rendered'
    }
  })
}
