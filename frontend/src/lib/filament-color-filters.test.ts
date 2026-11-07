import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { expect, it } from 'vitest'
import type { HeaderFilterOption } from './table-column-filters'

const source = readFileSync('src/pages/filaments/index.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
const parsed = createSourceFile('filaments.ts', source, ScriptTarget.Latest, true)
const declaration = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'populateFilterDropdowns')!
const production = transpileModule(declaration.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

it.each([false, true])('clears unavailable filament colors after failed facets, preserving aborts (aborted=%s)', async (aborted) => {
  const original: HeaderFilterOption[] = [{ value: 'Blue', label: 'Blue', colorHexes: ['#0000FF'] }]
  let colors = original
  const populate = new Function('getAbortSignal', 'cachedFetch', 'CACHE_KEYS', 'filHeaderFilters', 'isAbortError', 'console', `${production}; return populateFilterDropdowns;`)(
    () => undefined, async () => { throw new Error('Offline') }, { FILAMENT_FILTER_OPTIONS: 'test' },
    { setOptions: (key: string, options: HeaderFilterOption[]) => { if (key === 'colors') colors = options } },
    () => aborted, { error: () => {} },
  )
  await populate()
  expect(colors).toEqual(aborted ? original : [])
})
