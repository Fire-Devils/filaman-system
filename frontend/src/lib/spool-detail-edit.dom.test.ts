// @vitest-environment happy-dom
import { changedNativeFields, createDetailEditSession, setFormFieldValue } from './detail-edit'
import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { buildSpoolUpdatePayload } from './spool-detail'
import { prepareExtraFieldUpdate } from './entity-extra-fields'

const source = readFileSync('src/pages/spools/[id]/index.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
const parsed = createSourceFile('detail.ts', source, ScriptTarget.Latest, true)
const handlers = parsed.statements.filter(node => isFunctionDeclaration(node) && ['bindSpoolContentActions', 'exitEditMode', 'updateSpoolActionState'].includes(node.name?.text || '')).map(node => node.getText(parsed)).join('\n')
const bind = new Function('runtime', `
  const { printerSetup, renderSpool } = runtime;
  let pendingSpoolActions = 0, editing = true;
  ${transpileModule(handlers, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
  bindSpoolContentActions();
  return () => editing;
`)
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['btn-cancel-edit', 'btn-edit-spool'])('keeps edit mode and form intact when %s is clicked during Save', id => {
  document.body.innerHTML = '<button id="btn-edit-spool"></button><button id="btn-cancel-edit"></button>'
  const renderSpool = vi.fn()
  const setEditing = vi.fn()
  const isEditing = bind({ printerSetup: { isSaving: () => true, setEditing }, renderSpool })
  document.getElementById(id)!.click()
  expect(isEditing()).toBe(true)
  expect(renderSpool).not.toHaveBeenCalled()
  expect(setEditing).not.toHaveBeenCalled()
})

it.each([0, 2])('uses persisted spool values after printer failure, even with %i failed snapshot requests', async refreshFailures => {
  history.replaceState(null, '', '/spools/17?edit=1')
  document.body.innerHTML = '<main><button id="btn-edit-spool"></button><button id="btn-cancel-edit"></button><form id="spool-inline-form"><select name="filament_id"><option value="3" selected>Old filament</option><option value="4">New filament</option></select><input name="lot_number" value="Before"><div id="spool-system-fields-editor"></div><div id="spool-custom-fields-editor"></div><button id="btn-add-field" type="button"></button></form><button form="spool-inline-form" type="submit"></button><p id="spool-edit-error" class="hidden"></p></main>'
  const initial = { id: 17, filament_id: 3, lot_number: 'Before' }
  let persisted = initial
  let failedRefreshes = 0
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') persisted = { ...initial, ...JSON.parse(String(init.body)) }
    else if (failedRefreshes++ < refreshFailures) return new Response(null, { status: 503 })
    return Response.json(persisted)
  })
  vi.stubGlobal('fetch', fetchMock)
  const renderSpool = vi.fn()
  const functions = parsed.statements.filter(node => isFunctionDeclaration(node) && ['setupInlineEditor', 'bindSpoolContentActions', 'exitEditMode', 'refreshSpoolSnapshot', 'updateSpoolActionState', 'runSpoolAction'].includes(node.name?.text || '')).map(node => node.getText(parsed)).join('\n')
  const runtime = new Function('runtime', `
    const { initial, buildSpoolUpdatePayload, prepareExtraFieldUpdate, editSession, changedNativeFields, setFormFieldValue } = runtime;
    let pendingSpoolActions=0, remainingRequest=0, spool=initial, editing=true, spoolNeedsRefresh=false, spoolDraftObserver=null, spoolProfileLookup=null, updatePrinterSaveState=()=>{};
    const id='17', spoolSystemFieldMap={}, CACHE_KEYS={FILAMENTS:'filaments'};
    const getAbortSignal=()=>undefined, isAbortError=()=>false, getCsrfToken=()=>'', t=value=>value, invalidateCachePrefix=()=>{};
    const cachedFetchAllPages=async()=>({items:[]}), captureDetailEditPosition=()=>()=>{};
    const createEntityExtraFieldEditor=()=>({setSystemFieldKeys:()=>{}, setData:()=>{}, getSnapshot:()=>''});
    const collectExtraFieldPayload=()=>({customFields:{},customFieldDefinitions:{}});
    const renderSpool=()=>runtime.renderSpool(spool);
    const printerSetup={isSaving:()=>false, isDirty:()=>false, setEditing:async()=>{}, setFilament:async()=>{}, save:async(save)=>{await save(); throw new Error('Printer rejected');}};
    ${transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
    return {start:async()=>{await setupInlineEditor();bindSpoolContentActions();},snapshot:()=>spool,dispose:()=>spoolDraftObserver?.disconnect()};
  `)({ initial, buildSpoolUpdatePayload, prepareExtraFieldUpdate, renderSpool, changedNativeFields, setFormFieldValue, editSession: createDetailEditSession('/api/v1/spools/17?include_metrics=true', () => 'spools.failedLoadSingle') })
  await runtime.start()
  const form = document.getElementById('spool-inline-form') as HTMLFormElement
  const lot = form.elements.namedItem('lot_number') as HTMLInputElement
  lot.value = 'Persisted'
  ;(form.elements.namedItem('filament_id') as HTMLSelectElement).value = '4'
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.textContent).toBe('Printer rejected'))
  expect(lot.value).toBe('Persisted')
  if (refreshFailures) {
    document.getElementById('btn-cancel-edit')!.click()
    await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.textContent).toBe('spools.failedLoadSingle'))
    expect(renderSpool).not.toHaveBeenCalled()
    expect(lot.value).toBe('Persisted')
  } else expect(runtime.snapshot()).toMatchObject({ lot_number: 'Persisted', filament_id: 4 })
  document.getElementById('btn-cancel-edit')!.click()
  await vi.waitFor(() => expect(renderSpool).toHaveBeenLastCalledWith(persisted))
  document.getElementById('btn-edit-spool')!.click()
  await vi.waitFor(() => expect(renderSpool).toHaveBeenCalledTimes(2))
  expect(renderSpool).toHaveBeenLastCalledWith(persisted)
  runtime.dispose()
})
