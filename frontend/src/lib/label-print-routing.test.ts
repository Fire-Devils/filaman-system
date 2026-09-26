// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'

import LabelSheetOutputSettings from '../components/LabelSheetOutputSettings.astro'
import StandardLabelSettingsPanel from '../components/StandardLabelSettingsPanel.astro'
import { SPOOL_LABEL_PRESETS_KEY } from './label-preset-storage'
import PrintActionFooter from '../components/PrintActionFooter.astro'
import PrintSidebar from '../components/PrintSidebar.astro'
import DesignerSidebar from '../components/freeform-label/DesignerSidebar.astro'
import DesignerWorkspace from '../components/freeform-label/DesignerWorkspace.astro'
import { createDefaultLabelDesign } from './freeform-label/defaults'
import { bindDesignerPreviewNavigation, bindLabelPrintWorkspaceTabs, getPrintDesignerDesign, initPrintDesignerEditor } from './label-print-workspace'
import { createPrintWorkspaceCoordinator, getLabelSettingsControls, getStandardLabelSettings, getLabelOutputControls, singleLabelPrintUrl } from './label-print-page'

import {
  bindLabelSheetControls,
  LABEL_SHEET_PRESETS_KEY,
  getLabelSheetLayout,
  renderLabelSheetPreview,
  syncLabelSheetIndividualExportState,
  type LabelSheetControls,
  type LabelSheetSettings,
} from './label-sheet'
import { setLang } from './i18n'

const componentsDirectory = fileURLToPath(new NodeURL('../components/', import.meta.url))

it('routes one selected record to its single-label printer, not the batch printer', () => {
  expect(singleLabelPrintUrl('spool', [17])).toBe('/spools/17/print')
  expect(singleLabelPrintUrl('filament', [8])).toBe('/filaments/8/print')
  expect(singleLabelPrintUrl('spool', [17, 18])).toBeNull()
  expect(singleLabelPrintUrl('spool', [])).toBeNull()
})

it('browses the selected labels from the real designer navigation and hides it for one label', async () => {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(DesignerWorkspace)
  let items = [10, 20, 30]
  const workspace = createPrintWorkspaceCoordinator({
    initialMode: 'designer',
    getItems: () => items, getSheetSource: () => ({ type: 'standard' }),
    onModeChange: () => undefined,
  })
  const sync = bindDesignerPreviewNavigation(workspace)
  const navigation = document.querySelector<HTMLElement>('#freeform-preview-navigation')!
  const previous = navigation.querySelector<HTMLButtonElement>('[data-preview-step="-1"]')!
  const next = navigation.querySelector<HTMLButtonElement>('[data-preview-step="1"]')!
  expect(navigation.hidden).toBe(false)
  expect(previous.disabled).toBe(true)
  expect(next.disabled).toBe(false)
  next.click()
  expect(navigation.textContent).toContain('Label 2 of 3')
  expect(workspace.getPreviewItems()).toEqual([20])
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  next.click()
  expect(next.disabled).toBe(true)
  previous.click()
  expect(workspace.getOutputItems()).toEqual([10, 20, 30])
  workspace.activate('standard')
  sync()
  expect(navigation.hidden).toBe(true)
  workspace.activate('designer')
  items = [10]
  sync()
  expect(navigation.hidden).toBe(true)
})

const settings: LabelSheetSettings = {
  paperSize: 'custom',
  customWidthMm: 100,
  customHeightMm: 50,
  rows: 1,
  columns: 1,
  marginTopMm: 5,
  marginRightMm: 5,
  marginBottomMm: 5,
  marginLeftMm: 5,
  gapHorizontalMm: 0,
  gapVerticalMm: 0,
  skipCells: 0,
  copies: 1,
  showGrid: false,
  printGrid: false,
  fitToCell: true,
}

