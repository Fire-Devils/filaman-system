// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as printPage from './label-print-page'
import * as printWorkspace from './label-print-workspace'
import * as i18n from './i18n'
import { createDefaultLabelDesign } from './freeform-label/defaults'
import { renderPrintPage, runPrintPage } from './label-print-test-support'
import { renderSvgElementOutput } from './label-svg/browser'

vi.mock('./label-svg/runtime.mjs', async importOriginal => {
  const module = await importOriginal<typeof import('./label-svg/runtime.mjs')>()
  return { createSvgRuntime: (_readAsset: unknown, raster: boolean) => module.createSvgRuntime((path: string) => Promise.resolve(readFileSync(`node_modules/${path}`)), raster) }
})

beforeEach(() => {
  i18n.setLang('en')
  document.head.innerHTML = ''
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

type Entity = 'filament' | 'spool'

async function startPage(entity: Entity, batch: boolean, options: { failed?: boolean; ordinary?: boolean; apiDefault?: boolean; metadata?: boolean } = {}) {
  const { failed = false, ordinary = false, apiDefault = false, metadata = false } = options
  history.replaceState(null, '', batch ? `/${entity}s/print?ids=8,9` : `/${entity}s/8/print${apiDefault ? '?scale_print=1' : ''}`)
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('QRCode', class { static CorrectLevel = { H: 2 } })
  sessionStorage.setItem(entity === 'filament' ? 'filaman-filament-label-extra-fields' : 'filaman-label-extra-fields', JSON.stringify({
    entityId: '8', fields: [metadata
      ? { key: 'filament.spoolman_id', label: 'spoolman_id', source: 'filament', value: '8' }
      : { key: 'filament.dry_temp', label: 'Drying temperature', source: 'filament', value: '55.0 °F' }],
  }))
  const design = createDefaultLabelDesign(entity)
  design.elements = design.elements.filter(element => element.type === 'text').slice(0, 1)
  const text = design.elements[0]
  if (text.type === 'text') text.template = metadata ? 'ID: {extra.filament.spoolman_id}'
    : ordinary ? '{filament.name}' : '{extra.filament.dry_temp}'
  localStorage.setItem(`filaman-${entity}-label-designer-v1`, JSON.stringify({ version: 2, design }))
  const settingsKey = entity === 'filament' ? 'filaman-filament-label-settings' : 'filaman-label-settings'
  const savedSettings = JSON.stringify({ _v: 2, width: '93', height: '22', showQR: false, extraFields: { 'filament.dry_temp': true } })
  if (apiDefault) localStorage.setItem(settingsKey, savedSettings)
  await renderPrintPage(entity, batch)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let waiting = false
  const oldDefinition = { label: 'Drying temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } }
  const filament = { id: 8, designation: 'Test PLA', material_type: 'PLA', drying_temp_c: 65,
    custom_fields: { dry_temp: 55, ...(metadata ? { spoolman_id: 8 } : {}) }, label_field_aliases: { dry_temp: {
      target: 'drying_temp_c', definition: oldDefinition,
      wire: { value: 55, source: ['dry_temp'], definition: oldDefinition },
    } } }
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const path = String(input)
    if (path.includes('/system-extra-fields')) {
      waiting = true
      await gate
      return failed ? new Response('', { status: 503 }) : Response.json([
        { id: 1, key: 'dry_temp', ...oldDefinition, config: { unit: '°F', decimal_places: 1 } },
      ])
    }
    if (/\/(filaments|spools)\/[89]$/.test(path)) return Response.json(entity === 'filament' ? filament : { id: 8, filament_id: 8, filament, remaining_weight_g: 123 })
    if (path === '/api/v1/locations') return Response.json({ items: [], total: 0 })
    if (path.endsWith('/public-info')) return Response.json({ currency: 'EUR' })
    return Response.json([])
  }))
  let collection: printPage.LabelOutputCollection<unknown> | undefined
  let coordinator!: ReturnType<typeof printPage.createPreviewRenderCoordinator>
  let editor: Awaited<ReturnType<typeof printWorkspace.initPrintDesignerEditor>> | undefined
  const overrides = {
    createPreviewRenderCoordinator: () => coordinator = printPage.createPreviewRenderCoordinator(),
    bindLabelOutputs: (options: Parameters<typeof printPage.bindLabelOutputs>[0]) => {
      collection = options.collection
      return printPage.bindLabelOutputs(options)
    },
    initPrintDesignerEditor: async (options: Parameters<typeof printWorkspace.initPrintDesignerEditor>[0]) => {
      editor = await printWorkspace.initPrintDesignerEditor(options)
      return editor
    },
  }
  const completion = runPrintPage(entity, batch, overrides)
  await vi.waitFor(() => expect(waiting).toBe(true))
  return {
    release, completion, coordinator, settingsKey, savedSettings,
    get collection() { return collection },
    label: () => document.querySelector<HTMLElement>(batch ? '#freeform-canvas-host .label-preview' : '#label-preview')!,
    async dispose() {
      release()
      await completion
      editor?.destroy()
      window.dispatchEvent(new Event('pagehide'))
    },
  }
}

