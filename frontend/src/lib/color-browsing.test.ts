import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { expect, it, vi } from 'vitest'
import { colorFilterParams } from './api'
import { isColumnFilterActive, multiColumnFilter, type ColumnFilterValue } from './table-column-filters'

function pageFunction(page: string, name: string) {
  const source = readFileSync(`src/pages/${page}/index.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile(`${page}.ts`, source, ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)!
  return transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
}

it.each(['filaments', 'spools'])('keeps %s color browsing paginated with a safe fallback for large selections', page => {
  const production = pageFunction(page, 'hasLocalColumnFilters')
  const requiresFullInventory = (columns: Record<string, ColumnFilterValue>) => new Function(
    'columnFilters', 'colorFilterParams', 'isColumnFilterActive', 'isEffectiveColumnFilterActive', 'colorFilterPaged',
    `${production}; return hasLocalColumnFilters();`,
  )(columns, colorFilterParams, isColumnFilterActive, (_key: string, value: ColumnFilterValue) => isColumnFilterActive(value), true)
  expect(requiresFullInventory({ colors: { type: 'multi', values: ['Red, Silk', ''] } })).toBe(false)
  expect(requiresFullInventory({ colors: { type: 'multi', values: Array.from({ length: 250 }, (_, i) => `Color ${i}`) } })).toBe(true)
  expect(requiresFullInventory({ colors: { type: 'multi', values: ['Red'] }, cf_example: { type: 'text', operator: 'contains', value: 'draft' } })).toBe(true)
})

it.each([true, false])('uses the current Spools status scope after a delayed response (cleared: %s)', async cleared => {
  const window = { location: { search: '?status_scope=archived' } }
  const urlParams = new URLSearchParams(window.location.search)
  const statusRows = [{ id: 1, key: 'opened' }, { id: 2, key: 'archived' }]
  const response = { ok: true, json: async () => statusRows }
  let finish!: (value: typeof response) => void
  const fetch = () => new Promise<typeof response>(resolve => { finish = resolve })
  const splHeaderFilters = { setValue: vi.fn(), setOptions: vi.fn() }
  const load = new Function('deps', `
    const {window, urlParams, fetch, multiColumnFilter, splHeaderFilters} = deps;
    const columnFilters = {}, t = key => key;
    const getAbortSignal = () => undefined, updateSpoolFilterOptions = () => {}, updateFilterResets = () => {};
    let statuses = [];
    ${pageFunction('spools', 'loadSpoolStatuses')}
    return loadSpoolStatuses;
  `)({ window, urlParams, fetch, multiColumnFilter, splHeaderFilters })

  const loading = load()
  if (cleared) window.location.search = ''
  finish(response)
  await loading
  if (cleared) expect(splHeaderFilters.setValue).not.toHaveBeenCalled()
  else expect(splHeaderFilters.setValue).toHaveBeenCalledWith('status', multiColumnFilter(['2']))
})
