import { createDefaultLabelDesign } from './defaults'
import { createLabelHistory } from './history'
import { normalizeElement, normalizeLabelDesign, parseLabelElementJson } from './normalize'
import { wrapTemplateToken } from './text-modifiers'
import { replaceTemplateRange } from './template-selection'
import { localizedErrorMessage } from './editor-types'
import { clampElementPosition, isProportionalElement } from './geometry'
import { createLabelElementId } from './id'
import type {
  FreeformEditorOptions,
  FreeformEditorState,
  JsonApplyResult,
  LabelAssetMetadata,
  LabelFieldModifier,
} from './editor-types'
import type {
  LabelDesignElement,
  LabelDesignV2,
  LabelElementType,
  LabelImageElement,
  LabelShape,
  LabelShapeElement,
  LabelTextElement,
} from './types'

const jsonErrorKeys = new Map<string, string>([
  ['Element JSON must be valid JSON', 'labelDesigner.jsonInvalid'],
  ['Element JSON must contain an object', 'labelDesigner.jsonMustBeObject'],
  ['Element id cannot be changed', 'labelDesigner.jsonIdImmutable'],
  ['Element type cannot be changed', 'labelDesigner.jsonTypeImmutable'],
  ['Element type is not supported', 'labelDesigner.jsonUnsupportedType'],
])

function nextZ(design: LabelDesignV2) {
  return design.elements.length
}

function createElement(
  type: LabelElementType,
  design: LabelDesignV2,
  id: string,
  shape: LabelShape = 'rectangle',
): LabelDesignElement {
  const z = nextZ(design)
  const center = (w: number, h: number) => ({
    x: Math.max(0, (design.label.widthMm - w) / 2),
    y: Math.max(0, (design.label.heightMm - h) / 2),
    w: Math.min(w, design.label.widthMm),
    h: Math.min(h, design.label.heightMm),
  })
  switch (type) {
    case 'text':
      return {
        id,
        type,
        ...center(28, 8),
        z,
        template: 'Text',
        fontFamily: 'Space Grotesk',
        fontSizeMm: 3.2,
        fontWeight: 600,
        italic: false,
        underline: false,
        align: 'left',
        color: '#000000',
        wrap: true,
      }
    case 'qr':
      return {
        id,
        type,
        ...center(18, 18),
        z,
        mode: 'logo',
        linkMode: 'spool',
        urlTemplate: '',
      }
    case 'manufacturerLogo':
      return { id, type, ...center(25, 6), z, objectFit: 'contain', align: 'center' }
    case 'image':
      return { id, type, ...center(20, 12), z, assetId: '', objectFit: 'contain' }
    case 'swatch':
      return { id, type, ...center(30, 6), z, radiusMm: 1 }
    case 'shape':
      return {
        id,
        type,
        ...center(shape === 'line' ? 25 : shape === 'rectangle' ? 20 : 15, shape === 'line' ? 0.3 : shape === 'rectangle' ? 10 : 15),
        z,
        shape,
        fill: '',
        stroke: '#000000',
        strokeWidthMm: 0.3,
        radiusMm: 0,
      }
  }
}

