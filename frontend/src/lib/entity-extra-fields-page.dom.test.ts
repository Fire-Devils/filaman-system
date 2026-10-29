// @vitest-environment happy-dom
import { createDetailEditSession } from './detail-edit'
import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareExtraFieldUpdate } from './entity-extra-fields'
import { createEntityExtraFieldsDialog } from './entity-extra-fields-dialog'
import { setLang } from './i18n'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function pageDialog(entity: 'filament' | 'spool', initial: Record<string, unknown>) {
  setLang('en')
  history.replaceState(null, '', `/${entity}s/16?edit=1`)
  document.body.innerHTML = '<main><div class="detail-page-toolbar"><div class="detail-page-actions"></div><button id="btn-edit-spool"></button><button id="btn-cancel-edit"></button><div id="filament-content"><div class="filament-hero"></div></div><div id="filament-editor"></div><div id="filament-form-actions"></div><div id="unsaved-changes-status"></div></main>'
  vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  const script = readFileSync(`src/pages/${entity}s/[id]/index.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('detail.ts', script, ScriptTarget.Latest, true)
  const names = entity === 'filament'
    ? ['setFilamentEditing', 'openFilamentExtraFields', 'refreshFilamentSnapshot']
    : ['bindSpoolContentActions', 'exitEditMode', 'openSpoolExtraFields', 'refreshSpoolSnapshot', 'updateSpoolActionState']
  const functions = parsed.statements.filter(node => isFunctionDeclaration(node) && names.includes(node.name?.text || '')).map(node => node.getText(parsed)).join('\n')
  return new Function('initial', 'createEntityExtraFieldsDialog', 'prepareExtraFieldUpdate', 'editSession', `
    let currentFilament=initial, spool=initial, editing=true, editMode=true, changingEdit=false, filamentNeedsRefresh=false, spoolNeedsRefresh=false, pendingSpoolActions=0, remainingRequest=0;
    let extraFieldsDialog=null;
    const systemFieldMap={note:{key:'note',label:'Note',field_type:'text'}},spoolSystemFieldMap=systemFieldMap;
    const id='16',getCsrfTokenGlobal=()=>'',getCsrfToken=()=>'',getAbortSignal=()=>undefined,t=key=>key,isAbortError=()=>false;
    const CACHE_KEYS={FILAMENTS:'filaments'},invalidateCachePrefix=()=>{};
    const printerSetup={isSaving:()=>false,setEditing:async()=>{}},captureDetailEditPosition=()=>()=>{};
    const filamentFormController={resetInitialData(){},captureBaseline(){}};
    const renderFilament=()=>{},renderSpool=()=>{},updateScrollIdentity=()=>{},formatHeaderId=String;
    ${transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
    return ${entity === 'filament' ? '{cancel:()=>setFilamentEditing(false), open:()=>openFilamentExtraFields(currentFilament)}' : '{cancel:()=>{bindSpoolContentActions();document.getElementById("btn-cancel-edit").click()},open:()=>openSpoolExtraFields()}'};
  `)(initial, createEntityExtraFieldsDialog, prepareExtraFieldUpdate, createDetailEditSession(`/api/v1/${entity}s/16`, () => 'Failed'))
}

for (const entity of ['filament', 'spool'] as const) {
  for (const timing of ['before-open', 'while-open'] as const) {
    it.each(['set', 'clear'] as const)(`${entity} Manage fields preserves a profile %s ${timing} after Cancel`, async operation => {
      const initial = {
        id: 16,
        custom_fields: { note: 'Dry', bambu_profile_base_name: 'Generic PLA', bambu_profiles_by_model: { X1C: { base_name: 'Generic PLA' } }, count: 0, sealed: false },
        custom_field_definitions: null,
      }
      let persisted: { custom_fields: Record<string, unknown> } = structuredClone(initial)
      const bodies: Record<string, unknown>[] = []
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body))
          bodies.push(body)
          persisted = { ...persisted, ...body }
        }
        return Response.json(persisted)
      }))
      // The independently saved profile endpoint has committed these values.
      function commitProfile() {
        persisted.custom_fields = operation === 'set'
          ? { note: 'Dry', bambu_profile_base_name: 'Matte PLA', bambu_profiles_by_model: { X1C: { base_name: 'Matte PLA' } }, count: 0, sealed: false }
          : { note: 'Dry', count: 0, sealed: false }
      }
      const runtime = pageDialog(entity, initial)
      if (timing === 'before-open') commitProfile()
      await runtime.cancel()
      await runtime.open()
      const dialog = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
      expect(dialog.open).toBe(true)
      if (timing === 'before-open') {
        expect(dialog.textContent).not.toContain('Generic PLA')
        if (operation === 'set') expect(dialog.textContent).toContain('Matte PLA')
      } else commitProfile()
      const expected = { ...persisted.custom_fields, note: 'Wet' }
      const note = dialog.querySelector<HTMLInputElement>('[data-key="note"]')!
      note.value = 'Wet'
      note.dispatchEvent(new Event('input', { bubbles: true }))
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toEqual({ custom_fields: expected })
      expect(persisted.custom_fields).toEqual(expected)
      await vi.waitFor(() => expect(dialog.open).toBe(false))
    })
  }

  it(`${entity} Manage fields stays closed when its fresh read fails`, async () => {
    const alert = vi.fn(async () => {})
    vi.stubGlobal('__fmAlert', alert)
    vi.stubGlobal('fetch', async () => Response.json({}, { status: 503 }))
    const runtime = pageDialog(entity, { id: 16, custom_fields: { note: 'Old' } })
    await runtime.cancel()
    await runtime.open()
    expect(document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')?.open ?? false).toBe(false)
    expect(alert).toHaveBeenCalledOnce()
  })
}
