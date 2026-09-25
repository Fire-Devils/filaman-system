import type { LabelDesignElement, LabelDesignV2 } from './types'
import { clampElementPosition, clampFinite, getElementMinimumSize, isProportionalElement } from './geometry'
import { snapElementGeometry, type SnapGuide, type SnapOperation } from './snapping'

type InteractionEvent = {
  dx?: number
  dy?: number
  rect?: { width: number; height: number }
  deltaRect?: { left?: number; top?: number }
  edges?: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }
  altKey?: boolean
}

interface InteractionOptions {
  listeners: {
    start: (event: InteractionEvent) => void
    move: (event: InteractionEvent) => void
    end: (event: InteractionEvent) => void
  }
  edges?: Record<'left' | 'right' | 'top' | 'bottom', boolean | HTMLElement | string>
  ignoreFrom?: string
  inertia?: boolean
  margin?: number
}

interface Interactable {
  draggable(options: InteractionOptions): Interactable
  resizable(options: InteractionOptions): Interactable
  unset(): void
}

export type InteractFactory = (target: HTMLElement) => Interactable

export interface LabelGeometry {
  x: number
  y: number
  w: number
  h: number
}

export interface BindLabelInteractionsOptions {
  root: HTMLElement
  getDesign: () => LabelDesignV2
  getSelectedId?: () => string | null
  getLabel?: () => LabelDesignV2['label']
  getElement?: (elementId: string) => LabelDesignElement | null
  getMaxZ?: () => number
  editable: boolean
  onSelect: (elementId: string) => void
  onGeometryChange: (elementId: string, geometry: LabelGeometry) => void
  onGestureStart?: (elementId: string) => void
  onGestureEnd?: (elementId: string) => void
  loadInteract?: () => Promise<InteractFactory>
  shouldInitialize?: () => boolean
}

export interface LabelInteractionController {
  refresh(): void
  syncSelection(): void
  destroy(): void
}

const inactiveController: LabelInteractionController = { refresh() {}, syncSelection() {}, destroy() {} }

const roundMm = (value: number) => Math.round(value * 1000) / 1000
const roundPositiveMm = (value: number) => {
  const rounded = roundMm(value)
  return value > 0 && rounded === 0 ? value : rounded
}
const RESIZE_EDGE_MARGIN_PX = 3
const MINIMUM_MOVE_TARGET_PX = 8
const LINE_ENDPOINT_HIT_PX = 14
const LINE_ENDPOINT_DOT_PX = 5
const LINE_ENDPOINT_SELECTOR = '[data-label-line-end]'
const FRAME_HANDLE_SELECTOR = '[data-label-selection-handle]'
const FRAME_CORNER_SELECTOR = '[data-label-selection-corner]'
const SNAP_DISTANCE_PX = 6
const SNAP_GUIDE_SELECTOR = '[data-label-snap-guide]'

function geometryOf(element: LabelDesignElement): LabelGeometry {
  return { x: element.x, y: element.y, w: element.w, h: element.h }
}

function addGeometry(left: LabelGeometry, right: LabelGeometry): LabelGeometry {
  return { x: left.x + right.x, y: left.y + right.y, w: left.w + right.w, h: left.h + right.h }
}

function subtractGeometry(left: LabelGeometry, right: LabelGeometry): LabelGeometry {
  return { x: left.x - right.x, y: left.y - right.y, w: left.w - right.w, h: left.h - right.h }
}

function renderedGeometryOf(node: HTMLElement, fallback: LabelGeometry): LabelGeometry {
  const value = (raw: string, otherwise: number) => {
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : otherwise
  }
  return {
    x: value(node.style.left, fallback.x),
    y: value(node.style.top, fallback.y),
    w: value(node.style.width, fallback.w),
    h: value(node.style.height, fallback.h),
  }
}

function resizesHorizontally(element: LabelDesignElement): boolean {
  return element.type === 'shape' && element.shape === 'line'
}

