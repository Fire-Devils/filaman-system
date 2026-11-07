import wasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url'
import { createSvgRuntime } from './runtime.mjs'
import { renderSvgLabelLayout, renderSvgLabelPng } from './core.mjs'
import type { SvgInput, SvgOutput, SvgLayoutOutput, SvgRuntime, SvgBox } from './types'
import { loadPreparedImage, clearPreparedImages } from './images'
import type { RenderDesignerLabelOptions } from '../label-designer'
import type { LabelDesignV2 } from '../freeform-label/types'
import { normalizeLabelDesign } from '../freeform-label/normalize'
import { renderEditableText } from '../freeform-label/editable-text'
import { LabelOutputAssetError } from '../label-output-readiness'
import { assertLabelRasterBudget, LabelRasterBudgetError, MAX_BATCH_RASTER_PIXELS, LABEL_EXPORT_CSS_DPI } from '../label-export'

const fontUrls = import.meta.glob<string>('/node_modules/@fontsource/*/files/*-latin-*-normal.woff2', { query: '?url', import: 'default', eager: true })
const contexts = new WeakMap<HTMLElement, Context>()
const previewUrls = new WeakMap<HTMLElement, string>()
interface Context {
  owner: HTMLElement
  input: SvgInput
  runtime?: SvgRuntime
  pending: Promise<void>
  invalid: boolean
  frame?: number
}