beforeEach(() => {
  setLang('en')
  localStorage.clear()
  document.head.innerHTML = ''
  document.body.innerHTML = `
    <div id="preview">
      <div id="source"><div class="label-preview">Sample label</div></div>
    </div>
  `
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('label sheet preview styling', () => {
  it('uses the active language for the large sheet warning', () => {
    setLang('de')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderLabelSheetPreview({
      previewRoot: document.querySelector<HTMLElement>('#preview')!,
      sourceElements: [document.querySelector<HTMLElement>('#source')!],
      settings: { ...settings, copies: 501 },
      labelWidthMm: 60,
      labelHeightMm: 40,
    })

    expect(confirm).toHaveBeenCalledWith('Dieser Etikettenbogen rendert 501 Etiketten auf 501 Seiten und kann langsam sein oder eine große PDF-Datei erzeugen. Fortfahren?')
  })
  it('injects screen-only CSS while preserving the configured sheet dimensions', () => {
    renderLabelSheetPreview({
      previewRoot: document.querySelector<HTMLElement>('#preview')!,
      sourceElements: [document.querySelector<HTMLElement>('#source')!],
      settings,
      labelWidthMm: 60,
      labelHeightMm: 40,
    })

    const style = document.querySelector<HTMLStyleElement>(
      '#label-sheet-preview-style',
    )

    expect(style).not.toBeNull()
    expect(style!.textContent).not.toContain('@media print')
    expect(style!.textContent).not.toContain('@page')
    expect(style!.textContent).toContain('width: 100mm')
    expect(style!.textContent).toContain('height: 50mm')
    expect(style!.textContent).toContain('.preview-scroll-area.is-label-sheet-mode')
    expect(style!.textContent).toContain('> #freeform-designer-workspace')
    expect(style!.textContent).toMatch(/\.label-sheet-label-shell::after\s*\{[^}]*inset:\s*0;/s)
  })

  it('removes designer selection state and editor chrome from every sheet copy', () => {
    const source = document.querySelector<HTMLElement>('#source .label-preview')!
    source.classList.add('is-selected')
    source.setAttribute('data-label-interactive', '')
    source.insertAdjacentHTML('beforeend', '<span class="is-selected" data-label-interaction-bound>Element</span><button data-editor-handle>Resize</button>')

    renderLabelSheetPreview({
      previewRoot: document.querySelector<HTMLElement>('#preview')!,
      sourceElements: [document.querySelector<HTMLElement>('#source')!],
      settings: { ...settings, copies: 2 },
      labelWidthMm: 60,
      labelHeightMm: 40,
    })

    const copies = Array.from(document.querySelectorAll<HTMLElement>('.label-sheet-page .label-preview'))
    expect(copies).toHaveLength(2)
    expect(copies.every(copy => !copy.hasAttribute('data-label-interactive'))).toBe(true)
    expect(document.querySelector('.label-sheet-page .is-selected')).toBeNull()
    expect(document.querySelector('.label-sheet-page [data-label-interaction-bound]')).toBeNull()
    expect(document.querySelector('.label-sheet-page [data-editor-handle]')).toBeNull()
  })

  it('reveals a cropped image copy when it loads after the sheet preview was cloned', () => {
    const source = document.querySelector<HTMLElement>('#source .label-preview')!
    source.innerHTML = `
      <div data-label-image-crop-viewport style="visibility: hidden">
        <img src="asset.png" data-label-image-crop-aspect-factor="0.5">
      </div>
    `

    renderLabelSheetPreview({
      previewRoot: document.querySelector<HTMLElement>('#preview')!,
      sourceElements: [document.querySelector<HTMLElement>('#source')!],
      settings,
      labelWidthMm: 60,
      labelHeightMm: 40,
    })

    const cloneImage = document.querySelector<HTMLImageElement>('.label-sheet-page img')!
    Object.defineProperties(cloneImage, {
      naturalWidth: { configurable: true, value: 1200 },
      naturalHeight: { configurable: true, value: 600 },
    })
    cloneImage.dispatchEvent(new Event('load'))

    const viewport = cloneImage.closest<HTMLElement>('[data-label-image-crop-viewport]')!
    expect(viewport.style.getPropertyValue('--label-image-crop-aspect')).toBe('1')
    expect(viewport.style.visibility).toBe('visible')
  })
})

describe('label sheet individual export state', () => {
  it('disables and restores PNG and AML together', () => {
    let mode: 'individual' | 'sheet' = 'sheet'
    const controls = {
      getOutputMode: () => mode,
    } as LabelSheetControls
    const png = document.createElement('button')
    const aml = document.createElement('button')
    png.title = 'PNG title'

    syncLabelSheetIndividualExportState(
      controls,
      [png, aml],
      (_key, fallback) => fallback,
    )

    for (const button of [png, aml]) {
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(button.classList.contains('is-disabled')).toBe(true)
      expect(button.title).toBe(
        'Individual PNG and AML exports are not available in label paper mode',
      )
    }

    mode = 'individual'
    syncLabelSheetIndividualExportState(
      controls,
      [png, aml],
      (_key, fallback) => fallback,
    )

    expect(png.disabled).toBe(false)
    expect(png.getAttribute('aria-disabled')).toBeNull()
    expect(png.classList.contains('is-disabled')).toBe(false)
    expect(png.title).toBe('PNG title')
    expect(aml.title).toBe('')
  })
})

describe('selectable print guidance translations', () => {
  it.each(['../i18n/en.json', '../i18n/de.json'])(
    '%s contains every print mode and AML status key',
    path => {
      const messages = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(path, import.meta.url)),
          'utf8',
        ),
      )

      for (const key of [
        'temporaryPdfPreviewTitle',
        'backToLabelPreview',
        'openPdfForPrinting',
        'downloadPdf',
        'inlinePdfUnsupported',
        'printPopupBlocked',
      ]) {
        expect(messages.labelPrint[key]).toBeTruthy()
      }
      expect(messages.labelPrint.preparingPrintPdf).toBeUndefined()
      expect(messages.labelPrint.preparingBrowserPrint).toBeTruthy()
      expect(messages.labelPrint.printPdfFailed).toBeTruthy()
      expect(messages.labelPrint.browserPrintFailed).toBeTruthy()
      expect(messages.labelPrint.btnExportAml).toBeTruthy()
      expect(messages.labelPrint.amlExportFailed).toBeTruthy()
      expect(messages.labelPrint.createTemporaryPdf).toBeTruthy()
      expect(
        messages.labelPrint.individualExportsUnavailableInSheetMode,
      ).toBeTruthy()
      expect(messages.labelPrint.printHelpIntro).toBeTruthy()
      expect(messages.labelPrint.printHelpScale).toBeTruthy()
      expect(messages.labelPrint.printHelpBrowserSystemDialog).toBeTruthy()
      expect(messages.labelPrint.printHelpPdfFallbackPrefix).toBeTruthy()
      expect(messages.labelPrint.printHelpPdfFallbackSuffix).toBeTruthy()
      expect(messages.labelPrint.printHelpPdfOpenOnly).toBeTruthy()
      expect(messages.labelPrint.printHelpPdfSystemDialog).toBeTruthy()
      expect(messages.labelPrint.printHelpPdfDownloadSetting).toBeTruthy()
      expect(messages.labelPrint.printHelpViewer).toBeUndefined()
      expect(messages.labelPrint.printHelpBrave).toBeUndefined()
      expect(messages.labelPrint.printHelpFirefox).toBeUndefined()
    },
  )
})

