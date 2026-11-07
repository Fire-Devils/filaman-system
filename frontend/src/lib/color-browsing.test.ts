import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { expect, it, vi } from 'vitest'
import { colorFilterParams } from './api'
import { isColumnFilterActive, type ColumnFilterValue } from './table-column-filters'

it.each(['filaments', 'spools'])('keeps %s color browsing paginated with a safe fallback for large selections', page => {
  const source = readFileSync(`src/pages/${page}/index.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile(`${page}.ts`, source, ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'hasLocalColumnFilters')!
  const production = transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  const requiresFullInventory = (columns: Record<string, ColumnFilterValue>) => new Function(
    'columnFilters', 'colorFilterParams', 'isColumnFilterActive', 'isEffectiveColumnFilterActive', 'colorFilterPaged',
    `${production}; return hasLocalColumnFilters();`,
  )(columns, colorFilterParams, isColumnFilterActive, (_key: string, value: ColumnFilterValue) => isColumnFilterActive(value), true)
  expect(requiresFullInventory({ colors: { type: 'multi', values: ['Red, Silk', ''] } })).toBe(false)
  expect(requiresFullInventory({ colors: { type: 'multi', values: Array.from({ length: 250 }, (_, i) => `Color ${i}`) } })).toBe(true)
  expect(requiresFullInventory({ colors: { type: 'multi', values: ['Red'] }, cf_example: { type: 'text', operator: 'contains', value: 'draft' } })).toBe(true)
})

it.each(['filaments', 'spools'])('clamps a shrinking %s result when only color sorting needs all pages', async page => {
  const source = readFileSync(`src/pages/${page}/index.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile(`${page}.ts`, source, ScriptTarget.Latest, true)
  const name = page === 'filaments' ? 'loadFilaments' : 'loadSpools'
  const declaration = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)!
  const production = transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  const load = new Function('deps', `
    const {getFilterValues, getAbortSignal, fetchAllPages, renderPage, localStorage, colorFilterParams} = deps;
    const hasLocalColumnFilters = () => false, isClientOnlySort = () => true, needsAllSpoolData = () => true;
    const isAbortError = () => false, filterSpools = x => x, filterFilaments = x => x;
    const columnFilters = {colors: {type:'multi', values:['Red']}}, statuses = [], sortKeyMap = {colors:''};
    const sortKey='colors', sortDirection='asc', pageSize=25;
    let colorFilterPaged=true, currentPage=2, filterRequestId=0, allFilaments=[], allSpools=[], totalFilaments=0, totalSpools=0;
    ${production}
    return async () => {await ${name}(); return currentPage;};
  `)({
    getFilterValues: () => ({ search: '', manufacturerIds: [], types: [], statusIds: [], locationIds: [], materials: [], groupBy: false }),
    getAbortSignal: () => undefined,
    fetchAllPages: async () => ({ items: [{ id: 1 }], total: 1 }), renderPage: vi.fn(), localStorage: { setItem: vi.fn() }, colorFilterParams,
  })
  expect(await load()).toBe(1)
})
