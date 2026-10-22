import { readFileSync } from 'node:fs'
import { createSourceFile, isImportDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import PreviewZoomBar from '../components/PreviewZoomBar.astro'
import LabelSheetOutputSettings from '../components/LabelSheetOutputSettings.astro'
import StandardLabelSettingsPanel from '../components/StandardLabelSettingsPanel.astro'
import PrintActionFooter from '../components/PrintActionFooter.astro'
import PrintSidebar from '../components/PrintSidebar.astro'
import DesignerSidebar from '../components/freeform-label/DesignerSidebar.astro'
import DesignerWorkspace from '../components/freeform-label/DesignerWorkspace.astro'
import * as printPage from './label-print-page'
import * as printWorkspace from './label-print-workspace'
import * as labelStandard from './label-standard'
import * as labelDesigner from './label-designer'
import * as labelExport from './label-export'
import * as labelSheet from './label-sheet'
import * as filamentLabelData from './filament-label-data'
import * as labelExtraFields from './label-extra-fields'
import * as labelPresetStorage from './label-preset-storage'
import * as labelPrintSession from './label-print-session'
import * as spoolLabelLookups from './spool-label-lookups'
import * as spoolLabelData from './spool-label-data'
import * as format from './format'
import * as entityExtraFields from './entity-extra-fields'
import * as i18n from './i18n'
import { labelAssetContentUrl } from './freeform-label/assets'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const markupCache = new Map<string, string>()
type Entity = 'filament' | 'spool'
const dependencies = {
  ...printPage, ...printWorkspace, ...labelStandard, ...labelDesigner, ...labelExport,
  ...labelSheet, ...filamentLabelData, ...labelExtraFields, ...labelPresetStorage,
  ...labelPrintSession, ...spoolLabelLookups, ...spoolLabelData, ...format, ...entityExtraFields, ...i18n, labelAssetContentUrl,
}

export async function renderPrintPage(entity: Entity, batch = false) {
  const key = `${entity}-${batch}`
  if (!markupCache.has(key)) {
    const renderer = await AstroContainer.create()
    const markup = '<aside class="print-sidebar">'
      + await renderer.renderToString(PrintSidebar, { props: { backLabelId: batch ? 'btn-back-label' : 'label-back' } })
      + await renderer.renderToString(StandardLabelSettingsPanel, { props: { extraFieldsMode: batch ? 'batch' : 'single', includeSpoolFields: batch && entity === 'spool' } })
      + await renderer.renderToString(DesignerSidebar)
      + await renderer.renderToString(LabelSheetOutputSettings)
      + await renderer.renderToString(PrintActionFooter)
      + '</aside><main class="preview-container" id="preview-container">'
      + await renderer.renderToString(PreviewZoomBar)
      + '<div class="preview-scroll-area">'
      + await renderer.renderToString(DesignerWorkspace)
      + '<div id="label-preview" class="label-preview"></div><div id="label-count"></div></div></main>'
    markupCache.set(key, markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''))
  }
  document.body.innerHTML = markupCache.get(key)!
}

export function runPrintPage(entity: Entity, batch: boolean, overrides: Record<string, unknown> = {}): Promise<void> {
  const bindings = { ...dependencies, ...overrides }
  const source = readFileSync(`src/pages/${entity}s/${batch ? '' : '[id]/'}print.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('print.ts', source, ScriptTarget.Latest, true)
  const production = parsed.statements.filter(node => !isImportDeclaration(node)).map(node => node.getText(parsed)).join('\n')
  const run = new AsyncFunction(...Object.keys(bindings), transpileModule(production, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText)
  return run(...Object.values(bindings))
}
