// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchSequential } from './cache'

function detailLoader(entity: 'spool' | 'filament') {
  const source = readFileSync(`src/pages/${entity}s/[id]/index.astro`, 'utf8')
  const script = source.match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('detail.ts', script, ScriptTarget.Latest, true)
  const name = entity === 'spool' ? 'loadData' : 'loadFilament'
  const loader = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name)!
  return new Function('runtime', `
    const { fetchSequential, cachedFetchAllPages, CACHE_KEYS, getAbortSignal, isAbortError,
      renderSpool, renderFilament, renderFilamentEditor, openSpoolExtraFields, openFilamentExtraFields,
      loadPrintersForParams, initPerModelProfilePicker, loadEvents, setupActions, loadSpools, loadPrinters,
      getCsrfToken, getCsrfTokenGlobal, t, extraFieldsDialogRequested, editMode } = runtime;
    const id = '16';
    let spool, statuses, locations, activeDevices, spoolSystemFieldMap = {}, filamentSystemFieldMap = {}, systemFieldMap = {};
    ${transpileModule(loader.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
    return ${name}();
  `)
}

const loaders = { spool: detailLoader('spool'), filament: detailLoader('filament') }
const entityData = { id: 16, filament_id: 10, custom_fields: { compatible: ['AMS', 'AMS 2 Pro'] } }

async function loadDetail(entity: 'spool' | 'filament', failedTarget: string | null, failure: number | 'network' | 'malformed', editMode = false) {
  document.body.innerHTML = `<div id="${entity}-content">Loading</div>`
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname.endsWith('/system-extra-fields') && url.searchParams.get('target_type') === failedTarget) {
      if (failure === 'network') throw new TypeError('Failed to fetch')
      return new Response('{}', { status: failure === 'malformed' ? 200 : failure })
    }
    const data = url.pathname === `/api/v1/${entity}s/16` ? entityData : []
    return new Response(JSON.stringify(data), { status: 200 })
  })
  const render = vi.fn()
  const openDialog = vi.fn()
  const noop = () => {}
  await loaders[entity]({
    fetchSequential, cachedFetchAllPages: async () => ({ items: [] }), CACHE_KEYS: {},
    getAbortSignal: noop, isAbortError: () => false, t: (key: string) => key,
    renderSpool: render, renderFilament: render, renderFilamentEditor: render,
    openSpoolExtraFields: openDialog, openFilamentExtraFields: openDialog,
    loadPrintersForParams: noop, initPerModelProfilePicker: noop, loadEvents: noop, setupActions: noop,
    loadSpools: noop, loadPrinters: noop, getCsrfToken: noop, getCsrfTokenGlobal: noop,
    extraFieldsDialogRequested: !editMode, editMode,
  })
  return { render, openDialog }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

for (const [entity, target] of [['spool', 'spool'], ['spool', 'filament'], ['filament', 'filament']] as const) {
  for (const editMode of [false, true]) {
    it.each([401, 403, 500, 'network', 'malformed'] as const)(`${entity} loader blocks ${editMode ? 'inline editing' : 'extra-field dialog'} when ${target} definitions fail (%s)`, async failure => {
      const { render, openDialog } = await loadDetail(entity, target, failure, editMode)
      expect(document.getElementById(`${entity}-content`)!.textContent).toBe(`${entity}s.failedLoadSingle`)
      expect(render).not.toHaveBeenCalled()
      expect(openDialog).not.toHaveBeenCalled()
    })
  }
}

it.each(['spool', 'filament'] as const)('%s loader accepts a successful empty definitions list', async entity => {
  const { render, openDialog } = await loadDetail(entity, null, 500)
  expect(render).toHaveBeenCalledOnce()
  expect(openDialog).toHaveBeenCalledOnce()
  expect(document.getElementById(`${entity}-content`)!.textContent).not.toContain('failedLoadSingle')
})
