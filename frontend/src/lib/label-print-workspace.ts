import {
  getFreeformLabelPresetNames,
  initFreeformLabelDesignerEditor,
  loadFreeformLabelDesign,
  loadFreeformLabelPresetDesign,
  type FreeformLabelDesignerEditorOptions,
} from './freeform-label/editor-controller'
import type { LabelKind } from './freeform-label/types'
import {
  bindPrintWorkspaceTabs,
  syncDesignerRepresentativeElements,
  type createPrintWorkspaceCoordinator,
  type LabelOutputControls,
  type PrintLabelSource,
  type PrintWorkspaceMode,
  type PrintWorkspaceSnapshot,
} from './label-print-page'
import { resizeLabelDesign } from './freeform-label/geometry'
import { readStoredPresets } from './freeform-label/editor-storage'
import type { SheetLabelSetup, LabelSheetControls, LabelSheetSource } from './label-sheet'
import { t } from './i18n'

export interface SingleLabelPreviewRuntimeOptions {
  label: HTMLElement
  getSource: () => PrintLabelSource
  renderStandard: (isStale: () => boolean) => void | Promise<void>
  renderDesigner: (isStale: () => boolean) => void | Promise<void>
  getStandardDimensions: () => { widthMm: number; heightMm: number }
  getDesignerDimensions: () => { widthMm: number; heightMm: number }
}

export function createSingleLabelPreviewRuntime(options: SingleLabelPreviewRuntimeOptions) {
  let renderVersion = 0

  const refresh = () => {
    const source = options.getSource()
    const version = ++renderVersion
    const isStale = () => version !== renderVersion || source !== options.getSource()
    options.label.style.border = source === 'designer' ? '' : 'none'
    options.label.style.padding = ''
    return Promise.resolve(source === 'designer'
      ? options.renderDesigner(isStale)
      : options.renderStandard(isStale))
  }

  return {
    activate: refresh,
    refresh,
    getDimensions: () => options.getSource() === 'designer'
      ? options.getDesignerDimensions()
      : options.getStandardDimensions(),
  }
}

export interface BatchLabelPreviewRuntimeOptions<T, TDesign> {
  getActiveMode: () => PrintWorkspaceMode
  getPreviewIndex: () => number
  getWorkspaceState: (mode: PrintWorkspaceMode) => PrintWorkspaceSnapshot<T>
  getDesign: () => TDesign
  findElement: (item: T) => HTMLElement | null
  renderStandard: (element: HTMLElement, item: T, stale: () => boolean) => Promise<void>
  renderDesigner: (element: HTMLElement, item: T, interactive: boolean, design: TDesign, stale: () => boolean) => Promise<void>
  getSourceElements: () => HTMLElement[]
  afterRender: (state: PrintWorkspaceSnapshot<T>) => void
  chunkSize?: number
}

export function createBatchLabelPreviewRuntime<T, TDesign>(options: BatchLabelPreviewRuntimeOptions<T, TDesign>) {
  let renderVersion = 0

  return {
    async render(mode = options.getActiveMode(), output = false) {
      const version = ++renderVersion
      const state = options.getWorkspaceState(mode)
      const stale = () => version !== renderVersion
        || options.getActiveMode() !== mode
        || options.getPreviewIndex() !== state.previewIndex
      const design = state.source === 'designer' ? options.getDesign() : null
      const items = output ? state.outputItems : state.previewItems
      const chunkSize = options.chunkSize ?? 6

      for (let index = 0; index < items.length; index += chunkSize) {
        if (stale()) return
        await Promise.all(items.slice(index, index + chunkSize).map(item => {
          const element = options.findElement(item)
          if (!element) return Promise.resolve()
          return state.source === 'designer'
            ? options.renderDesigner(element, item, mode === 'designer' && item === state.representativeItem, design!, stale)
            : options.renderStandard(element, item, stale)
        }))
        if (stale()) return
        if (index + chunkSize < items.length) await new Promise(resolve => setTimeout(resolve, 0))
      }

      if (stale()) return
      syncDesignerRepresentativeElements(mode, options.getSourceElements(), state.previewIndex)
      options.afterRender(state)
    },
  }
}

