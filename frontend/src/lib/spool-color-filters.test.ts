import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { expect, it } from 'vitest'
import type { HeaderFilterOption } from './table-column-filters'

const source = readFileSync('src/pages/spools/index.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
const parsed = createSourceFile('spools.ts', source, ScriptTarget.Latest, true)
const declaration = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'updateSpoolFilterOptions')!
const production = transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const blue = { value: 'Blue', label: 'Blue', color_hexes: ['#0000FF'] }
const red = { value: 'Red', label: 'Red', color_hexes: ['#FF0000'] }
const scope = (colors: typeof blue[], has_empty_colors = false) => ({ manufacturers: [], materials: [], locations: [], has_empty_location: false, colors, has_empty_colors })

it('keeps selected names removable without adding out-of-scope wheel samples', () => {
  const options: Record<string, HeaderFilterOption[]> = {}
  const columnFilters: Record<string, { type: 'multi'; values: string[] }> = {}
  const update = new Function('spoolFilterFacets', 'statuses', 'columnFilters', 'splHeaderFilters', 't', `${production}; return updateSpoolFilterOptions;`)(
    { used_status_ids: [1, 2, 3], by_status: {
      1: scope([blue], true),
      2: scope([{ ...blue, color_hexes: ['#000080'] }]),
      3: scope([red]),
    } },
    [{ id: 1, key: 'opened' }, { id: 2, key: 'new' }, { id: 3, key: 'archived' }],
    columnFilters,
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } },
    () => 'Empty',
  )
  update()
  expect(options.colors).toEqual([
    { value: '', label: 'Empty' },
    { value: 'Blue', label: 'Blue', colorHexes: ['#0000FF', '#000080'] },
  ])
  columnFilters.status = { type: 'multi', values: ['3'] }
  update()
  expect(options.colors).toEqual([{ value: 'Red', label: 'Red', colorHexes: ['#FF0000'] }])
  columnFilters.colors = { type: 'multi', values: ['Blue', ''] }
  update()
  expect(options.colors).toEqual([
    { value: '', label: 'Empty' },
    { value: 'Blue', label: 'Blue', colorHexes: [] },
    { value: 'Red', label: 'Red', colorHexes: ['#FF0000'] },
  ])
  delete columnFilters.colors
  update()
  expect(options.colors).toEqual([{ value: 'Red', label: 'Red', colorHexes: ['#FF0000'] }])
  delete columnFilters.status
  update()
  expect(options.colors.map(option => option.value)).toEqual(['', 'Blue'])
})

it('does not assume archived statuses are active when status reference loading failed', () => {
  const options: Record<string, HeaderFilterOption[]> = {}
  const update = new Function('spoolFilterFacets', 'statuses', 'columnFilters', 'splHeaderFilters', 't', `${production}; return updateSpoolFilterOptions;`)(
    { used_status_ids: [1, 3], by_status: { 1: scope([blue]), 3: scope([red]) } },
    [], {}, { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, () => 'Empty',
  )
  update()
  expect(options.colors).toEqual([])
})

it('keeps a selected name removable after its last spool-backed color disappears', () => {
  const options: Record<string, HeaderFilterOption[]> = {}
  const update = new Function('spoolFilterFacets', 'statuses', 'columnFilters', 'splHeaderFilters', 't', `${production}; return updateSpoolFilterOptions;`)(
    { used_status_ids: [1], by_status: { 1: scope([red]) } },
    [{ id: 1, key: 'active' }], { colors: { type: 'multi', values: ['Deleted Blue'] } },
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, () => 'Empty',
  )
  update()
  expect(options.colors).toEqual([
    { value: 'Deleted Blue', label: 'Deleted Blue', colorHexes: [] },
    { value: 'Red', label: 'Red', colorHexes: ['#FF0000'] },
  ])
})

it.each([false, true])('handles failed facet refresh without blocking rows or swallowing aborts (aborted=%s)', async (aborted) => {
  const declaration = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'refreshSpoolFilterOptions')!
  const refreshSource = transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  const options: Record<string, HeaderFilterOption[]> = { colors: [{ value: 'Blue', label: 'Blue', colorHexes: ['#0000FF'] }] }
  let rowsReloaded = false
  const refresh = new Function('getAbortSignal', 'fetchSpoolFilterFacets', 'updateSpoolFilterOptions', 'splHeaderFilters', 'isAbortError', 'console', `let spoolFilterFacets = {}; ${refreshSource}; return refreshSpoolFilterOptions;`)(
    () => undefined, async () => { throw new Error('Offline') }, () => {},
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, () => aborted, { error: () => {} },
  )
  const result = refresh().then(() => { rowsReloaded = true })
  if (aborted) {
    await expect(result).rejects.toThrow('Offline')
    expect(rowsReloaded).toBe(false)
    expect(options.colors[0].colorHexes).toEqual(['#0000FF'])
    return
  }
  await result
  expect(rowsReloaded).toBe(true)
  expect(options.colors).toEqual([])
})