describe('print guidance', () => {
  it('semantically emphasizes the temporary PDF option', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(PrintActionFooter)

    const temporaryPdfGuidance = document.querySelector(
      '#print-help-content [data-i18n="labelPrint.createTemporaryPdf"]',
    )

    expect(temporaryPdfGuidance?.tagName).toBe('EM')
    expect(temporaryPdfGuidance?.textContent?.trim()).toBe(
      'Create temporary PDF for printing',
    )
  })
})

describe('first-class print workspace navigation', () => {
  it('keeps a saved paper preset when deletion is cancelled', async () => {
    localStorage.setItem(LABEL_SHEET_PRESETS_KEY, JSON.stringify([{
      id: 'custom-keep',
      name: 'Keep me',
      settings,
    }]))
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    const confirm = vi.fn(async () => false)
    ;(window as typeof window & { __fmConfirm: typeof confirm }).__fmConfirm = confirm
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    bindLabelSheetControls(() => undefined)
    const preset = document.querySelector<HTMLSelectElement>('#sheet-preset')!
    preset.value = 'custom-keep'
    preset.dispatchEvent(new Event('change'))

    document.querySelector<HTMLButtonElement>('#sheet-delete-preset')!.click()
    await Promise.resolve()

    expect(confirm).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(Array.from(preset.options).map(option => option.textContent)).toContain('Keep me')
  })

  it('separates paper preset updates from create-only saves', async () => {
    localStorage.setItem(LABEL_SHEET_PRESETS_KEY, JSON.stringify([{
      id: 'custom-existing',
      name: 'Existing paper',
      settings,
    }]))
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    try {
      bindLabelSheetControls(() => undefined)
      const preset = document.querySelector<HTMLSelectElement>('#sheet-preset')!
      const name = document.querySelector<HTMLInputElement>('#sheet-preset-name')!
      const update = document.querySelector<HTMLButtonElement>('#sheet-update-preset')!
      const save = document.querySelector<HTMLButtonElement>('#sheet-save-preset')!
      preset.value = 'custom-existing'
      preset.dispatchEvent(new Event('change'))
      expect(update.disabled).toBe(true)

      document.querySelector<HTMLButtonElement>('#sheet-load-preset')!.click()
      expect(update.disabled).toBe(false)
      const columns = document.querySelector<HTMLInputElement>('#sheet-columns')!
      columns.value = '2'
      columns.dispatchEvent(new Event('input'))
      expect(preset.value).toBe('custom-existing')
      expect(update.disabled).toBe(false)
      update.click()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body)).create_only).toBeUndefined()
      await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(LABEL_SHEET_PRESETS_KEY)!)[0].settings.columns).toBe(2))

      save.click()
      expect(alert).toHaveBeenCalledWith('That name is already in use. Choose a new name.')
      expect(fetch).toHaveBeenCalledOnce()
      name.value = 'New paper'
      name.dispatchEvent(new Event('input'))
      expect(update.disabled).toBe(true)
      save.click()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      const body = JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))
      expect(body.create_only).toBe(true)
      await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(LABEL_SHEET_PRESETS_KEY)!)
        .map((item: { name: string }) => item.name)).toEqual(['Existing paper', 'New paper']))
    } finally {
      alert.mockRestore()
    }
  })

  it('resolves saved sheet designs separately from the current working design', () => {
    const current = createDefaultLabelDesign('spool')
    const saved = { ...current, label: { ...current.label, widthMm: 85 } }
    const keys = { settingsKey: 'test-design', presetsKey: 'test-presets', kind: 'spool' as const }
    localStorage.setItem(keys.settingsKey, JSON.stringify({ version: 2, design: current }))
    localStorage.setItem(keys.presetsKey, JSON.stringify({ version: 2, presets: [
      { name: 'Wide', data: { version: 2, design: saved } },
    ] }))
    const source = { ...keys, sheetSource: { type: 'designer' as const, presetName: 'Wide' } }

    expect(getPrintDesignerDesign({ ...source, mode: 'sheets' }).label.widthMm).toBe(85)
    expect(getPrintDesignerDesign({ ...source, mode: 'designer' })).toEqual(current)
    expect(getPrintDesignerDesign({ ...source, mode: 'sheets', sheetSource: { type: 'designer', presetName: 'Missing' } })).toEqual(current)
  })

  it('resolves duplicate sheet preset names from their selected group', () => {
    const current = createDefaultLabelDesign('spool')
    const own = { ...current, label: { ...current.label, widthMm: 85 } }
    const cross = { ...current, label: { ...current.label, widthMm: 70 } }
    localStorage.setItem('test-design', JSON.stringify({ version: 2, design: current }))
    localStorage.setItem('test-presets', JSON.stringify({ version: 2, presets: [
      { name: 'Classic (40 × 30 mm)', data: { version: 2, design: own } },
    ] }))
    localStorage.setItem('cross-presets', JSON.stringify({ version: 2, presets: [
      { name: 'Classic (40 × 30 mm)', data: { version: 2, design: cross } },
    ] }))
    const base = {
      settingsKey: 'test-design', presetsKey: 'test-presets', crossPresetsKey: 'cross-presets',
      kind: 'spool' as const, mode: 'sheets' as const,
    }

    expect(getPrintDesignerDesign({
      ...base, sheetSource: { type: 'designer', presetSource: 'spool', presetName: 'Classic (40 × 30 mm)' },
    }).label.widthMm).toBe(85)
    expect(getPrintDesignerDesign({
      ...base, sheetSource: { type: 'designer', presetSource: 'filament', presetName: 'Classic (40 × 30 mm)' },
    }).label.widthMm).toBe(70)
    expect(getPrintDesignerDesign({
      ...base, sheetSource: { type: 'designer', presetSource: 'builtin', presetName: 'Classic (40 × 30 mm)' },
    }).label.widthMm).toBe(40)
  })

  it.each([false, true])('loads sheet preset identity before editing (restored page: %s)', async restored => {
    const current = createDefaultLabelDesign('spool')
    const saved = { ...current, label: { ...current.label, widthMm: 85 } }
    localStorage.setItem('test-design', JSON.stringify({ version: 2, design: current }))
    localStorage.setItem('test-presets', JSON.stringify({ version: 2, presets: [
      { name: 'Wide', data: { version: 2, design: saved } },
    ] }))
    const container = await AstroContainer.create()
    document.body.innerHTML = [
      await container.renderToString(PrintSidebar, { props: { backLabel: 'Back' } }),
      '<div id="tab-panel-print"></div>',
      await container.renderToString(DesignerSidebar),
      await container.renderToString(DesignerWorkspace),
      await container.renderToString(LabelSheetOutputSettings),
      await container.renderToString(PrintActionFooter),
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    const controls = bindLabelSheetControls(() => undefined)
    const outputControls = getLabelOutputControls()
    const tabs = bindLabelPrintWorkspaceTabs({
      sheetControls: controls, outputControls, storageKey: 'test-mode', initialMode: 'standard', onChange: () => undefined,
    })
    tabs.activate('sheets')
    expect(outputControls.pngButton.hidden).toBe(true)
    const activatedWidths: number[] = []
    const editor = await initPrintDesignerEditor({
      presetsKey: 'test-presets', settingsKey: 'test-design', entityType: 'spool',
      onChange: async () => undefined,
      sheetControls: controls,
      activateDesigner: () => {
        activatedWidths.push(editor.getDesign().label.widthMm)
        tabs.activate('designer')
      },
    })
    try {
      const preset = document.querySelector<HTMLSelectElement>('#sheet-designer-preset')!
      expect(Array.from(preset.options).some(option => option.value === 'spool:Wide')).toBe(true)
      controls.setSource({ type: 'designer', presetSource: 'spool', presetName: 'Wide' })
      if (restored) {
        for (let trip = 0; trip < 2; trip++) {
          window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }))
          window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
        }
      }
      document.querySelector<HTMLButtonElement>('#sheet-edit-designer')!.click()
      expect(activatedWidths).toEqual([85])
      expect(editor.getDesign()).toEqual(saved)
      expect(tabs.getActiveMode()).toBe('designer')
      expect(outputControls.pngButton.hidden).toBe(false)
      expect(document.querySelector<HTMLInputElement>('#freeform-preset-name')!.value).toBe('Wide')
      expect(document.querySelector<HTMLSelectElement>('#freeform-preset-list')!.value).toBe('own:Wide')
      expect(document.querySelector<HTMLButtonElement>('#freeform-preset-update')!.disabled).toBe(false)
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }))
      document.querySelector<HTMLButtonElement>('#sheet-edit-designer')!.click()
      expect(activatedWidths).toEqual([85])
    } finally {
      editor.destroy()
    }
  })

  it.each([
    '../pages/spools/[id]/print.astro',
    '../pages/filaments/[id]/print.astro',
  ])('%s initializes logo state before the editor can render restored designs', path => {
    const source = readFileSync(
      fileURLToPath(new URL(path, import.meta.url)),
      'utf8',
    )

    expect(source.indexOf('let labelLogoLoaded = false')).toBeLessThan(
      source.indexOf('designerEditor = await initPrintDesignerEditor({'),
    )
  })

  it.each([
    ['../pages/spools/[id]/print.astro', "? singlePreview.refresh()", false],
    ['../pages/filaments/[id]/print.astro', "? singlePreview.refresh()", false],
    ['../pages/spools/print.astro', 'onChange: renderBatchPreview,', true],
    ['../pages/filaments/print.astro', 'onChange: renderBatchPreview,', true],
  ] as const)('%s delegates a settling designer render promise before interaction binding', (path, callback, batch) => {
    const source = readFileSync(
      fileURLToPath(new URL(path, import.meta.url)),
      'utf8',
    )

    expect(source).toContain(callback)
    if (batch) {
      expect(source).toContain('createBatchLabelPreviewRuntime({')
      expect(source).toContain('previewRenders.run(() => batchPreview.render(mode, output))')
      expect(source.indexOf("const countEl = document.getElementById('label-count')!")).toBeLessThan(
        source.indexOf('designerEditor = await initPrintDesignerEditor({'),
      )
      expect(source.indexOf('const ids =')).toBeLessThan(
        source.indexOf('designerEditor = await initPrintDesignerEditor({'),
      )
    } else expect(source).toContain('renderDesigner: isStale => previewRenders.run(() => renderDesignerPreview(isStale))')
  })

  it('mounts the v2 designer sidebar in the shared print shell', () => {
    const shellPath = '../components/LabelPrintPageShell.astro'
    const source = readFileSync(
      fileURLToPath(new URL(shellPath, import.meta.url)),
      'utf8',
    )

    expect(source).toContain("import DesignerSidebar from './freeform-label/DesignerSidebar.astro'")
    expect(source).toContain('<DesignerSidebar />')
    expect(source).not.toContain('<LabelDesignerEditor')
  })

  it('renders Standard, Designer, and Label Sheets as accessible tabs', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(PrintSidebar, {
      props: { backLabel: 'Back' },
    })

    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-workspace-mode]'))
    expect(tabs.map(tab => tab.dataset.workspaceMode)).toEqual(['standard', 'designer', 'sheets'])
    expect(document.querySelector('[role="tablist"]')?.getAttribute('data-i18n-aria-label')).toBe('labelPrint.workspaceTabs')
    expect(tabs.map(tab => ({
      id: tab.id,
      controls: tab.getAttribute('aria-controls'),
      tabIndex: tab.tabIndex,
    }))).toEqual([
      { id: 'tab-btn-print', controls: 'tab-panel-print', tabIndex: 0 },
      { id: 'tab-btn-designer', controls: 'tab-panel-designer-v2', tabIndex: -1 },
      { id: 'tab-btn-sheets', controls: 'tab-panel-sheets', tabIndex: -1 },
    ])
  })

  it('renders associated workspace and field tabpanels from the real components', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = [
      await container.renderToString(DesignerSidebar),
      await container.renderToString(DesignerWorkspace),
      await container.renderToString(LabelSheetOutputSettings),
    ].join('')

    expect(document.querySelector('#tab-panel-designer-v2')?.getAttribute('role')).toBe('tabpanel')
    expect(document.querySelector('#tab-panel-designer-v2')?.getAttribute('aria-labelledby')).toBe('tab-btn-designer')
    expect(document.querySelector('#tab-panel-sheets')?.getAttribute('role')).toBe('tabpanel')
    expect(document.querySelector('#tab-panel-sheets')?.getAttribute('aria-labelledby')).toBe('tab-btn-sheets')

    const fieldTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-field-group-tab]'))
    expect(fieldTabs.map(tab => [tab.id, tab.getAttribute('aria-controls'), tab.tabIndex])).toEqual([
      ['freeform-field-tab-filament', 'freeform-field-panel-filament', 0],
      ['freeform-field-tab-spool', 'freeform-field-panel-spool', -1],
    ])
    for (const tab of fieldTabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)
      expect(panel?.getAttribute('role')).toBe('tabpanel')
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
  })

  it('renders an explicit Standard or Designed Label source selector in sheets mode', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)

    expect(document.querySelector('#tab-panel-sheets')).not.toBeNull()
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('[name="label-sheet-source"]')).map(input => input.value)).toEqual(['standard', 'designer'])
    expect(document.querySelector<HTMLSelectElement>('#output-mode')?.hidden).toBe(true)
    expect(document.querySelector('#sheet-designer-preset')?.getAttribute('data-i18n-aria-label')).toBe('labelPrint.designedLabelPreset')
    expect(document.querySelector('#sheet-selected-label-size')).not.toBeNull()
    expect(document.querySelector('[data-i18n="labelPrint.sheetDefinedLabelSize"]')?.textContent).toBe('Label paper layout defined size:')
    expect(document.querySelector('#sheet-label-size .sheet-label-size-value')).not.toBeNull()
    expect(document.querySelector('#sheet-update-preset')?.getAttribute('data-i18n')).toBe('labelDesigner.updatePreset')
    expect(document.querySelector('#sheet-delete-preset')?.getAttribute('data-i18n-aria-label')).toBe('labelPrint.deletePaperPreset')
    expect(document.querySelector('.sheet-layout-guide')?.getAttribute('data-i18n-aria-label')).toBe('labelPrint.paperLayout')
    expect(document.querySelectorAll('[data-i18n-aria-label="labelPrint.paperGeometryGuide"]')).toHaveLength(2)
  })

  it('preserves long translated tab labels as text', async () => {
    const container = await AstroContainer.create()
    const longDesignerLabel = 'Etikettendesigner mit besonders ausführlicher Bezeichnung'
    document.body.innerHTML = await container.renderToString(PrintSidebar, {
      props: {
        backLabel: 'Zurück',
        standardLabel: 'Standardetikett mit ausführlicher Bezeichnung',
        designerLabel: longDesignerLabel,
        sheetsLabel: 'Etikettenbögen mit gespeicherten Vorlagen',
      },
    })

    const designer = document.querySelector<HTMLButtonElement>('#tab-btn-designer')!
    expect(designer.textContent).toBe(longDesignerLabel)
    expect(designer.getAttribute('aria-label')).toBeNull()
  })

  it('persists the selected sheet label source and designed preset', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    const changed: string[] = []
    const controls = bindLabelSheetControls(() => changed.push('changed'))
    const designer = document.querySelector<HTMLInputElement>('[name="label-sheet-source"][value="designer"]')!
    const preset = document.querySelector<HTMLSelectElement>('#sheet-designer-preset')!
    const option = document.createElement('option')
    option.textContent = 'Compact'
    option.value = 'Compact'
    preset.append(option)

    designer.click()
    preset.value = 'Compact'
    preset.dispatchEvent(new Event('change', { bubbles: true }))

    expect(controls.getSource()).toEqual({ type: 'designer', presetName: 'Compact' })
    expect(preset.disabled).toBe(false)
    expect(JSON.parse(localStorage.getItem('filaman-label-sheet-source-v1')!)).toEqual({ type: 'designer', presetName: 'Compact' })
    expect(changed.length).toBeGreaterThan(0)
  })

  it('shows preset controls only for Designed Label and edits the selected preset', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    document.querySelector<HTMLElement>('#tab-panel-sheets')!.hidden = false
    const controls = bindLabelSheetControls(() => undefined)
    controls.setDesignerPresets([
      { label: 'Spool presets', presets: [{ source: 'spool', name: 'Compact', widthMm: 40, heightMm: 30 }] },
      { label: 'Standard presets', presets: [{ source: 'builtin', name: 'Wide', widthMm: 60, heightMm: 40 }] },
    ])
    const preset = document.querySelector<HTMLSelectElement>('#sheet-designer-preset')!
    const edit = document.querySelector<HTMLButtonElement>('#sheet-edit-designer')!
    const selectedSize = document.querySelector<HTMLElement>('#sheet-selected-label-size')!
    const editedPresets: string[] = []
    edit.addEventListener('label-designer-edit', event => {
      editedPresets.push((event as CustomEvent<{ presetName: string }>).detail.presetName)
    })

    expect(preset.closest('[hidden]')).not.toBeNull()
    expect(edit.closest('[hidden]')).not.toBeNull()
    document.querySelector<HTMLInputElement>('[name="label-sheet-source"][value="designer"]')!.click()
    expect(preset.closest('[hidden]')).toBeNull()
    expect(edit.closest('[hidden]')).toBeNull()
    expect(preset.disabled).toBe(false)
    expect(Array.from(preset.querySelectorAll('optgroup')).map(group => group.label)).toEqual([
      'Spool presets',
      'Standard presets',
    ])
    expect(Array.from(preset.options).map(option => option.value)).toEqual(['spool:Compact', 'builtin:Wide'])
    expect(selectedSize.textContent).toBe('Selected label size: 40 × 30 mm')
    preset.value = 'builtin:Wide'
    preset.dispatchEvent(new Event('change', { bubbles: true }))
    expect(selectedSize.textContent).toBe('Selected label size: 60 × 40 mm')
    edit.click()
    expect(editedPresets).toEqual(['Wide'])

    document.querySelector<HTMLInputElement>('[name="label-sheet-source"][value="standard"]')!.click()
    expect(preset.closest('[hidden]')).not.toBeNull()
    expect(edit.disabled).toBe(true)
    controls.setSource({ type: 'designer', presetSource: 'spool', presetName: 'Compact' })
    expect(preset.closest('[hidden]')).toBeNull()
    expect(preset.value).toBe('spool:Compact')
    expect(controls.getSource()).toEqual({ type: 'designer', presetSource: 'spool', presetName: 'Compact' })
  })

  it('restores the saved designer preset after its options load', async () => {
    const saved = { type: 'designer', presetName: 'Wide' }
    localStorage.setItem('filaman-label-sheet-source-v1', JSON.stringify(saved))
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    const controls = bindLabelSheetControls(() => undefined)

    controls.setDesignerPresets([{
      label: 'Spool presets',
      presets: ['Compact', 'Wide'].map(name => ({ source: 'spool', name })),
    }])

    expect(controls.getSource()).toEqual({ ...saved, presetSource: 'spool' })
    expect(JSON.parse(localStorage.getItem('filaman-label-sheet-source-v1')!)).toEqual({ ...saved, presetSource: 'spool' })
    controls.setSource({ type: 'designer', presetSource: 'spool', presetName: 'Compact' })
    controls.setDesignerPresets([{
      label: 'Spool presets',
      presets: ['Compact', 'Wide'].map(name => ({ source: 'spool', name })),
    }])
    expect(controls.getSource()).toEqual({ type: 'designer', presetSource: 'spool', presetName: 'Compact' })
  })

  it('keeps the selected preset identity when moving between spool and filament sheets', async () => {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    const spoolControls = bindLabelSheetControls(() => undefined, undefined, 'spool')
    const groups = [
      { label: 'Spool presets', presets: [{ source: 'spool' as const, name: 'Shared' }] },
      { label: 'Filament presets', presets: [{ source: 'filament' as const, name: 'Shared' }] },
    ]
    spoolControls.setDesignerPresets(groups)
    spoolControls.setSource({ type: 'designer', presetSource: 'spool', presetName: 'Shared' })

    document.body.innerHTML = await container.renderToString(LabelSheetOutputSettings)
    const filamentControls = bindLabelSheetControls(() => undefined, undefined, 'filament')
    filamentControls.setDesignerPresets(groups.toReversed())

    expect(filamentControls.getSource()).toEqual({
      type: 'designer', presetSource: 'spool', presetName: 'Shared',
    })
    expect(document.querySelector<HTMLSelectElement>('#sheet-designer-preset')!.value).toBe('spool:Shared')
  })
})