export function createFreeformEditorController(
  options: FreeformEditorOptions = {},
) {
  const translate = options.translate ?? ((_key: string, fallback: string) => fallback)
  const createId = options.createId ?? createLabelElementId
  let design = normalizeLabelDesign(
    options.initialDesign ?? createDefaultLabelDesign(options.kind ?? 'spool', createId),
    { createId },
  )
  let selectedId: string | null = design.elements[0]?.id ?? null
  let assets: LabelAssetMetadata[] = []
  let pendingAssetLoads = 0
  const assetMutations = new Set<string>()
  const pendingAssetDeletes = new Set<string>()
  const referencesDeletingAsset = (elements: LabelDesignElement[]) => elements.some(
    element => element.type === 'image' && pendingAssetDeletes.has(element.assetId),
  )
  const deletionPendingMessage = () => translate(
    'labelDesigner.imageDeletionPending',
    'This image is being deleted. Wait for deletion to finish.',
  )
  let assetError: string | null = null
  let destroyed = false
  const pendingImageUploads = new Map<string, { assetId: string }>()
  let templateSelection = { start: 0, end: 0 }
  // Explicit model replacements also invalidate uncommitted inspector drafts.
  let replacementVersion = 0
  const snapshot = () => ({ design, selectedId, templateSelection })
  const history = createLabelHistory(snapshot())
  const setTemplateSelection = (start: number, end = start) => {
    templateSelection = { start: Math.max(0, start), end: Math.max(0, end) }
    // Selection changes amend metadata without another design copy or undo step.
    history.amend({ selectedId, templateSelection })
  }
  // History already owns the committed snapshot. Accumulate live movement here
  // without copying the design into history or notifying persistence per move.
  let gestureActive = false
  let gestureChanged = false
  let notificationPending = false

  const getState = (): FreeformEditorState => ({
    design: structuredClone(design),
    selectedId,
    assets: structuredClone(assets),
    assetsLoading: pendingAssetLoads > 0,
    assetError,
    destroyed,
  })

  const publish = () => {
    if (gestureActive) {
      // Async assets/render completions must respect the same commit boundary.
      notificationPending = true
      return
    }
    if (!destroyed) options.onChange?.(getState())
  }

  const endGesture = () => {
    if (!gestureActive) return false
    gestureActive = false
    const changed = gestureChanged
    const shouldPublish = gestureChanged || notificationPending
    if (gestureChanged) history.push(snapshot())
    gestureChanged = false
    notificationPending = false
    if (shouldPublish) publish()
    return changed
  }

  const commitDesign = (next: LabelDesignV2, nextSelectedId: string | null = selectedId, nextRange = templateSelection) => {
    const normalized = normalizeLabelDesign(next, { createId })
    if (referencesDeletingAsset(normalized.elements)) return false
    endGesture()
    const resolvedSelection = nextSelectedId && normalized.elements.some(element => element.id === nextSelectedId)
      ? nextSelectedId
      : normalized.elements.at(-1)?.id ?? null
    if (JSON.stringify(normalized) === JSON.stringify(design) && resolvedSelection === selectedId) {
      setTemplateSelection(nextRange.start, nextRange.end)
      return false
    }
    for (const [id, request] of pendingImageUploads) {
      const element = normalized.elements.find(element => element.id === id)
      if (element?.type !== 'image' || element.assetId !== request.assetId) pendingImageUploads.delete(id)
    }
    design = normalized
    selectedId = resolvedSelection
    templateSelection = { start: nextRange.start, end: nextRange.end }
    history.push(snapshot())
    publish()
    return true
  }

  const getSelectedElement = () => (
    design.elements.find(element => element.id === selectedId) ?? null
  )

  const select = (elementId: string | null) => {
    if (elementId !== selectedId) endGesture()
    selectedId = elementId && design.elements.some(element => element.id === elementId)
      ? elementId
      : null
    setTemplateSelection(0)
    publish()
    return getSelectedElement()
  }

  const addElement = (type: LabelElementType, shape: LabelShape = 'rectangle') => {
    const element = createElement(type, design, createId(), shape)
    commitDesign({ ...design, elements: [...design.elements, element] }, element.id)
    return structuredClone(getSelectedElement()!)
  }

  const updateElement = (elementId: string, changes: Partial<LabelDesignElement>, nextRange = templateSelection) => {
    if (!design.elements.some(element => element.id === elementId)) return null
    const nextElements = design.elements.map(element => {
      if (element.id !== elementId) return element
      const dimensions = isProportionalElement(element) && changes.h !== undefined && changes.w === undefined ? { w: changes.h } : {}
      const strokeChanges: Partial<LabelShapeElement> = {}
      if (element.type === 'shape' && 'strokeWidthMm' in changes && typeof changes.strokeWidthMm === 'number' && Number.isFinite(changes.strokeWidthMm)) {
        const thickness = Math.min(10, Math.max(0, changes.strokeWidthMm))
        if (thickness > 0 && !element.stroke) strokeChanges.stroke = '#000000'
        if (element.shape === 'line') {
          strokeChanges.h = Math.max(0.1, thickness)
          strokeChanges.y = element.y + (element.h - strokeChanges.h) / 2
        }
      }
      const cropChanges = element.type === 'image' && 'assetId' in changes && changes.assetId !== element.assetId ? { crop: undefined } : {}
      const logoSizeChanges = element.type === 'manufacturerLogo' && !('manualSizeMm' in changes)
        && (changes.w !== undefined && changes.w !== element.w || changes.h !== undefined && changes.h !== element.h)
        ? { manualSizeMm: undefined } : {}
      return { ...element, ...changes, ...dimensions, ...strokeChanges, ...cropChanges, ...logoSizeChanges, id: element.id, type: element.type } as LabelDesignElement
    })
    if (!commitDesign({ ...design, elements: nextElements }, selectedId, nextRange)) return null
    return getSelectedElement()
  }

  const updateSelected = (changes: Partial<LabelDesignElement>, nextRange = templateSelection) => {
    if (!selectedId) return null
    return updateElement(selectedId, changes, nextRange)
  }

  const deleteSelected = () => {
    if (!selectedId) return false
    const index = design.elements.findIndex(element => element.id === selectedId)
    if (index < 0) return false
    const elements = design.elements.filter(element => element.id !== selectedId)
    selectedId = elements[Math.min(index, elements.length - 1)]?.id ?? null
    commitDesign({ ...design, elements })
    return true
  }

  const pasteElement = (source: Record<string, unknown>) => {
    const selected = normalizeElement(source, design.label, nextZ(design))
    if (!selected) return null
    const position = clampElementPosition({
      x: selected.x + 2,
      y: selected.y + 2,
      w: selected.w,
      h: selected.h,
    }, design.label)
    const copy = {
      ...structuredClone(selected),
      id: createId(),
      ...position,
      z: nextZ(design),
    } as LabelDesignElement
    if (!commitDesign({ ...design, elements: [...design.elements, copy] }, copy.id)) return null
    return structuredClone(getSelectedElement()!)
  }

  const duplicateSelected = () => {
    const selected = getSelectedElement()
    return selected ? pasteElement({ ...selected }) : null
  }

  const moveSelected = (direction: 'forward' | 'back' | 'front' | 'backmost') => {
    if (!selectedId) return false
    const elements = [...design.elements]
    const index = elements.findIndex(element => element.id === selectedId)
    if (index < 0) return false
    const target = direction === 'front'
      ? elements.length - 1
      : direction === 'backmost'
        ? 0
        : direction === 'forward'
          ? Math.min(elements.length - 1, index + 1)
          : Math.max(0, index - 1)
    if (target === index) return false
    const [element] = elements.splice(index, 1)
    elements.splice(target, 0, element)
    commitDesign({ ...design, elements })
    return true
  }

  const nudgeSelected = (dx: number, dy: number) => {
    const selected = getSelectedElement()
    if (!selected) return null
    return updateSelected({ x: selected.x + dx, y: selected.y + dy })
  }

  const getSelectedJson = () => {
    const selected = getSelectedElement()
    return selected ? JSON.stringify(selected, null, 2) : ''
  }

  const applySelectedJson = (source: string): JsonApplyResult => {
    const selected = getSelectedElement()
    if (!selected) return { ok: false, error: translate('labelDesigner.selectElementFirst', 'Select an element first') }
    try {
      const next = parseLabelElementJson(source, selected, design.label)
      if (referencesDeletingAsset([next])) return { ok: false, error: deletionPendingMessage() }
      commitDesign({ ...design, elements: design.elements.map(element => element.id === selected.id ? next : element) })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? translate(jsonErrorKeys.get(error.message) ?? 'labelDesigner.jsonInvalid', error.message)
          : translate('labelDesigner.jsonInvalid', 'Element JSON is invalid'),
      }
    }
  }

  const insertField = (token: string, modifier?: LabelFieldModifier | null) => {
    const inserted = wrapTemplateToken(token, modifier)
    let selected = getSelectedElement()
    if (selected?.type !== 'text') {
      selected = {
        ...createElement('text', design, createId()),
        template: inserted,
      } as LabelTextElement
      commitDesign({ ...design, elements: [...design.elements, selected] }, selected.id)
      return structuredClone(getSelectedElement() as LabelTextElement)
    }
    const start = Math.min(templateSelection.start, selected.template.length)
    const end = Math.min(Math.max(templateSelection.end, start), selected.template.length)
    const result = replaceTemplateRange(selected.template, start, end, inserted)
    if (result.template.length <= 8000) updateSelected({ template: result.template }, result)
    return structuredClone(getSelectedElement() as LabelTextElement)
  }

  const loadAssets = async () => {
    if (!options.assets) return []
    pendingAssetLoads++
    assetError = null
    publish()
    try {
      const listed = await options.assets.list()
      // A response started before an upload/delete cannot undo that mutation.
      assets = [...assets.filter(asset => assetMutations.has(asset.id)), ...listed.filter(asset => !assetMutations.has(asset.id))]
      return structuredClone(assets)
    } catch (error) {
      assetError = localizedErrorMessage(
        error,
        translate,
        'labelDesigner.imageLoadFailed',
        'Could not load label images',
      )
      throw error
    } finally {
      if (--pendingAssetLoads === 0) assetMutations.clear()
      publish()
    }
  }

  const uploadAsset = async (file: File) => {
    if (!options.assets) throw new Error(translate('labelDesigner.imageUploadUnavailable', 'Label image uploads are unavailable'))
    const asset = await options.assets.upload(file)
    if (pendingAssetLoads) assetMutations.add(asset.id)
    assets = [asset, ...assets.filter(candidate => candidate.id !== asset.id)]
    assetError = null
    publish()
    return structuredClone(asset)
  }

  const deleteAsset = async (assetId: string) => {
    if (!options.assets) throw new Error(translate('labelDesigner.imageDeleteUnavailable', 'Label image deletion is unavailable'))
    if (design.elements.some(element => element.type === 'image' && element.assetId === assetId)) {
      throw new Error(translate(
        'labelDesigner.imageUsedByCurrentDesign',
        'This image is used by the current label. Remove its image element before deleting the file.',
      ))
    }
    if (pendingAssetDeletes.has(assetId)) throw new Error(deletionPendingMessage())
    pendingAssetDeletes.add(assetId)
    publish()
    try {
      await options.assets.delete(assetId)
      if (pendingAssetLoads) assetMutations.add(assetId)
      assets = assets.filter(asset => asset.id !== assetId)
      history.reset(snapshot())
    } finally {
      pendingAssetDeletes.delete(assetId)
      publish()
    }
  }

  const changeHistory = (direction: 'undo' | 'redo') => {
    endGesture()
    if (direction === 'undo' ? history.canUndo() : history.canRedo()) {
      const next = history[direction]()
      if (referencesDeletingAsset(next.design.elements)) {
        history[direction === 'undo' ? 'redo' : 'undo']()
        return structuredClone(design)
      }
      pendingImageUploads.clear()
      replacementVersion++
      ;({ design, selectedId, templateSelection } = next)
    }
    publish()
    return structuredClone(design)
  }

  const requestRender = async () => {
    if (!destroyed) await options.render?.()
  }

  return {
    getState,
    getDesign: () => structuredClone(design),
    getAssets: () => structuredClone(assets),
    isAssetDeleting: (assetId: string) => pendingAssetDeletes.has(assetId),
    isDestroyed: () => destroyed,
    beginImageUpload(elementId: string) {
      const target = design.elements.find(element => element.id === elementId)
      if (target?.type !== 'image') return () => false
      const request = { assetId: target.assetId }
      pendingImageUploads.set(elementId, request)
      return () => {
        const current = pendingImageUploads.get(elementId) === request
        if (current) pendingImageUploads.delete(elementId)
        return current && !destroyed
      }
    },
    getSelectedId: () => selectedId,
    getReplacementVersion: () => replacementVersion,
    getLabel: () => ({ ...design.label }),
    getElement: (elementId: string) => structuredClone(design.elements.find(element => element.id === elementId) ?? null),
    getMaxZ: () => Math.max(0, ...design.elements.map(element => element.z)),
    getSelectedElement: () => structuredClone(getSelectedElement()),
    getSelectedJson,
    select,
    clearSelection: () => select(null),
    addElement,
    addImage(assetId: string): LabelImageElement | null {
      const element = {
        ...createElement('image', design, createId()),
        assetId,
      } as LabelImageElement
      if (!commitDesign({ ...design, elements: [...design.elements, element] }, element.id)) return null
      return structuredClone(getSelectedElement() as LabelImageElement)
    },
    updateLabel(changes: Partial<LabelDesignV2['label']>) {
      commitDesign({
        ...design,
        label: { ...design.label, ...changes },
      })
    },
    updateElement,
    updateSelected,
    deleteSelected,
    duplicateSelected,
    pasteElement,
    moveSelected,
    nudgeSelected,
    applySelectedJson,
    setTemplateSelection,
    getTemplateSelection: () => ({ ...templateSelection }),
    insertField,
    loadAssets,
    uploadAsset,
    deleteAsset,
    requestRender,
    beginGesture() {
      if (!destroyed) gestureActive = true
    },
    updateGesture(elementId: string, changes: Partial<LabelDesignElement>) {
      if (destroyed) return
      const index = design.elements.findIndex(element => element.id === elementId)
      if (index < 0) return
      const current = design.elements[index]
      const logoSizeChanges = current.type === 'manufacturerLogo'
        && (changes.w !== undefined && changes.w !== current.w || changes.h !== undefined && changes.h !== current.h)
        ? { manualSizeMm: undefined } : {}
      const next = normalizeElement({ ...current, ...changes, ...logoSizeChanges, id: current.id, type: current.type }, design.label, current.z)
      if (!next || referencesDeletingAsset([next]) || Object.entries(next).every(([key, value]) => current[key as keyof LabelDesignElement] === value)) return
      gestureActive = true
      const elements = [...design.elements]
      elements[index] = next
      design = { ...design, elements }
      gestureChanged = true
    },
    endGesture,
    undo: () => changeHistory('undo'),
    redo: () => changeHistory('redo'),
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    reset(next: LabelDesignV2) {
      const normalized = normalizeLabelDesign(next, { createId })
      if (referencesDeletingAsset(normalized.elements)) return false
      endGesture()
      pendingImageUploads.clear()
      replacementVersion++
      design = normalized
      selectedId = design.elements[0]?.id ?? null
      templateSelection = { start: 0, end: 0 }
      history.reset(snapshot())
      publish()
      return true
    },
    destroy() {
      endGesture()
      destroyed = true
      pendingImageUploads.clear()
    },
  }
}

export type FreeformEditorController = ReturnType<typeof createFreeformEditorController>
