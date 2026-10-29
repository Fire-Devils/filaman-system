import { readFileSync } from 'node:fs'
import { createSourceFile, isImportDeclaration, isExpressionStatement, ScriptTarget, transpileModule } from 'typescript'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { expect, vi } from 'vitest'
import DetailScrollIdentity from '../components/DetailScrollIdentity.astro'
import PrinterSetup from '../components/PrinterSetup.astro'
import FilamentForm from '../components/FilamentForm.astro'
import FilamentFormActions from '../components/FilamentFormActions.astro'
import * as i18n from './i18n'
import * as extraFields from './extra-fields'
import * as entityFields from './entity-extra-fields'
import * as extraDialog from './entity-extra-fields-dialog'
import * as cache from './cache'
import * as filamentDetail from './filament-detail'
import * as filamentForm from './filament-form'
import * as detailEdit from './detail-edit'
import * as editPosition from './detail-edit-position'
import * as scrollIdentity from './detail-scroll-identity'
import * as format from './format'
import * as abort from './abort'
import * as printerSetup from './printer-setup'
import * as filamentLabel from './filament-label-data'
import * as labelSession from './label-print-session'
import * as locations from './driver-managed-locations'
import * as reel from './spool-reel'
import * as spoolDetail from './spool-detail'
import * as lookup from './filamentdb-lookup'
import * as labelFields from './label-extra-fields'
import * as spoolLabel from './spool-label-data'
import { clearUser } from './auth'

