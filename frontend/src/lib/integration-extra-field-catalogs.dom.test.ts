// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule, type Node } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { isIntegrationExtraFieldPath } from './extra-fields'
import { normalizeSystemExtraFieldDefinitions } from './entity-extra-fields'
import { buildLegacyLabelAliases, isBuiltInLabelField } from './label-extra-fields'
import { appendLabelSettingsCheckbox } from './label-print-page'
import { isMissingExtraFieldSort } from './table-column-filters'
import { createSortableColumnHeader } from './column-key'

const definitions = [
  { key: 'filament_image_provider', label: 'Image provider', field_type: 'text' },
  { key: 'note', label: 'User note', field_type: 'text' },
]

function pageFunction(page: string, name: string): string {
  const source = readFileSync(`src/pages/${page}.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('page.ts', source, ScriptTarget.Latest, true)
  const findFunction = (node: Node): Node | undefined =>
    isFunctionDeclaration(node) && node.name?.text === name ? node : node.forEachChild(findFunction)
  const declaration = findFunction(parsed)
  if (!declaration) throw new Error(`Missing ${name} in ${page}`)
  return transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it.each(['filament', 'spool'] as const)('excludes metadata from %s list columns while keeping user fields', async entity => {
  document.body.innerHTML = '<table class="fm-table"><thead><tr><th>ID</th></tr></thead></table>'
  vi.stubGlobal('fetch', async () => Response.json(definitions))
  let groups: Array<{ columns: Array<{ key: string }> }> = []
  const picker = { updateGroups: (value: typeof groups) => { groups = value } }
  const columns = { refreshColumns() {} }
  const runtime = {
    document, fetch, isIntegrationExtraFieldPath, isMissingExtraFieldSort, createSortableColumnHeader,
    getAbortSignal() {}, isAbortError: () => false, t: (key: string) => key,
    filPicker: picker, splPicker: picker, filColumnGroups: [], splColumnGroups: [],
    filReorder: columns, splReorder: columns, filResize: columns, splResize: columns,
  }
  const name = entity === 'filament' ? 'loadFilamentExtraFieldColumns' : 'loadSpoolExtraFieldColumns'
  const displayedFields: Array<{ key: string }> = await new Function(...Object.keys(runtime), `
    let filamentExtraFields=[],spoolExtraFields=[],sortKey=null;
    ${pageFunction(`${entity}s/index`, name)}
    return ${name}().then(()=>${entity === 'filament' ? 'filamentExtraFields' : 'spoolExtraFields'});
  `)(...Object.values(runtime))
  expect(groups.flatMap(group => group.columns.map(field => field.key))).toEqual(['cf_note'])
  expect(document.querySelector('.col-cf_filament_image_provider')).toBeNull()
  expect(document.querySelector('.col-cf_note')?.textContent).toBe('User note')
  expect(displayedFields.map(field => field.key)).toEqual(['note'])
})

for (const entity of ['filament', 'spool'] as const) {
  it.each([false, true])(`hides metadata in fresh ${entity} batch choices but preserves a saved selection (%s)`, async selected => {
    document.body.innerHTML = '<h3 id="ef-section-title"></h3><div id="ef-checkboxes"></div>'
    vi.stubGlobal('fetch', async () => Response.json(definitions))
    const settings = { extraFields: selected ? { [`${entity}:filament_image_provider`]: true } : {} }
    const runtime = {
      document, fetch, isIntegrationExtraFieldPath, normalizeSystemExtraFieldDefinitions,
      buildLegacyLabelAliases, isBuiltInLabelField, appendLabelSettingsCheckbox,
      getExtraFieldDefinitionMap: () => ({}), getExtraFieldDefinitionMaps: () => ({}),
      readVersionedLabelSettings: () => settings, readStorageValue: () => JSON.stringify(settings),
      SETTINGS_KEY: 'review', SETTINGS_VERSION: 1, renderBatchPreview() {}, t: (key: string) => key,
    }
    const fields: Array<{ key: string; target_type?: string }> = await new Function(...Object.keys(runtime), `
      let systemDefinitions=[],efDefs=[];
      const filaments=[],spools=[],STANDARD_FILAMENT_EF=[],legacyFieldKeys=new Set(),systemFieldKeys=new Set(),efCheckMap={};
      ${pageFunction(`${entity}s/print`, 'efMapKey')}
      ${pageFunction(`${entity}s/print`, 'loadExtraFieldDefs')}
      return loadExtraFieldDefs().then(()=>efDefs);
    `)(...Object.values(runtime))
    expect(fields.filter(field => field.key === 'filament_image_provider').map(field => field.target_type ?? 'filament'))
      .toEqual(selected ? [entity] : [])
    expect(document.body.textContent?.includes('Image provider')).toBe(selected)
    expect(document.body.textContent).toContain('User note')
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength((entity === 'spool' ? 2 : 1) + (selected ? 1 : 0))
  })
}