export function bindDesignerPreviewNavigation<T>(workspace: ReturnType<typeof createPrintWorkspaceCoordinator<T>>) {
  const navigation = document.getElementById('freeform-preview-navigation')
  const buttons = navigation?.querySelectorAll<HTMLButtonElement>('[data-preview-step]') ?? []
  const position = navigation?.querySelector('[data-preview-position]')
  const sync = () => {
    const { mode, previewIndex, outputItems } = workspace.getState()
    if (navigation) navigation.hidden = mode !== 'designer' || outputItems.length <= 1
    if (position) position.textContent = t('labelDesigner.previewPosition', {
      current: String(previewIndex + 1), total: String(outputItems.length),
    })
    buttons.forEach(button => {
      button.disabled = Number(button.dataset.previewStep) < 0 ? previewIndex === 0 : previewIndex >= outputItems.length - 1
    })
  }
  buttons.forEach(button => button.addEventListener('click', () => {
    workspace.selectPreview(workspace.getState().previewIndex + Number(button.dataset.previewStep))
    sync()
  }))
  sync()
  return sync
}

export function bindLabelPrintWorkspaceTabs(options: {
  sheetControls: LabelSheetControls
  outputControls: LabelOutputControls
  storageKey: string
  initialMode: PrintWorkspaceMode
  onChange: (mode: PrintWorkspaceMode) => void
}) {
  return bindPrintWorkspaceTabs({
    ...options,
    buttons: document.querySelectorAll<HTMLButtonElement>('.tab-btn'),
    panels: {
      standard: document.getElementById('tab-panel-print')!,
      designer: document.getElementById('tab-panel-designer-v2')!,
      sheets: document.getElementById('tab-panel-sheets')!,
    },
    outputButtons: {
      print: options.outputControls.printButton,
      pdf: options.outputControls.pdfButton,
      png: options.outputControls.pngButton,
      aml: options.outputControls.amlButton,
    },
    resetButton: document.getElementById('btn-reset'),
    sidebar: document.querySelector<HTMLElement>('.print-sidebar'),
    designerWorkspace: document.getElementById('freeform-designer-workspace'),
  })
}

export function getPrintDesignerDesign(options: {
  settingsKey: string
  presetsKey: string
  kind: LabelKind
  mode: PrintWorkspaceMode
  sheetSource: LabelSheetSource
}) {
  if (options.mode === 'sheets' && options.sheetSource.type === 'designer' && options.sheetSource.presetName) {
    const preset = loadFreeformLabelPresetDesign({ ...options, presetName: options.sheetSource.presetName })
    if (preset) return preset
  }
  return loadFreeformLabelDesign(options)
}