for (const entity of ['filament', 'spool'] as const) for (const batch of [false, true]) {
  it(`${entity} ${batch ? 'batch' : 'single'} waits for current definitions before preview or output`, async () => {
    const page = await startPage(entity, batch)
    try {
      document.querySelector<HTMLButtonElement>('#tab-btn-designer')!.click()
      let prepared = false
      const output = page.collection?.prepare().then(() => { prepared = true })
      await page.coordinator.settle()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(prepared).toBe(false)
      expect(page.label()?.textContent ?? '').not.toContain('55.0 °C')
      page.release()
      await page.completion
      await output
      await page.collection!.prepare()
      const rendered = await renderSvgElementOutput(page.label(), 1417, 945, false)
      expect(rendered.text.map(row => row.text).join('')).toContain('55.0 °F')
      expect(rendered.png.byteLength).toBeGreaterThan(100)
    } finally { await page.dispose() }
  })

  it(`${entity} ${batch ? 'batch' : 'single'} settles optional definition failures and retries on reload`, async () => {
    const failed = await startPage(entity, batch, { failed: true, ordinary: true })
    try {
      document.querySelector<HTMLButtonElement>('#tab-btn-designer')!.click()
      failed.release()
      await failed.completion
      await failed.collection!.prepare()
      expect((await renderSvgElementOutput(failed.label(), 1417, 945, false)).text.map(row => row.text).join('')).toContain('Test PLA')
    } finally { await failed.dispose() }
    const retry = await startPage(entity, batch)
    try {
      document.querySelector<HTMLButtonElement>('#tab-btn-designer')!.click()
      retry.release()
      await retry.completion
      await retry.collection!.prepare()
      expect((await renderSvgElementOutput(retry.label(), 1417, 945, false)).text.map(row => row.text).join('')).toContain('55.0 °F')
    } finally { await retry.dispose() }
  })
}

for (const entity of ['filament', 'spool'] as const) {
  it(`${entity} single preserves saved designer metadata tokens without Standard selections`, async () => {
    const page = await startPage(entity, false, { metadata: true })
    try {
      document.querySelector<HTMLButtonElement>('#tab-btn-designer')!.click()
      page.release()
      await page.completion
      await page.collection!.prepare()
      expect((await renderSvgElementOutput(page.label(), 1417, 945, false)).text.map(row => row.text).join('')).toContain('ID: 8')
      expect(document.querySelector('#check-ef-filament\\.spoolman_id')).toBeNull()
      expect(document.querySelector('[data-field-token="{extra.filament.spoolman_id}"]')).toBeNull()
    } finally { await page.dispose() }
  })

  it(`${entity} API defaults remain isolated from saved choices after metadata settles`, async () => {
    const page = await startPage(entity, false, { apiDefault: true })
    try {
      page.release()
      await page.completion
      await page.collection!.prepare()
      expect(document.querySelector<HTMLInputElement>('#input-width')!.value).toBe('60')
      expect(page.label().querySelector('.label-designation')?.textContent).toBe('Test PLA PLA')
      expect(page.label().querySelector('.label-extra-fields')?.textContent ?? '').not.toContain('55.0')
      expect(localStorage.getItem(page.settingsKey)).toBe(page.savedSettings)
    } finally { await page.dispose() }
  })
}