/** Standard and designer previews reuse a root; invalidate its old raster job too. */
export function clearSvgDesignerLabel(root: HTMLElement) {
  const state = contexts.get(root)
  if (state?.frame !== undefined) cancelAnimationFrame(state.frame)
  contexts.delete(root)
  releasePreviewUrl(root)
  if (state) clearPreparedImages()
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

function releasePreviewUrl(root: HTMLElement) {
  const url = previewUrls.get(root)
  if (url) URL.revokeObjectURL(url)
  previewUrls.delete(root)
}

function previewNode(root: HTMLElement, output: SvgLayoutOutput | SvgOutput) {
  const image = document.createElement('img')
  image.dataset.labelSvgRaster = ''
  releasePreviewUrl(root)
  if ('png' in output) image.src = pngDataUrl(output.png)
  else {
    const url = URL.createObjectURL(new Blob([output.svg], { type: 'image/svg+xml' }))
    previewUrls.set(root, url)
    image.src = url
  }
  image.alt = ''
  image.draggable = false
  Object.assign(image.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' })
  return image
}

function showElementWarning(node: HTMLElement, error?: string) {
  node.querySelector('[data-label-fit-warning]')?.remove()
  node.style.outline = error ? '1px solid #b91c1c' : ''
  if (!error) {
    node.removeAttribute('data-label-output-error')
    node.removeAttribute('aria-invalid')
    node.removeAttribute('title')
    return
  }
  node.dataset.labelOutputError = error
  node.setAttribute('aria-invalid', 'true')
  node.title = error
  const warning = document.createElement('span')
  warning.dataset.labelFitWarning = ''
  warning.setAttribute('role', 'alert')
  warning.textContent = error
  warning.style.cssText = 'position:absolute;bottom:0;left:0;max-width:100%;background:#fff;color:#b91c1c;font:10px/1.2 sans-serif;pointer-events:none'
  node.append(warning)
}

function hitTargets(options: RenderDesignerLabelOptions, input: SvgInput, output?: SvgLayoutOutput) {
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
      renderEditableText(node, { ...element, fontSizeMm: text?.size ?? element.fontSizeMm }, input.data)
      const content = node.firstElementChild as HTMLElement | null
      if (content) content.style.visibility = 'hidden'
      showElementWarning(node, text?.error)
    }
    const qr = output?.qrs.find((row: { id: string }) => row.id === element.id)
    if (qr) node.dataset.qrModuleCount = String(qr.modules)
    if (qr) showElementWarning(node, qr.error)
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
  const previewDpi = options.interactive ? LABEL_EXPORT_CSS_DPI : 300
  const input: SvgInput = { preset: { version: 2, design }, data: structuredClone(options.data), assets: {},
    origin: location.origin, entityPath: options.entityPath === 'filaments' ? 'filaments' : 'spools',
    pixelWidth: Math.round(design.label.widthMm * previewDpi / 25.4), pixelHeight: Math.round(design.label.heightMm * previewDpi / 25.4), thermal: false }
  const state: Context = { owner: root, input, invalid: true, pending: Promise.resolve() }
  contexts.set(root, state)
  const current = () => contexts.get(root) === state && !options.isStale?.()
  state.pending = (async () => {
    let output: SvgLayoutOutput | SvgOutput | undefined, error: unknown
    try {
      const assetIds = [...new Set(design.elements.filter(e => e.type === 'image').map(e => e.assetId))]
      await Promise.all(assetIds.map(async id => {
        const url = await options.resolveAssetUrl?.(id)
        if (!current()) return
        if (!url) throw new Error('Label image is unavailable')
        input.assets[id] = await loadPreparedImage(url)
      }))
      if (!current()) return
      if (options.logoUrl && design.elements.some(e => e.type === 'manufacturerLogo')) input.assets.logo = await loadPreparedImage(options.logoUrl)
      if (!current()) return
      if (!input.thermal && design.elements.some(e => e.type === 'qr' && e.mode === 'colorLogo')) input.assets.qrLogo = await loadPreparedImage('/logo-qr.png')
      if (!current()) return
      state.runtime = await runtime()
      if (!current()) return
      output = options.interactive
        ? renderSvgLabelLayout({ ...input, preview: true }, state.runtime)
        : renderSvgLabelPng(input, state.runtime)
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
      releasePreviewUrl(root)
      root.dataset.labelOutputError = error instanceof Error ? error.message : 'Label could not be rendered'
      const message = document.createElement('div')
      message.setAttribute('role', 'alert')
      message.textContent = root.dataset.labelOutputError
      message.style.cssText = 'font:12px sans-serif;color:#b91c1c;pointer-events:none'
      root.replaceChildren(message, ...hitTargets(options, input))
      return
    }
    root.removeAttribute('data-label-output-error')
    root.replaceChildren(previewNode(root, output), ...hitTargets(options, input, output))
    state.invalid = output.text.some(row => row.error) || output.qrs.some(row => row.error)
  })()
  await state.pending
}

export async function renderSvgElementOutput(element: HTMLElement, pixelWidth: number, pixelHeight: number, thermal: boolean): Promise<SvgOutput> {
  const state = contexts.get(element)
  if (!state) throw new LabelOutputAssetError('Shared label context is unavailable')
  await state.pending
  if (contexts.get(element) !== state || contexts.get(state.owner) !== state || state.invalid || !state.runtime || state.owner.querySelector('[data-label-composing]')) throw new LabelOutputAssetError(element.dataset.labelOutputError || state.owner.querySelector<HTMLElement>('[data-label-output-error]')?.dataset.labelOutputError || 'Label changed or could not be rendered')
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
    releasePreviewUrl(label)
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
      const input = state.input
      const output = renderSvgLabelLayout({ ...input, preview: true }, state.runtime)
      root.querySelector('[data-label-svg-raster]')?.replaceWith(previewNode(root, output))
      root.removeAttribute('data-label-output-error')
      for (const node of root.querySelectorAll<HTMLElement>('[data-label-svg-target]')) {
        showElementWarning(node, output.text.find(row => row.id === node.dataset.labelElementId)?.error
          ?? output.qrs.find(row => row.id === node.dataset.labelElementId)?.error)
      }
      state.invalid = output.text.some(row => row.error) || output.qrs.some(row => row.error)
    } catch (error) {
      root.dataset.labelOutputError = error instanceof Error ? error.message : 'Label could not be rendered'
    }
  })
}
