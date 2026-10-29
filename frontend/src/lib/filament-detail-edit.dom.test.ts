// @vitest-environment happy-dom
import { changedNativeFields, createDetailEditSession } from './detail-edit'
import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { captureDetailEditPosition } from './detail-edit-position'
import { prepareExtraFieldUpdate } from './entity-extra-fields'

const source = readFileSync('src/pages/filaments/[id]/index.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
const parsed = createSourceFile('detail.ts', source, ScriptTarget.Latest, true)
const handler = parsed.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'setFilamentEditing')!
const bind = new Function('runtime', `
  const { printerSetup, filamentFormController, renderFilamentEditor, captureDetailEditPosition, editSession } = runtime;
  let currentFilament = { id:16 }; let changingEdit = false, editMode = false, filamentNeedsRefresh = false;
  const renderFilament = () => {}; const updateScrollIdentity = () => {}; const t = () => ''; const formatHeaderId = value => value; const isAbortError = () => false;
  ${transpileModule(handler.getText(parsed), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
  return setFilamentEditing;
`)
afterEach(() => { document.body.innerHTML = ''; document.documentElement.classList.remove('sidebar-collapsed'); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('toggles fields in place without navigating, collapsing the sidebar or losing the section position', async () => {
  history.replaceState(null, '', '/filaments/16')
  document.body.innerHTML = '<main><div class="detail-page-toolbar"><div class="detail-page-actions"></div><button id="btn-enter-filament-edit"></button><button id="btn-edit-filament"></button><div id="filament-form-actions" class="hidden"></div><span id="unsaved-changes-status"></span></div><div id="filament-content"><div class="filament-hero"></div></div><div id="filament-editor" class="hidden"></div></main>'
  const main = document.querySelector('main')!; main.scrollTop = 800
  const form = { resetInitialData: vi.fn(), captureBaseline: vi.fn() }
  const setEditing = vi.fn(async () => {})
  const toggle = bind({ editSession: { edit: async (apply: (data: unknown) => Promise<void>) => apply({ id: 16 }), invalidate: () => {} }, printerSetup: { isSaving: () => false, setEditing }, filamentFormController: form, captureDetailEditPosition, renderFilamentEditor: async () => {
    document.getElementById('filament-content')!.classList.add('hidden')
    document.getElementById('filament-editor')!.classList.remove('hidden')
    document.getElementById('filament-form-actions')!.classList.remove('hidden')
  } })
  await toggle(true)
  expect(location.pathname).toBe('/filaments/16')
  expect(location.search).toBe('?edit=1')
  expect(document.documentElement.classList.contains('sidebar-collapsed')).toBe(false)
  expect(main.scrollTop).toBe(800)
  await toggle(false)
  expect(location.search).toBe('')
  expect(document.getElementById('filament-content')!.classList.contains('hidden')).toBe(false)
  expect(document.getElementById('filament-editor')!.classList.contains('hidden')).toBe(true)
  expect(setEditing.mock.calls).toEqual([[true], [false]])
  expect(form.resetInitialData).toHaveBeenCalledWith({ id: 16 })
  expect(main.scrollTop).toBe(800)
})

function editorFixture(failReferences = false) {
  history.replaceState(null, '', '/filaments/16')
  document.body.innerHTML = '<main><div class="detail-page-toolbar"><div class="detail-page-actions"></div><button id="btn-enter-filament-edit"></button><button id="btn-edit-filament"></button><a id="filament-form-cancel"></a><div id="filament-form-actions" class="hidden"></div><span id="unsaved-changes-status"></span></div><div id="filament-content"><div class="filament-hero"></div></div><div id="filament-editor" class="hidden"><div id="filament-editor-hero"></div><form id="filament-form"></form></div></main>'
  let submit!: (payload: unknown) => Promise<void>
  const initial = { id: 16, designation: 'Before' }
  const controller = {
    loadReferenceData: vi.fn().mockRejectedValueOnce(new Error('Metadata unavailable')).mockResolvedValue(undefined),
    resetInitialData: vi.fn(), captureBaseline: vi.fn(), updateDirtyState: vi.fn(),
    prepareNativeFieldUpdate: (scalar: Record<string, unknown>) => changedNativeFields(initial, scalar),
    hasColorChanges: () => true,
    acceptNativeUpdate: vi.fn(), acceptColorUpdate: vi.fn(),
    prepareExtraFieldUpdate: (path: string, scalar: Record<string, unknown>) => prepareExtraFieldUpdate(path, { customFields: null, customFieldDefinitions: null }, { customFields: scalar.custom_fields as Record<string, unknown> ?? null, customFieldDefinitions: null }),
  }
  if (!failReferences) controller.loadReferenceData.mockReset().mockResolvedValue(undefined)
  const functions = parsed.statements.filter(node => isFunctionDeclaration(node) && ['renderFilamentEditor', 'setFilamentEditing', 'refreshFilamentSnapshot'].includes(node.name?.text || '')).map(node => node.getText(parsed)).join('\n')
  const renderView = vi.fn()
  const runtime = new Function('runtime', `
    const { createFilamentFormController, printerSetup, renderFilament, captureDetailEditPosition, editSession } = runtime;
    let filamentFormController=null, filamentReferencesLoaded=false, currentFilament=runtime.initial, filamentNeedsRefresh=false, changingEdit=false, editMode=false;
    const id='16', CACHE_KEYS={FILAMENTS:'filaments'}; const getAbortSignal=()=>undefined, getCsrfTokenGlobal=()=>'', invalidateCachePrefix=()=>{};
    const t=value=>value, formatHeaderId=value=>value, updateScrollIdentity=()=>{}, isAbortError=()=>false;
    ${transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
    return {enter:()=>renderFilamentEditor(currentFilament), cancel:()=>setFilamentEditing(false)};
  `)({ initial, editSession: createDetailEditSession('/api/v1/filaments/16', () => 'Failed'), captureDetailEditPosition, renderFilament: renderView, printerSetup: { isDirty: () => false, isSaving: () => false, setEditing: async () => {}, save: async (save: () => Promise<void>) => { await save() } }, createFilamentFormController: (options: { onSubmit: typeof submit }) => { submit = options.onSubmit; return controller } })
  return { ...runtime, controller, renderView, submit: (payload: unknown) => submit(payload) }
}

it('retries failed editor reference loading before allowing another edit attempt', async () => {
  const ui = editorFixture(true)
  await expect(ui.enter()).rejects.toThrow('Metadata unavailable')
  expect(document.getElementById('filament-editor')!.classList.contains('hidden')).toBe(true)
  await ui.enter()
  expect(ui.controller.loadReferenceData).toHaveBeenCalledTimes(2)
  expect(document.getElementById('filament-editor')!.classList.contains('hidden')).toBe(false)
})
it('uses persisted scalar values after a partial save before Cancel or re-entry', async () => {
  const ui = editorFixture()
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Response.json({ id: 16, designation: 'Persisted' })
    if (init?.method === 'PUT') return Response.json({ message: 'Colors failed' }, { status: 500 })
    return Response.json({ id: 16, designation: 'Persisted' })
  }))
  await ui.enter()
  await expect(ui.submit({ scalar: { designation: 'Persisted' }, colors: [{ color_id: 12, position: 1 }] })).rejects.toThrow('Colors failed')
  await ui.cancel()
  expect(ui.renderView).toHaveBeenCalledWith({ id: 16, designation: 'Persisted' })
  await ui.enter()
  expect(ui.controller.resetInitialData).toHaveBeenLastCalledWith({ id: 16, designation: 'Persisted' })
  vi.unstubAllGlobals()
})