export const baseFilament = {
  id: 16,
  manufacturer_id: 7,
  manufacturer: { id: 7, name: 'Brand' },
  designation: 'PLA',
  material_type: 'PLA',
  diameter_mm: 1.75,
  color_mode: 'single',
  colors: [{ color_id: 11, position: 1, color: { id: 11, name: 'Red', hex_code: '#FF0000' } }],
  default_spool_weight_g: 170,
  spool_material: 'Cardboard',
  spool_outer_diameter_mm: 200,
  spool_width_mm: 68,
  custom_fields: { note: 'Dry', plugin: { idx: 2 }, zero: 0, flag: false },
  custom_field_definitions: null,
}
export const baseSpool = {
  id: 17,
  filament_id: 16,
  filament: baseFilament,
  initial_total_weight_g: 1170,
  empty_spool_weight_g: 170,
  spool_core_weight_g: 0,
  spool_material: 'Cardboard',
  spool_outer_diameter_mm: 200,
  spool_width_mm: 68,
  remaining_weight_g: 500,
  low_weight_threshold_g: 100,
  purchase_price: 12.5,
  purchase_date: '2026-09-01',
  lot_number: 'Lot',
  external_id: 'EXT',
  rfid_uid: 'AABBCCDD',
  rfid_uid_2: '11223344',
  status_id: 1,
  custom_fields: { note: 'Dry', plugin: { idx: 2 }, zero: 0, flag: false },
  custom_field_definitions: null,
}
const asyncFunction = Object.getPrototypeOf(async function () {}).constructor
const dependencies = {
  ...detailEdit,
  ...i18n,
  ...extraFields,
  ...entityFields,
  ...extraDialog,
  ...cache,
  ...filamentDetail,
  ...filamentForm,
  ...editPosition,
  ...scrollIdentity,
  ...format,
  ...abort,
  ...printerSetup,
  ...filamentLabel,
  ...labelSession,
  ...locations,
  ...reel,
  ...spoolDetail,
  ...lookup,
  ...labelFields,
  ...spoolLabel,
  escapeExtraFieldHtml: extraFields.escapeHtml,
}
const markup = new Map<string, string>()
export function clearState() {
  vi.stubGlobal('Option', function (text: string, value: string) {
    const option = document.createElement('option')
    option.textContent = text
    option.value = value
    return option
  })
  clearUser()
  cache.invalidateAllCaches()
  localStorage.clear()
  sessionStorage.clear()
  i18n.setLang('en')
}
export type Transport = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined
export function mockHttp(
  options: { filament?: any; spool?: any; printers?: any[]; intercept?: Transport; system?: any[] } = {},
) {
  let filament = structuredClone(options.filament ?? baseFilament),
    spool = structuredClone(options.spool ?? baseSpool)
  const printerValues: Record<string, any> = {},
    calls: { path: string; method: string; body: any }[] = []
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input),
      method = init?.method || 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body })
    const override = options.intercept?.(path, init)
    if (override) return await override
    const url = new URL(path, 'http://localhost'),
      pathname = url.pathname
    if (pathname === '/auth/me') return Response.json({ is_superadmin: true, permissions: [] })
    if (pathname === '/api/v1/app-settings/public-info')
      return Response.json({ currency: 'USD', filament_lookup_source: 'filamandb' })
    if (pathname === '/api/v1/filamentdb/status') return Response.json({ active: false })
    if (pathname === '/api/v1/manufacturers')
      return Response.json({
        items: [
          {
            id: 7,
            name: 'Brand',
            empty_spool_weight_g: 210,
            spool_material: 'Cardboard',
            spool_outer_diameter_mm: 200,
            spool_width_mm: 65,
          },
          {
            id: 8,
            name: 'Second',
            empty_spool_weight_g: 250,
            spool_material: 'Plastic',
            spool_outer_diameter_mm: 210,
            spool_width_mm: 70,
          },
        ],
        total: 2,
      })
    if (pathname === '/api/v1/filaments/types') return Response.json(['PLA', 'PETG'])
    if (pathname === '/api/v1/colors')
      return Response.json({
        items: [
          { id: 11, name: 'Red', hex_code: '#FF0000' },
          { id: 12, name: 'Blue', hex_code: '#0000FF' },
        ],
        total: 2,
      })
    if (pathname === '/api/v1/system-extra-fields') return Response.json(options.system ?? [])
    if (pathname === '/api/v1/admin/system/plugins') return Response.json([])
    if (pathname === '/api/v1/printers')
      return Response.json({ items: options.printers ?? [], total: options.printers?.length ?? 0 })
    if (pathname.endsWith('/parameter-fields'))
      return Response.json([{ key: 'bambu_k_value', label: 'K', field_type: 'number' }])
    if (pathname.includes('/printer-params')) {
      const key = pathname + '/' + (url.searchParams.get('printer_id') ?? '')
      if (method === 'GET') return Response.json(printerValues[key] ?? [])
      if (method === 'PUT') {
        printerValues[pathname.replace(/\/(\d+)$/, '') + '/' + pathname.split('/').at(-1)] = body.params
        return Response.json(body.params)
      }
      return new Response(null, { status: 204 })
    }
    if (pathname === '/api/v1/filaments/16') {
      if (method === 'PATCH') filament = { ...filament, ...body }
      return Response.json(filament)
    }
    if (pathname === '/api/v1/filaments/16/colors') {
      filament = { ...filament, ...body }
      return Response.json(filament)
    }
    if (pathname === '/api/v1/spools/17') {
      if (method === 'PATCH') spool = { ...spool, ...body, filament: filament }
      return Response.json(spool)
    }
    if (pathname === '/api/v1/filaments')
      return Response.json({ items: [filament, { ...filament, id: 18, designation: 'Other' }], total: 2 })
    if (pathname === '/api/v1/spools') return Response.json({ items: [], total: 0 })
    if (pathname === '/api/v1/spools/statuses') return Response.json([{ id: 1, key: 'opened', label: 'Opened' }])
    if (pathname === '/api/v1/locations') return Response.json({ items: [], total: 0 })
    if (pathname === '/api/v1/devices/active') return Response.json([])
    if (pathname.endsWith('/events')) return Response.json({ items: [], total: 0 })
    if (pathname === '/api/v1/filamentdb/spool-profiles') return Response.json({ items: [], total: 0 })
    throw new Error(`Unexpected ${method} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  return {
    fetch,
    calls,
    get filament() {
      return filament
    },
    get spool() {
      return spool
    },
    setFilament(v: any) {
      filament = v
    },
    setSpool(v: any) {
      spool = v
    },
    printerValues,
  }
}
export async function pageFixture(entity: 'filament' | 'spool', edit = false) {
  history.replaceState(null, '', `/${entity}s/${entity === 'filament' ? 16 : 17}${edit ? '?edit=1' : ''}`)
  if (!markup.has(entity + 'page')) {
    const renderer = await AstroContainer.create()
    let html = readFileSync(`src/pages/${entity}s/[id]/index.astro`, 'utf8')
      .split(/<Layout[^>]*>/)[1]
      .split('<script>')[0]
    html = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('href={`/spools/${id}/print`}', 'href="/spools/17/print"')
    html = html
      .replace('<DetailScrollIdentity />', await renderer.renderToString(DetailScrollIdentity))
      .replace('<PrinterSetup />', await renderer.renderToString(PrinterSetup))
    if (entity === 'filament')
      html = html
        .replace(
          '<FilamentFormActions mode="edit" cancelHref="/filaments" />',
          await renderer.renderToString(FilamentFormActions, { props: { mode: 'edit', cancelHref: '/filaments' } }),
        )
        .replace(
          '<FilamentForm mode="edit" />',
          await renderer.renderToString(FilamentForm, { props: { mode: 'edit' } }),
        )
    markup.set(entity + 'page', '<main>' + html + '</main>')
  }
  document.body.innerHTML = markup.get(entity + 'page')!
  const source = readFileSync(`src/pages/${entity}s/[id]/index.astro`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
  const parsed = createSourceFile('page.ts', source, ScriptTarget.Latest, true)
  const initialCall = entity === 'filament' ? 'loadFilament()' : 'loadData()'
  const production = parsed.statements
    .filter(
      (node) =>
        !isImportDeclaration(node) && !(isExpressionStatement(node) && node.getText(parsed).trim() === initialCall),
    )
    .map((node) => node.getText(parsed))
    .join('\n')
  const returns =
    entity === 'filament'
      ? `return {initialize:loadFilament,get controller(){return filamentFormController},get printers(){return printerSetup},get data(){return currentFilament},enter:()=>setFilamentEditing(true),cancel:()=>setFilamentEditing(false),dispose:()=>{filamentFormController?.destroy();printerSetup?.dispose()}}`
      : `return {initialize:loadData,get printers(){return printerSetup},get data(){return spool},enter:()=>document.getElementById('btn-edit-spool').click(),cancel:()=>document.getElementById('btn-cancel-edit')?.click(),dispose:()=>{spoolDraftObserver?.disconnect();spoolProfileLookup?.destroy();printerSetup?.dispose();window.dispatchEvent(new Event('pagehide'))}}`
  const runtime = await new asyncFunction(
    ...Object.keys(dependencies),
    transpileModule(production, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText + '\n' + returns,
  )(...Object.values(dependencies))
  await runtime.initialize()
  await runtime.printers?.ready
  return runtime
}
export function change(selector: string, value: string | boolean, event = 'input') {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
  expect(input, selector).not.toBeNull()
  if (typeof value === 'boolean') (input as HTMLInputElement).checked = value
  else input.value = value
  input.dispatchEvent(new Event(event, { bubbles: true }))
  return input
}
