import { createLabelAssetClient } from './assets'
import { getStandardLabelPresets } from './standard-presets'
import { bindFreeformEditorDom } from './editor-dom'
import { createFreeformEditorController } from './editor-state'
import { formatDesignerNumber } from './number-format'
import {
  elementLabelKeys,
  elementLabelFallbacks,
  type FreeformLabelDesignerEditorController,
  type FreeformLabelDesignerEditorOptions,
} from './editor-types'
import {
  activeEditors,
  getFreeformLabelPresetNames,
  loadFreeformLabelDesign,
  loadStoredFreeformLabelDesign,
  persistFreeformLabelDesign,
  readStoredPresets,
  persistStoredPresetMutation,
  type StoredPreset,
} from './editor-storage'
import { deleteLabelPreset, saveLabelPreset } from '../label-preset-storage'
import { appendLabelExtraFieldCatalogGroup, buildLabelExtraFieldCatalogGroups } from '../label-extra-fields'
import type { LabelDesignerPresetData, LabelDesignV2 } from './types'

export const FREEFORM_EDITOR_BREAKPOINT_PX = 600

export async function initFreeformLabelDesignerEditor(
  options: FreeformLabelDesignerEditorOptions,
): Promise<FreeformLabelDesignerEditorController> {
  const entityType = options.entityType ?? 'spool'
  const initialDesign = loadFreeformLabelDesign({
    settingsKey: options.settingsKey,
    presetsKey: options.presetsKey,
    kind: entityType,
  })
  let lastPersisted = JSON.stringify(initialDesign)
  let lastLabel = JSON.stringify(initialDesign.label)
  let extraFields = options.extraFields ?? []
  let domBinding: ReturnType<typeof bindFreeformEditorDom> | null = null
  const controller = createFreeformEditorController({
    initialDesign,
    kind: entityType,
    assets: createLabelAssetClient(),
    translate: options.translate,
    onChange: state => {
      const label = JSON.stringify(state.design.label)
      if (label !== lastLabel) {
        lastLabel = label
        syncGeometry()
      }
      const serialized = JSON.stringify(state.design)
      if (serialized !== lastPersisted) {
        lastPersisted = serialized
        persistFreeformLabelDesign(options.settingsKey, state.design)
      }
      const summary = document.getElementById('freeform-selection-summary')
      if (summary) {
        const selected = state.design.elements.find(element => element.id === state.selectedId)
        const typeName = selected
          ? (options.translate?.(elementLabelKeys[selected.type], elementLabelFallbacks[selected.type]) ?? elementLabelFallbacks[selected.type])
          : ''
        summary.textContent = selected
          ? (options.translate?.('labelDesigner.selectionSummary', '{type} · {width} × {height} mm') ?? '{type} · {width} × {height} mm')
            .replace('{type}', typeName)
            .replace('{width}', formatDesignerNumber(selected.w))
            .replace('{height}', formatDesignerNumber(selected.h))
          : (options.translate?.('labelDesigner.noSelection', 'No element selected') ?? 'No element selected')
      }
    },
    render: options.onChange,
  })
  activeEditors.set(options.settingsKey, controller)

  const width = document.getElementById('freeform-label-width') as HTMLInputElement | null
  const height = document.getElementById('freeform-label-height') as HTMLInputElement | null
  const margin = document.getElementById('freeform-label-margin') as HTMLInputElement | null
  const border = document.getElementById('freeform-label-border') as HTMLInputElement | null
  const presetSelect = document.getElementById('freeform-preset-list') as HTMLSelectElement | null
  const presetName = document.getElementById('freeform-preset-name') as HTMLInputElement | null
  const presetLoad = document.getElementById('freeform-preset-load') as HTMLButtonElement | null
  const presetSave = document.getElementById('freeform-preset-save') as HTMLButtonElement | null
  const presetUpdate = document.getElementById('freeform-preset-update') as HTMLButtonElement | null
  const presetDelete = document.getElementById('freeform-preset-delete') as HTMLButtonElement | null
  const presetStatus = document.getElementById('freeform-preset-status')
  const mobileNotice = document.getElementById('freeform-mobile-notice')
  const workspace = document.getElementById('freeform-designer-workspace')
  const editorContainer = workspace?.parentElement ?? workspace
  const cleanups: Array<() => void> = []
  const measuredWorkspaceWidth = () => {
    const workspaceWidth = workspace?.getBoundingClientRect().width ?? 0
    const measured = workspaceWidth > 0
      ? workspaceWidth
      : (editorContainer?.getBoundingClientRect().width ?? 0)
    return measured > 0 ? measured : window.innerWidth
  }
  let editorEditable = measuredWorkspaceWidth() > FREEFORM_EDITOR_BREAKPOINT_PX
  let resizeObserver: ResizeObserver | null = null
  let destroyed = false
  let pendingPresetMutations = 0
  let loadedOwnPreset: string | null = null
  let presetMutationTail: Promise<void> = Promise.resolve()

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    resizeObserver?.disconnect()
    domBinding?.destroy()
    cleanups.splice(0).forEach(cleanup => cleanup())
    if (activeEditors.get(options.settingsKey) === controller) activeEditors.delete(options.settingsKey)
  }

  const listen = <T extends Event>(target: EventTarget | null, event: string, listener: (event: T) => void) => {
    if (!target) return
    const handler = listener as EventListener
    target.addEventListener(event, handler)
    cleanups.push(() => target.removeEventListener(event, handler))
  }
  const setStatus = (message: string) => {
    if (presetStatus) presetStatus.textContent = message
  }
  const canUpdatePreset = () => loadedOwnPreset !== null
    && presetSelect?.value === `own:${loadedOwnPreset}`
    && presetName?.value.trim() === loadedOwnPreset
    && readStoredPresets(options.presetsKey).some(preset => preset.name === loadedOwnPreset)
  const syncSidebarMutationControls = () => {
    for (const control of [width, height, margin, border, presetName, presetLoad]) {
      if (control) control.disabled = !editorEditable
    }
    if (presetSave) presetSave.disabled = !editorEditable || pendingPresetMutations > 0
    if (presetUpdate) presetUpdate.disabled = !editorEditable || pendingPresetMutations > 0 || !canUpdatePreset()
    if (presetDelete) presetDelete.disabled = !editorEditable || pendingPresetMutations > 0 || !presetSelect?.value.startsWith('own:')
  }
  const enqueuePresetMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    pendingPresetMutations += 1
    syncSidebarMutationControls()
    const queued = presetMutationTail.then(operation)
    presetMutationTail = queued.then(() => undefined, () => undefined)
    try {
      return await queued
    } finally {
      pendingPresetMutations -= 1
      syncSidebarMutationControls()
    }
  }
  const syncGeometry = () => {
    const label = controller.getLabel()
    if (width) width.value = formatDesignerNumber(label.widthMm, 3)
    if (height) height.value = formatDesignerNumber(label.heightMm, 3)
    if (margin) margin.value = formatDesignerNumber(label.marginMm)
    if (border) border.checked = label.border
  }
  const renderExtraFields = () => {
    const containers = {
      filament: document.querySelector<HTMLElement>('[data-extra-field-source="filament"]'),
      spool: document.querySelector<HTMLElement>('[data-extra-field-source="spool"]'),
    }
    const batchMode = options.batchMode ?? false
    for (const container of Object.values(containers)) container?.replaceChildren()
    for (const group of buildLabelExtraFieldCatalogGroups(extraFields, { entityType, batchMode })) {
      const container = containers[group.source]
      if (!container) continue
      appendLabelExtraFieldCatalogGroup(container, group, {
        batchMode,
        translate: options.translate ?? ((_key, fallback) => fallback),
        makeChip: (token, label) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'freeform-token-chip'
          button.dataset.fieldToken = token
          button.title = token
          button.textContent = label
          button.disabled = !editorEditable
          return button
        },
      })
    }
  }
  const refreshPresetList = (selectName?: string) => {
    if (!presetSelect) return
    const previous = presetSelect.value
    const own = readStoredPresets(options.presetsKey)
    const cross = options.crossPresetsKey ? readStoredPresets(options.crossPresetsKey) : []
    const groups: HTMLOptGroupElement[] = []
    const appendGroup = (label: string, prefix: string, presets: StoredPreset[]) => {
      if (presets.length === 0) return
      const group = document.createElement('optgroup')
      group.label = label
      for (const preset of presets) {
        const item = document.createElement('option')
        item.value = `${prefix}:${preset.name}`
        item.textContent = preset.name
        group.append(item)
      }
      groups.push(group)
    }
    const ownFallback = `${options.entityLabel ?? 'Label'} presets`
    const ownLabel = options.ownPresetsLabel
      ?? (options.translate?.('labelDesigner.ownPresets', '{entity} presets') ?? '{entity} presets')
        .replace('{entity}', options.entityLabel ?? 'Label')
    appendGroup(ownLabel || ownFallback, 'own', own)
    appendGroup(
      options.crossPresetsLabel
        ?? (options.translate?.('labelDesigner.otherPresets', 'Other presets') ?? 'Other presets'),
      'cross',
      cross,
    )
    appendGroup(options.translate?.('labelDesigner.standardPresets', 'Standard presets') ?? 'Standard presets', 'builtin', getStandardLabelPresets())
    presetSelect.replaceChildren(...groups)
    const preferred = selectName ? `own:${selectName}`
      : Array.from(presetSelect.options).some(option => option.value === previous) ? previous : presetSelect.options[0]?.value
    if (preferred) presetSelect.value = preferred
    syncSidebarMutationControls()
    const names = getFreeformLabelPresetNames(options.presetsKey)
    document.dispatchEvent(new CustomEvent('freeform-label-presets-changed', {
      detail: { presets: names },
    }))
  }
  const selectedPreset = (value: string) => {
    const [source, ...nameParts] = value.split(':')
    const name = nameParts.join(':')
    if (source === 'builtin') return getStandardLabelPresets().find(preset => preset.name === name) ?? null
    const storageKey = source === 'cross' ? options.crossPresetsKey : options.presetsKey
    return storageKey
      ? readStoredPresets(storageKey).find(preset => preset.name === name) ?? null
      : null
  }
  const loadSettings = (design = loadStoredFreeformLabelDesign({
      settingsKey: options.settingsKey,
      presetsKey: options.presetsKey,
      kind: entityType,
    })) => {
    if (!controller.reset(design)) return false
    loadedOwnPreset = null
    syncSidebarMutationControls()
    syncGeometry()
    domBinding?.sync()
    void domBinding?.refresh()
    return true
  }
  const updateGeometry = (patch: Partial<LabelDesignV2['label']>) => {
    if (!editorEditable) {
      syncGeometry()
      return
    }
    controller.updateLabel(patch)
    syncGeometry()
    domBinding?.sync()
    void domBinding?.refresh()
  }

  for (const [control, property] of [[width, 'widthMm'], [height, 'heightMm'], [margin, 'marginMm']] as const) {
    if (control) listen(control, 'change', () => updateGeometry({ [property]: Number(control.value) }))
  }
  if (border) listen(border, 'change', () => updateGeometry({ border: border.checked }))
  const loadPreset = (name?: string) => {
    const value = name === undefined
      ? presetSelect?.value ?? ''
      : `${readStoredPresets(options.presetsKey).some(preset => preset.name === name) ? 'own' : 'builtin'}:${name}`
    const preset = selectedPreset(value)
    if (!preset || !controller.reset(preset.data.design)) return false
    if (presetSelect) presetSelect.value = value
    loadedOwnPreset = value.startsWith('own:') ? preset.name : null
    persistFreeformLabelDesign(options.settingsKey, preset.data.design)
    lastPersisted = JSON.stringify(preset.data.design)
    if (presetName) presetName.value = preset.name
    syncSidebarMutationControls()
    syncGeometry()
    domBinding?.sync()
    void domBinding?.refresh()
    setStatus(options.translate?.('labelDesigner.presetLoaded', 'Preset loaded.') ?? 'Preset loaded.')
    return true
  }
  listen<MouseEvent>(presetLoad, 'click', () => { loadPreset() })
  listen(presetSelect, 'change', syncSidebarMutationControls)
  listen(presetName, 'input', syncSidebarMutationControls)
  const savePreset = async (asNew = false): Promise<string | null> => {
    if (!editorEditable) return null
    const name = presetName?.value.trim() ?? ''
    if (!name) {
      setStatus(options.translate?.('labelDesigner.presetNameRequired', 'Enter a preset name.') ?? 'Enter a preset name.')
      presetName?.focus()
      return null
    }
    if (asNew && readStoredPresets(options.presetsKey).some(preset => preset.name === name)) {
      setStatus(options.translate?.('labelDesigner.presetNameExists', 'That name is already in use. Choose a new name.') ?? 'That name is already in use. Choose a new name.')
      presetName?.focus()
      return null
    }
    const design = controller.getDesign()
    const replacementVersion = controller.getReplacementVersion()
    return enqueuePresetMutation(async () => {
      const presets = readStoredPresets(options.presetsKey)
      const index = presets.findIndex(candidate => candidate.name === name)
      const existing = index >= 0 ? presets[index] : null
      const data: LabelDesignerPresetData = { version: 2, design }
      if (existing && 'legacy_v1' in existing.data) data.legacy_v1 = structuredClone(existing.data.legacy_v1)
      const preset: StoredPreset = { name, data }
      if (index >= 0) presets[index] = preset
      else presets.push(preset)
      return persistStoredPresetMutation(
        options.presetsKey,
        presets,
        () => asNew
          ? saveLabelPreset(options.presetsKey, preset, undefined, true)
          : saveLabelPreset(options.presetsKey, preset),
      )
    }).then(saved => {
      if (saved && presetName?.value.trim() === name && controller.getReplacementVersion() === replacementVersion) loadedOwnPreset = name
      refreshPresetList(saved ? name : undefined)
      setStatus(saved
        ? (options.translate?.('labelDesigner.presetSaved', 'Preset saved.') ?? 'Preset saved.')
        : (options.translate?.('labelDesigner.presetSaveFailed', 'Preset save failed.') ?? 'Preset save failed.'))
      return saved ? name : null
    }, () => {
      refreshPresetList()
      setStatus(options.translate?.('labelDesigner.presetSaveFailed', 'Preset save failed.') ?? 'Preset save failed.')
      return null
    })
  }
  listen<MouseEvent>(presetSave, 'click', () => { void savePreset(true) })
  listen<MouseEvent>(presetUpdate, 'click', () => {
    if (canUpdatePreset() && pendingPresetMutations === 0) void savePreset()
  })
  listen<MouseEvent>(presetDelete, 'click', () => {
    if (!editorEditable) return
    const value = presetSelect?.value ?? ''
    if (!value.startsWith('own:')) return
    const name = value.slice(4)
    void enqueuePresetMutation(() => persistStoredPresetMutation(
      options.presetsKey,
      readStoredPresets(options.presetsKey).filter(preset => preset.name !== name),
      () => deleteLabelPreset(options.presetsKey, name),
    )).then(deleted => {
      refreshPresetList()
      setStatus(deleted
        ? (options.translate?.('labelDesigner.presetDeleted', 'Preset deleted.') ?? 'Preset deleted.')
        : (options.translate?.('labelDesigner.presetDeleteFailed', 'Preset delete failed.') ?? 'Preset delete failed.'))
    }, () => {
      refreshPresetList()
      setStatus(options.translate?.('labelDesigner.presetDeleteFailed', 'Preset delete failed.') ?? 'Preset delete failed.')
    })
  })

  const syncMobileState = (availableWidth = measuredWorkspaceWidth()) => {
    const nextEditable = availableWidth > FREEFORM_EDITOR_BREAKPOINT_PX
    if (mobileNotice) mobileNotice.hidden = nextEditable
    if (workspace) workspace.dataset.editorEditable = String(nextEditable)
    const changed = nextEditable !== editorEditable
    editorEditable = nextEditable
    syncSidebarMutationControls()
    if (changed) void domBinding?.setEditable(nextEditable)
  }
  if (editorContainer && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(entries => {
      if (destroyed) return
      const entry = entries.find(candidate => candidate.target === editorContainer) ?? entries[0]
      syncMobileState(entry?.contentRect.width ?? measuredWorkspaceWidth())
    })
    resizeObserver.observe(editorContainer)
  } else {
    listen(window, 'resize', () => syncMobileState())
  }
  const spoolTab = document.getElementById('freeform-field-tab-spool')
  if (spoolTab) spoolTab.hidden = entityType !== 'spool'
  renderExtraFields()
  syncGeometry()
  refreshPresetList()
  syncMobileState()
  try {
    domBinding = bindFreeformEditorDom({
      root: document,
      controller,
      editable: editorEditable,
      loadInteract: options.loadInteract,
      translate: options.translate,
      getPreviewData: options.getPreviewData,
    })
    await domBinding.ready
  } catch (error) {
    destroy()
    throw error
  }

  return {
    getDesign: controller.getDesign,
    savePreset,
    loadPreset,
    loadSettings,
    refresh: () => domBinding?.refresh() ?? Promise.resolve(),
    refreshInteractions: () => domBinding?.refreshInteractions() ?? Promise.resolve(),
    refreshExtraFields(next) {
      extraFields = next
      renderExtraFields()
      domBinding?.sync()
    },
    refreshPresetList,
    destroy,
  }
}