export async function initPrintDesignerEditor(options: FreeformLabelDesignerEditorOptions & {
  sheetControls: Pick<LabelSheetControls, 'setDesignerPresets' | 'setSource'>
  activateDesigner: () => void
}) {
  const { sheetControls, activateDesigner, ...editorOptions } = options
  const events = new AbortController()
  const returnButtons = document.querySelectorAll<HTMLButtonElement>('[data-sheet-use]')
  const designerReturn = document.querySelector<HTMLButtonElement>('[data-sheet-use="designer"]')
  const nameInput = document.getElementById('freeform-preset-name') as HTMLInputElement | null
  let existingSheetPresetNames = new Set<string>()
  // Refresh after mutations settle, when the confirmed preset cache is current.
  let savedPresets = readStoredPresets(options.presetsKey)
  let editor: Awaited<ReturnType<typeof initFreeformLabelDesignerEditor>>
  const savedSheetPresetName = () => {
    const name = nameInput?.value.trim() ?? ''
    if (!editor || !designerReturn || designerReturn.hidden || existingSheetPresetNames.has(name)) return null
    const saved = savedPresets.find(preset => preset.name === name)
    return saved && JSON.stringify(saved.data.design) === JSON.stringify(editor.getDesign()) ? name : null
  }
  const syncSheetAction = () => {
    if (designerReturn) designerReturn.dataset.saved = String(!!savedSheetPresetName())
  }
  window.addEventListener('pagehide', event => {
    if (!event.persisted) events.abort()
  }, { signal: events.signal })
  document.addEventListener('freeform-label-presets-changed', event => {
    const names = (event as CustomEvent<{ presets?: string[] }>).detail?.presets
    if (Array.isArray(names)) sheetControls.setDesignerPresets(names)
    savedPresets = readStoredPresets(options.presetsKey)
    syncSheetAction()
  }, { signal: events.signal })

  try {
    editor = await initFreeformLabelDesignerEditor({
      ...editorOptions,
      onChange: async () => {
        syncSheetAction()
        await editorOptions.onChange()
      },
    })
  } catch (error) {
    events.abort()
    throw error
  }
  sheetControls.setDesignerPresets(getFreeformLabelPresetNames(options.presetsKey))
  document.addEventListener('label-designer-edit', event => {
    const presetName = (event as CustomEvent<{ presetName?: string }>).detail?.presetName
    if (presetName && editor.loadPreset(presetName)) activateDesigner()
  }, { signal: events.signal })

  let suggestedName = ''
  const activateTab = (mode: PrintWorkspaceMode) => document.querySelector<HTMLButtonElement>(`[data-workspace-mode="${mode}"]`)?.click()
  document.addEventListener('label-sheet-create', event => {
    const setup = (event as CustomEvent<SheetLabelSetup>).detail
    if (!setup || !Number.isFinite(setup.widthMm) || !Number.isFinite(setup.heightMm)) return
    if (setup.type === 'designer') {
      const source = loadFreeformLabelPresetDesign({
        presetsKey: options.presetsKey, presetName: setup.presetName, kind: options.entityType ?? 'spool',
      })
      if (!source) return
      if (!editor.loadSettings(resizeLabelDesign(source, setup.widthMm, setup.heightMm))) return
      const names = getFreeformLabelPresetNames(options.presetsKey)
      existingSheetPresetNames = new Set(names)
      suggestedName = setup.name
      for (let suffix = 2; names.includes(suggestedName); suffix++) suggestedName = `${setup.name} (${suffix})`
      if (nameInput) nameInput.value = suggestedName
      activateDesigner()
    } else {
      const width = document.getElementById('input-width') as HTMLInputElement | null
      const height = document.getElementById('input-height') as HTMLInputElement | null
      if (width && height) {
        width.value = String(Number(setup.widthMm.toFixed(3)))
        height.value = String(Number(setup.heightMm.toFixed(3)))
        width.dispatchEvent(new Event('change', { bubbles: true }))
      }
      activateTab('standard')
    }
    returnButtons.forEach(button => { button.hidden = button.dataset.sheetUse !== setup.type })
    syncSheetAction()
  }, { signal: events.signal })
  nameInput?.addEventListener('input', syncSheetAction, { signal: events.signal })
  nameInput?.addEventListener('focus', () => {
    if (nameInput.value === suggestedName) nameInput.select()
  }, { signal: events.signal })
  returnButtons.forEach(button => button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    try {
      if (button.dataset.sheetUse === 'designer') {
        const name = savedSheetPresetName()
          ?? await editor.savePreset(existingSheetPresetNames.has(nameInput?.value.trim() ?? ''))
        if (!name) return
        sheetControls.setDesignerPresets(getFreeformLabelPresetNames(options.presetsKey), name)
        sheetControls.setSource({ type: 'designer', presetName: name })
      } else sheetControls.setSource({ type: 'standard' })
      returnButtons.forEach(candidate => { candidate.hidden = true })
      activateTab('sheets')
    } finally { button.disabled = false }
  }, { signal: events.signal }))

  return {
    ...editor,
    destroy() {
      events.abort()
      editor.destroy()
    },
  }
}