describe('compact responsive print layout', () => {
  it('keeps controls beside a shrinking preview and keeps mobile actions touch-sized', () => {
    const base = readFileSync(`${componentsDirectory}LabelPrintBaseStyles.astro`, 'utf8')
    const single = readFileSync(`${componentsDirectory}SingleLabelPrintStyles.astro`, 'utf8')
    const batch = readFileSync(`${componentsDirectory}BatchLabelPrintStyles.astro`, 'utf8')
    const sheet = readFileSync(`${componentsDirectory}LabelSheetOutputSettings.astro`, 'utf8')
    const styles = `${base}\n${single}\n${batch}\n${sheet}`

    expect(styles).toMatch(/@media \(max-width: 900px\)/)
    expect(styles).toMatch(/\.preview-container\s*\{[^}]*min-width:\s*0/s)
    expect(styles).toMatch(/\.print-page:not\(:has\(#freeform-designer-workspace\.is-active\)\)\s*\{[^}]*flex-direction:\s*column/s)
    expect(styles).toMatch(/\.print-page-single:not\(:has\(#freeform-designer-workspace\.is-active\)\) \.preview-container/)
    expect(styles).toMatch(/\.print-page-batch:not\(:has\(#freeform-designer-workspace\.is-active\)\) \.preview-container/)
    expect(styles).toMatch(/\.fm-btn\s*\{[^}]*min-height:\s*44px/s)
    expect(styles).toMatch(/\.tab-btn\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s)
    expect(styles).toMatch(/#sheet-label-size\s*\{[^}]*display:\s*grid/s)
    expect(styles).toMatch(/\.sheet-label-size-value\s*\{[^}]*white-space:\s*nowrap/s)
  })

  it('collapses the Shape label with the other compact add tools', () => {
    const workspace = readFileSync(`${componentsDirectory}freeform-label/DesignerWorkspace.astro`, 'utf8')

    expect(workspace).toMatch(/\[data-designer-add\]:not\(\[data-designer-add='text'\]\).*\[data-shape-menu-trigger\].*\.freeform-tool-label/s)
  })

})

async function createSheetDesignerHarness() {
  const container = await AstroContainer.create()
  document.body.innerHTML = [
    await container.renderToString(PrintSidebar, { props: { backLabel: 'Back' } }),
    await container.renderToString(StandardLabelSettingsPanel),
    await container.renderToString(DesignerSidebar),
    await container.renderToString(DesignerWorkspace),
    await container.renderToString(LabelSheetOutputSettings),
    await container.renderToString(PrintActionFooter),
  ].join('')
  const saveFailure = { value: false }
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(
    init?.method === 'PUT' ? '{}' : '[]', { status: init?.method === 'PUT' && saveFailure.value ? 500 : 200 },
  )))
  const controls = bindLabelSheetControls(() => undefined)
  const tabs = bindLabelPrintWorkspaceTabs({
    sheetControls: controls, outputControls: getLabelOutputControls(), storageKey: 'test-mode', initialMode: 'standard', onChange: () => undefined,
  })
  const editor = await initPrintDesignerEditor({
    presetsKey: SPOOL_LABEL_PRESETS_KEY, settingsKey: 'test-design', entityType: 'spool',
    onChange: async () => undefined, sheetControls: controls, activateDesigner: () => tabs.activate('designer'),
  })
  return { controls, editor, saveFailure, tabs }
}

function loadLetterSheet(controls: LabelSheetControls, activateSheets: () => void) {
  activateSheets()
  const preset = document.querySelector<HTMLSelectElement>('#sheet-preset')!
  preset.value = [...preset.options].find(option => option.textContent?.startsWith('Letter'))!.value
  preset.dispatchEvent(new Event('change'))
  document.querySelector<HTMLButtonElement>('#sheet-load-preset')!.click()
  return getLabelSheetLayout(controls.getSettings())
}

function openSelectedDesigner(controls: LabelSheetControls) {
  const selectedDesign = createDefaultLabelDesign('spool')
  selectedDesign.elements.find(element => element.type === 'text')!.template = 'Keep my custom template'
  localStorage.setItem(SPOOL_LABEL_PRESETS_KEY, JSON.stringify({ version: 2, presets: [{ name: 'Selected custom label', data: { version: 2, design: selectedDesign } }] }))
  controls.setDesignerPresets([{
    label: 'Spool presets', presets: [{ source: 'spool', name: 'Selected custom label' }],
  }])
  controls.setSource({ type: 'designer', presetSource: 'spool', presetName: 'Selected custom label' })
  document.querySelector<HTMLButtonElement>('[data-sheet-create]')!.click()
  return selectedDesign
}

describe('sheet label creation', () => {
  it('creates a correctly sized standard label', async () => {
    const { controls, editor, tabs } = await createSheetDesignerHarness()
    try {
      const dimensions = loadLetterSheet(controls, () => tabs.activate('sheets'))
      expect(document.querySelectorAll('[data-sheet-create]')).toHaveLength(1)
      document.querySelector<HTMLButtonElement>('[data-sheet-create]')!.click()
      expect(tabs.getActiveMode()).toBe('standard')
      const standard = getStandardLabelSettings(getLabelSettingsControls(), { normalizeInputs: true })
      expect(standard.widthMm).toBeCloseTo(dimensions.cellWidthMm, 3)
      expect(standard.heightMm).toBeCloseTo(dimensions.cellHeightMm, 3)
      document.querySelector<HTMLButtonElement>('[data-sheet-use="standard"]')!.click()
      expect(tabs.getActiveMode()).toBe('sheets')
      expect(controls.getSource().type).toBe('standard')
    } finally { editor.destroy() }
  })

  it('loads and resizes the selected designer preset', async () => {
    const { controls, editor, tabs } = await createSheetDesignerHarness()
    try {
      const dimensions = loadLetterSheet(controls, () => tabs.activate('sheets'))
      const selectedDesign = openSelectedDesigner(controls)

      expect(tabs.getActiveMode()).toBe('designer')
      expect(editor.getDesign().label.widthMm).toBe(dimensions.cellWidthMm)
      expect(editor.getDesign().label.heightMm).toBe(dimensions.cellHeightMm)
      expect(editor.getDesign().elements.map(element => element.id)).toEqual(selectedDesign.elements.map(element => element.id))
      expect(editor.getDesign().elements[0]).toMatchObject({ template: 'Keep my custom template' })
      expect(JSON.parse(localStorage.getItem(SPOOL_LABEL_PRESETS_KEY)!).presets[0].data.design).toEqual(selectedDesign)
      const qr = editor.getDesign().elements.find(element => element.type === 'qr')!
      expect(qr.w).toBe(qr.h)
      const name = document.querySelector<HTMLInputElement>('#freeform-preset-name')!
      expect(name.value).toContain('Letter')
      expect(name.value).toContain('66.7 × 25.4 mm')
      name.focus()
      expect(name.selectionEnd! - name.selectionStart!).toBe(name.value.length)
    } finally { editor.destroy() }
  })

  it('keeps the designer open after a failed save and returns after a successful save', async () => {
    const { controls, editor, saveFailure, tabs } = await createSheetDesignerHarness()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      loadLetterSheet(controls, () => tabs.activate('sheets'))
      openSelectedDesigner(controls)
      const name = document.querySelector<HTMLInputElement>('#freeform-preset-name')!
      name.value = 'My sheet labels'
      name.dispatchEvent(new Event('input'))
      const width = document.querySelector<HTMLInputElement>('#freeform-label-width')!
      width.dispatchEvent(new Event('change'))
      expect(name.value).toBe('My sheet labels')
      const use = document.querySelector<HTMLButtonElement>('[data-sheet-use="designer"]')!
      const save = document.querySelector<HTMLButtonElement>('#freeform-preset-save')!
      expect(use.parentElement).toBe(save.parentElement)
      expect(use.dataset.saved).toBe('false')

      saveFailure.value = true
      use.click()
      await vi.waitFor(() => expect(use.disabled).toBe(false))
      expect(JSON.parse(String((vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT')![1] as RequestInit).body)).create_only).toBe(true)
      expect(warning).toHaveBeenCalledWith('Could not save label presets to the database', expect.anything())
      expect(tabs.getActiveMode()).toBe('designer')
      expect(use.dataset.saved).toBe('false')

      saveFailure.value = false
      save.click()
      await vi.waitFor(() => expect(use.dataset.saved).toBe('true'))
      name.value = 'Another name'
      name.dispatchEvent(new Event('input'))
      expect(use.dataset.saved).toBe('false')
      name.value = 'My sheet labels'
      name.dispatchEvent(new Event('input'))
      expect(use.dataset.saved).toBe('true')
      const originalWidth = width.value
      width.value = '70'
      width.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(use.dataset.saved).toBe('false'))
      width.value = originalWidth
      width.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(use.dataset.saved).toBe('true'))
      const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').length
      const writesBeforeReturn = writes()
      use.click()
      await vi.waitFor(() => expect(tabs.getActiveMode()).toBe('sheets'))
      expect(writes()).toBe(writesBeforeReturn)
      expect(controls.getSource()).toEqual({ type: 'designer', presetSource: 'spool', presetName: 'My sheet labels' })
      const saved = JSON.parse(localStorage.getItem(SPOOL_LABEL_PRESETS_KEY)!)
      expect(saved.presets.find((item: {name: string}) => item.name === name.value).data.design).toEqual(editor.getDesign())

      document.querySelector<HTMLButtonElement>('[data-sheet-create]')!.click()
      name.value = 'My sheet labels'
      use.click()
      await vi.waitFor(() => expect(use.disabled).toBe(false))
      expect(tabs.getActiveMode()).toBe('designer')
      expect(JSON.parse(localStorage.getItem(SPOOL_LABEL_PRESETS_KEY)!)).toEqual(saved)
    } finally {
      warning.mockRestore()
      editor.destroy()
    }
  })
})