async function loadInteractJs(): Promise<InteractFactory> {
  const module = await import('interactjs')
  return module.default as unknown as InteractFactory
}

export async function bindLabelInteractions(
  options: BindLabelInteractionsOptions,
): Promise<LabelInteractionController> {
  if (!options.editable) return inactiveController

  const interact = await (options.loadInteract ?? loadInteractJs)()
  // A stale binder must not touch shared interact.js targets, even to tear them down.
  if (options.shouldInitialize?.() === false) return inactiveController
  let interactables: Interactable[] = []
  let destroyed = false
  let geometry = new Map<string, LabelGeometry>()
  let renderedOffset = new Map<string, LabelGeometry>()
  let localSelectedId: string | null = null
  let frame: HTMLElement | null = null
  let framedNode: HTMLElement | null = null
  let frameInteraction: Interactable | null = null
  let gestureId: string | null = null
  let gestureNode: HTMLElement | null = null
  let rawGesture: { id: string; geometry: LabelGeometry } | null = null

  const clearSnapGuides = () => {
    options.root.querySelectorAll(SNAP_GUIDE_SELECTOR).forEach(guide => guide.remove())
  }

  const finishGesture = () => {
    const id = gestureId
    gestureId = null
    gestureNode = null
    rawGesture = null
    clearSnapGuides()
    if (id) options.onGestureEnd?.(id)
  }

  const getLabel = () => options.getLabel?.() ?? options.getDesign().label
  const pxPerMm = (label = getLabel()) => {
    const widthPx = options.root.getBoundingClientRect().width
    const widthMm = label.widthMm
    return widthPx > 0 && widthMm > 0 ? widthPx / widthMm : 96 / 25.4
  }
  const storeRawGesture = (
    id: string,
    next: LabelGeometry,
    label: LabelDesignV2['label'],
  ) => {
    const offset = renderedOffset.get(id) ?? { x: 0, y: 0, w: 0, h: 0 }
    const displayed = addGeometry(next, offset)
    const boundedDisplayed = { ...displayed, ...clampElementPosition(displayed, label) }
    rawGesture = { id, geometry: subtractGeometry(boundedDisplayed, offset) }
    return next
  }

  const selectFromEvent = (event: Event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-label-element-id]')
      : null
    if (target?.dataset.labelElementId) {
      localSelectedId = target.dataset.labelElementId
      options.onSelect(target.dataset.labelElementId)
      syncSelection()
    }
  }
  options.root.addEventListener('click', selectFromEvent)

  const positionLineHandles = (node: HTMLElement, widthMm: number, scale = pxPerMm()) => {
    const hitMm = LINE_ENDPOINT_HIT_PX / scale
    // Keep the middle available for moving, even when a line is shorter than its handles.
    const insetMm = Math.max(0, Math.min(LINE_ENDPOINT_HIT_PX / 2, (widthMm * scale - MINIMUM_MOVE_TARGET_PX) / 2)) / scale
    for (const handle of node.querySelectorAll<HTMLElement>(LINE_ENDPOINT_SELECTOR)) {
      handle.style.width = `${hitMm}mm`
      handle.style.height = `${hitMm}mm`
      handle.style.setProperty('--line-endpoint-dot', `${LINE_ENDPOINT_DOT_PX / scale}mm`)
      handle.style.setProperty('--line-endpoint-inset', `${insetMm}mm`)
      if (handle.dataset.labelLineEnd === 'left') handle.style.left = `${insetMm - hitMm}mm`
      else handle.style.right = `${insetMm - hitMm}mm`
    }
  }

  const addLineHandle = (node: HTMLElement, side: 'left' | 'right') => {
    const handle = document.createElement('span')
    handle.dataset.labelLineEnd = side
    handle.dataset.labelEditorChrome = ''
    handle.dataset.editorHandle = ''
    handle.setAttribute('aria-hidden', 'true')
    node.append(handle)
    return handle
  }

  const showSnapGuides = (guides: SnapGuide[], label: LabelDesignV2['label'], scale: number) => {
    clearSnapGuides()
    if (guides.length === 0) return
    const artworkZ = [...options.root.querySelectorAll<HTMLElement>('[data-label-element-id]')]
      .map(artwork => Number(artwork.style.zIndex) || 0)
    const zIndex = String(Math.max(0, ...artworkZ) + 3)
    for (const guide of guides) {
      const node = document.createElement('div')
      node.dataset.labelEditorChrome = ''
      node.dataset.labelSnapGuide = guide.axis
      node.setAttribute('aria-hidden', 'true')
      Object.assign(node.style, {
        position: 'absolute',
        pointerEvents: 'none',
        background: 'var(--accent)',
        boxShadow: '0 0 3px color-mix(in srgb, var(--accent) 75%, transparent)',
        opacity: '0.9',
        zIndex,
        ...(guide.axis === 'x'
          ? { left: `${guide.value}mm`, top: '0', width: `${1 / scale}mm`, height: `${label.heightMm}mm`, transform: `translateX(${-0.5 / scale}mm)` }
          : { left: '0', top: `${guide.value}mm`, width: `${label.widthMm}mm`, height: `${1 / scale}mm`, transform: `translateY(${-0.5 / scale}mm)` }),
      })
      options.root.append(node)
    }
  }

  const guidesMatching = (box: LabelGeometry, guides: SnapGuide[]) => guides.filter(guide => {
    const value = guide.axis === 'x'
      ? (guide.edge === 'start' ? box.x : box.x + box.w)
      : (guide.edge === 'start' ? box.y : box.y + box.h)
    return Math.abs(value - guide.value) < 1e-9
  })

  const commitGeometry = (
    node: HTMLElement,
    element: LabelDesignElement,
    next: LabelGeometry,
    label: LabelDesignV2['label'],
    scale: number,
    operation: SnapOperation,
    bypassSnap: boolean,
  ) => {
    const id = element.id
    const offset = renderedOffset.get(id) ?? { x: 0, y: 0, w: 0, h: 0 }
    const rounded = {
      x: roundMm(next.x),
      y: roundMm(next.y),
      w: roundPositiveMm(next.w),
      h: roundPositiveMm(next.h),
    }
    const displayed = addGeometry(rounded, offset)
    const displayedOperation = operation.type === 'move' ? operation : {
      ...operation,
      minimumWidth: operation.minimumWidth + offset.w,
      minimumHeight: operation.minimumHeight + offset.h,
      maximumWidth: operation.maximumWidth + offset.w,
      maximumHeight: operation.maximumHeight + offset.h,
    }
    const snapped = bypassSnap
      ? { geometry: displayed, guides: [] }
      : snapElementGeometry(displayed, label, SNAP_DISTANCE_PX / scale, displayedOperation)
    const committedDisplayed = { ...snapped.geometry, ...clampElementPosition(snapped.geometry, label) }
    const committed = subtractGeometry(committedDisplayed, offset)
    showSnapGuides(guidesMatching(committedDisplayed, snapped.guides), label, scale)
    geometry.set(id, committed)
    node.style.left = `${committedDisplayed.x}mm`
    node.style.top = `${committedDisplayed.y}mm`
    node.style.width = `${committedDisplayed.w}mm`
    node.style.height = `${committedDisplayed.h}mm`
    if (resizesHorizontally(element)) positionLineHandles(node, committedDisplayed.w, scale)
    if (frame?.dataset.labelSelectionFor === id) positionFrame(committedDisplayed, scale)
    options.onGeometryChange(id, { ...committed })
  }

  const gestureListeners = (node: HTMLElement, element: LabelDesignElement, resize: boolean) => ({
    start: () => {
      if (destroyed) return
      gestureId = element.id
      gestureNode = node
      rawGesture = { id: element.id, geometry: geometry.get(element.id) ?? geometryOf(element) }
      clearSnapGuides()
      localSelectedId = element.id
      options.onSelect(element.id)
      options.onGestureStart?.(element.id)
    },
    move: (event: InteractionEvent) => {
      if (destroyed) return
      const current = geometry.get(element.id) ?? geometryOf(element)
      const rawCurrent = rawGesture?.id === element.id ? rawGesture.geometry : current
      const offset = renderedOffset.get(element.id) ?? { x: 0, y: 0, w: 0, h: 0 }
      const label = getLabel()
      const scale = pxPerMm(label)
      if (!resize) {
        const next = storeRawGesture(element.id, {
          ...rawCurrent,
          x: clampFinite(rawCurrent.x + Number(event.dx ?? 0) / scale, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, rawCurrent.x),
          y: clampFinite(rawCurrent.y + Number(event.dy ?? 0) / scale, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, rawCurrent.y),
        }, label)
        commitGeometry(node, element, next, label, scale, { type: 'move' }, Boolean(event.altKey))
        return
      }

      const measuredWidth = Number(event.rect?.width ?? current.w * scale) / scale
      const measuredHeight = Number(event.rect?.height ?? current.h * scale) / scale
      const width = measuredWidth - offset.w
      const height = measuredHeight - offset.h
      const edges = event.edges ?? {}
      if (resizesHorizontally(element)) {
        const minimum = getElementMinimumSize(element)
        const w = clampFinite(width, minimum, label.widthMm, rawCurrent.w)
        const x = edges.left ? rawCurrent.x + rawCurrent.w - w : rawCurrent.x
        const next = storeRawGesture(element.id, { ...rawCurrent, x, w }, label)
        commitGeometry(node, element, next, label, scale, {
          type: 'resize', edges, proportional: false,
          minimumWidth: minimum, minimumHeight: minimum,
          maximumWidth: label.widthMm, maximumHeight: label.heightMm,
        }, Boolean(event.altKey))
        return
      }

      if (isProportionalElement(element)) {
        const horizontal = edges.left || edges.right
        const vertical = edges.top || edges.bottom
        let size = horizontal && vertical ? Math.max(width, height) : horizontal ? width : height
        const minimum = getElementMinimumSize(element)
        const maximum = Math.min(label.widthMm, label.heightMm)
        size = clampFinite(size, minimum, maximum, rawCurrent.w)
        const right = rawCurrent.x + rawCurrent.w
        const bottom = rawCurrent.y + rawCurrent.h
        const next = storeRawGesture(element.id, {
          x: edges.left ? right - size : rawCurrent.x,
          y: edges.top ? bottom - size : rawCurrent.y,
          w: size,
          h: size,
        }, label)
        commitGeometry(node, element, next, label, scale, {
          type: 'resize', edges, proportional: true,
          minimumWidth: minimum, minimumHeight: minimum,
          maximumWidth: maximum, maximumHeight: maximum,
        }, Boolean(event.altKey))
        return
      }

      const minimum = getElementMinimumSize(element)
      const right = rawCurrent.x + rawCurrent.w
      const bottom = rawCurrent.y + rawCurrent.h
      const w = clampFinite(width, minimum, label.widthMm, rawCurrent.w)
      const h = clampFinite(height, minimum, label.heightMm, rawCurrent.h)
      const next = storeRawGesture(element.id, {
        x: edges.left ? right - w : rawCurrent.x,
        y: edges.top ? bottom - h : rawCurrent.y,
        w,
        h,
      }, label)
      commitGeometry(node, element, next, label, scale, {
        type: 'resize', edges, proportional: false,
        minimumWidth: minimum, minimumHeight: minimum,
        maximumWidth: label.widthMm, maximumHeight: label.heightMm,
      }, Boolean(event.altKey))
    },
    end: () => {
      if (destroyed) return
      finishGesture()
      syncSelection()
    },
  })

  const removeFrame = () => {
    frameInteraction?.unset()
    frameInteraction = null
    frame?.remove()
    frame = null
    framedNode?.removeAttribute('data-label-selection-framed')
    framedNode = null
  }

  const positionFrame = (box: LabelGeometry, scale = pxPerMm()) => {
    if (!frame) return
    Object.assign(frame.style, { left: `${box.x}mm`, top: `${box.y}mm`, width: `${box.w}mm`, height: `${box.h}mm` })
    frame.style.setProperty('--selection-outline', `${1.5 / scale}mm`)
    frame.style.setProperty('--selection-dot', `${LINE_ENDPOINT_DOT_PX / scale}mm`)
    const hit = LINE_ENDPOINT_HIT_PX / scale
    // Move tiny elements' corner hit areas outward, leaving the interior available for dragging.
    const insetX = Math.max(0, Math.min(LINE_ENDPOINT_HIT_PX / 2, (box.w * scale - MINIMUM_MOVE_TARGET_PX) / 2)) / scale
    const insetY = Math.max(0, Math.min(LINE_ENDPOINT_HIT_PX / 2, (box.h * scale - MINIMUM_MOVE_TARGET_PX) / 2)) / scale
    frame.style.setProperty('--selection-inset-x', `${insetX}mm`)
    frame.style.setProperty('--selection-inset-y', `${insetY}mm`)
    for (const handle of frame.querySelectorAll<HTMLElement>(FRAME_HANDLE_SELECTOR)) {
      const left = handle.hasAttribute('data-selection-left')
      const top = handle.hasAttribute('data-selection-top')
      if (handle.hasAttribute('data-label-selection-corner')) {
        handle.style.width = `${hit}mm`
        handle.style.height = `${hit}mm`
        handle.style[left ? 'left' : 'right'] = `${insetX - hit}mm`
        handle.style[top ? 'top' : 'bottom'] = `${insetY - hit}mm`
      } else {
        const horizontal = top || handle.hasAttribute('data-selection-bottom')
        const thickness = MINIMUM_MOVE_TARGET_PX / scale
        handle.style.width = horizontal ? '100%' : `${thickness}mm`
        handle.style.height = horizontal ? `${thickness}mm` : '100%'
        handle.style[horizontal ? (top ? 'top' : 'bottom') : (left ? 'left' : 'right')] = `${frame.hasAttribute('data-label-selection-text') ? -thickness : -thickness / 2}mm`
        handle.style[horizontal ? 'left' : 'top'] = '0'
      }
    }
  }

  const syncSelection = () => {
    if (destroyed) return
    const id = options.getSelectedId ? options.getSelectedId() : localSelectedId
    const element = id && (options.getElement
      ? options.getElement(id)
      : options.getDesign().elements.find(candidate => candidate.id === id))
    const node = [...options.root.querySelectorAll<HTMLElement>('[data-label-element-id]')].find(candidate => candidate.dataset.labelElementId === id)
    if (!element || !node || node.style.display === 'none' || resizesHorizontally(element)) {
      removeFrame()
      return
    }
    if (frame?.dataset.labelSelectionFor !== id || framedNode !== node || !frame.isConnected) {
      removeFrame()
      frame = document.createElement('div')
      frame.dataset.labelSelectionFor = element.id
      if (element.type === 'text') frame.dataset.labelSelectionText = ''
      frame.dataset.labelEditorChrome = ''
      frame.setAttribute('aria-hidden', 'true')
      framedNode = node
      node.dataset.labelSelectionFramed = ''
      for (const sides of [['left'], ['right'], ['top'], ['bottom'], ['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']]) {
        const handle = document.createElement('span')
        handle.dataset.labelSelectionHandle = ''
        for (const side of sides) handle.setAttribute(`data-selection-${side}`, '')
        if (sides.length === 2) handle.dataset.labelSelectionCorner = sides.join('-')
        else handle.dataset.labelSelectionEdge = sides[0]
        frame.append(handle)
      }
      options.root.append(frame)
      frameInteraction = interact(frame)
      frameInteraction.draggable({ listeners: gestureListeners(node, element, false), ignoreFrom: FRAME_CORNER_SELECTOR, inertia: false })
      frameInteraction.resizable({ listeners: gestureListeners(node, element, true), inertia: false,
        edges: { left: '[data-label-selection-corner][data-selection-left]', right: '[data-label-selection-corner][data-selection-right]', top: '[data-label-selection-corner][data-selection-top]', bottom: '[data-label-selection-corner][data-selection-bottom]' } })
    }
    // Editor chrome sits above artwork without altering the saved or rendered layer order.
    const artworkZ = [...options.root.querySelectorAll<HTMLElement>('[data-label-element-id]')].map(artwork => Number(artwork.style.zIndex) || 0)
    const maxZ = options.getMaxZ?.() ?? Math.max(0, ...options.getDesign().elements.map(artwork => artwork.z))
    frame.style.zIndex = String(Math.max(maxZ, ...artworkZ) + 2)
    const stored = geometry.get(element.id) ?? geometryOf(element)
    const offset = renderedOffset.get(element.id) ?? { x: 0, y: 0, w: 0, h: 0 }
    positionFrame({
      x: stored.x + offset.x,
      y: stored.y + offset.y,
      w: stored.w + offset.w,
      h: stored.h + offset.h,
    })
  }

  const teardownBindings = () => {
    clearSnapGuides()
    removeFrame()
    for (const interactable of interactables) interactable.unset()
    interactables = []
    options.root.querySelectorAll(LINE_ENDPOINT_SELECTOR).forEach(handle => handle.remove())
    for (const node of options.root.querySelectorAll<HTMLElement>('[data-label-interaction-bound]')) {
      node.removeAttribute('data-label-interaction-bound')
      node.style.removeProperty('cursor')
    }
  }

  const refresh = () => {
    if (destroyed) return
    clearSnapGuides()
    if (gestureId && gestureNode?.isConnected) {
      // Rebinding during pointer movement would interrupt interact.js's active gesture.
      syncSelection()
      return
    }
    finishGesture()
    teardownBindings()
    const design = options.getDesign()
    geometry = new Map(design.elements.map(element => [element.id, geometryOf(element)]))
    renderedOffset = new Map()
    for (const node of options.root.querySelectorAll<HTMLElement>('[data-label-element-id]')) {
      const id = node.dataset.labelElementId
      const element = design.elements.find(candidate => candidate.id === id)
      if (!element) continue
      if (node.style.display === 'none') continue
      const stored = geometryOf(element)
      const rendered = renderedGeometryOf(node, stored)
      renderedOffset.set(element.id, {
        x: rendered.x - stored.x,
        y: rendered.y - stored.y,
        w: rendered.w - stored.w,
        h: rendered.h - stored.h,
      })
      if (node.hasAttribute('data-label-text-editing')) continue
      node.setAttribute('data-label-interaction-bound', '')
      node.style.cursor = 'move'
      const line = element.type === 'shape' && element.shape === 'line'
      const lineEdges = line ? {
        left: addLineHandle(node, 'left'),
        right: addLineHandle(node, 'right'),
        top: false,
        bottom: false,
      } : null
      if (line) positionLineHandles(node, element.w)
      const interactable = interact(node)
      interactable.draggable({
        listeners: gestureListeners(node, element, false),
        inertia: false,
        ...(line ? { ignoreFrom: LINE_ENDPOINT_SELECTOR } : {}),
      })
      if (lineEdges) {
        interactable.resizable({
          edges: lineEdges,
          listeners: gestureListeners(node, element, true),
          inertia: false,
          margin: RESIZE_EDGE_MARGIN_PX,
        })
      }
      interactables.push(interactable)
    }
    syncSelection()
  }

  refresh()
  return {
    refresh,
    syncSelection,
    destroy() {
      if (destroyed) return
      destroyed = true
      finishGesture()
      options.root.removeEventListener('click', selectFromEvent)
      teardownBindings()
    },
  }
}
