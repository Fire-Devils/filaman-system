// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  renderLabelSheetPreview,
  syncLabelSheetIndividualExportState,
  type LabelSheetControls,
  type LabelSheetSettings,
} from './label-sheet'

const printPageSources = [
  '../pages/spools/[id]/print.astro',
  '../pages/spools/print.astro',
  '../pages/filaments/[id]/print.astro',
  '../pages/filaments/print.astro',
].map(path => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  'utf8',
))

const printActionFooterPath = '../components/PrintActionFooter.astro'
const printActionFooterSource = readFileSync(
  fileURLToPath(new URL(printActionFooterPath, import.meta.url)),
  'utf8',
)

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
  document.head.innerHTML = ''
  document.body.innerHTML = `
    <div id="preview">
      <div id="source"><div class="label-preview">Sample label</div></div>
    </div>
  `
})

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('label sheet preview styling', () => {
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

      expect(messages.labelPrint.preparingPrintPdf).toBeTruthy()
      expect(messages.labelPrint.preparingBrowserPrint).toBeTruthy()
      expect(messages.labelPrint.printPopupBlocked).toBeTruthy()
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
      expect(messages.labelPrint.printHelpSystemDialog).toBeTruthy()
      expect(messages.labelPrint.printHelpPdfFallback).toBeTruthy()
      expect(
        messages.labelPrint.printHelpDownloadSetting,
      ).toBeTruthy()
      expect(messages.labelPrint.printHelpViewer).toBeUndefined()
      expect(messages.labelPrint.printHelpBrave).toBeUndefined()
      expect(messages.labelPrint.printHelpFirefox).toBeUndefined()
    },
  )
})

describe('print guidance layout', () => {
  it('keeps the wider help popup inside narrow viewports', () => {
    expect(printActionFooterSource).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.print-help-content\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*1000;[\s\S]*?left:\s*calc\(var\(--sidebar-collapsed-width\) \+ 16px\);[\s\S]*?right:\s*16px;[\s\S]*?width:\s*auto;/,
    )
  })
})

describe('print page output routing', () => {
  it('wires every print page through the shared output APIs', () => {
    for (const source of printPageSources) {
      expect(source).toContain('PrintActionFooter')
      expect(source).toContain("getElementById('btn-export-aml')")
      expect(source).toContain("getElementById('check-print-pdf')")
      expect(source).toContain('browserPrint:')
      expect(source).not.toContain('createLabelBrowserPrintJob')
      expect(source).toContain('syncLabelSheetIndividualExportState')
      expect(source).not.toContain('window.print(')
      expect(source).not.toContain('document.execCommand(')
      expect(source).not.toContain('filamanPrint')
      expect(source).not.toContain('buildLabelAml')
    }
  })
})
