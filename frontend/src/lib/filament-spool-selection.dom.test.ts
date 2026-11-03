// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { transpileModule } from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { escapeHtml, formatNumericRange } from './extra-fields'
import { toColorSwatchBackground } from './colors'
import { formatPrice } from './format'

const listSource = readFileSync('src/pages/filaments/index.astro', 'utf8')
const createSource = readFileSync('src/pages/filaments/new.astro', 'utf8')
const compile = (script: string) => transpileModule(script, {}).outputText

afterEach(() => { document.body.innerHTML = ''; sessionStorage.clear(); vi.unstubAllGlobals() })

it.each(['', '?select_for_spool=1', '?select_for_spool=0'])('keeps list navigation and selection controls consistent for %s', search => {
  document.body.innerHTML = listSource.slice(listSource.indexOf('<Layout'), listSource.indexOf('  <script>'))
  const setup = listSource.slice(listSource.indexOf('    const urlParams'), listSource.indexOf('    const normalizeSavedValues'))
  const render = listSource.slice(listSource.indexOf('    function renderColorDots'), listSource.indexOf('    function getPageNumbers'))
  const bulk = listSource.slice(listSource.indexOf('    function updateBulkBar'), listSource.indexOf('  </script>'))
  const runtime = new Function('window', 'document', 't', 'escapeHtml', 'formatNumericRange', 'toColorSwatchBackground', 'formatPrice', `
    const selectedFilamentIds = new Set(), getCurrency = () => 'EUR';
    const columnFilters = {}, getFilterValues = () => ({ search: '' }), isEffectiveColumnFilterActive = () => false;
    const filReorder = { applyOrder() {} }, filResize = { refreshColumns() {} };
    ${compile(setup)}
    ${compile(render)}
    ${compile(bulk)}
    return { renderFilaments, renderGroupedFilaments, updateBulkBar, toggleFilamentSelection, selectedFilamentIds };
  `)({ location: { search } }, document, (key: string) => key, escapeHtml, formatNumericRange, toColorSwatchBackground, formatPrice)

  const selecting = search === '?select_for_spool=1'
  expect(document.querySelector('h1')?.textContent).toBe(selecting ? 'spools.selectFilament' : 'Filaments')
  expect(document.querySelector('#add-filament')?.getAttribute('href')).toBe(selecting ? '/filaments/new?create_spool=1' : '/filaments/new')
  expect(document.querySelector<HTMLAnchorElement>('#spool-selection-back')?.hidden).toBe(!selecting)
  expect(document.querySelector('#spool-selection-back')?.getAttribute('href')).toBe('/spools')
  expect(document.querySelector<HTMLAnchorElement>('#spool-selection-import')?.hidden).toBe(!selecting)
  expect(document.querySelector('#spool-selection-import')?.getAttribute('href')).toBe('/spools/new?from_tag=1')
  expect(document.querySelector<HTMLElement>('#bulk-action-bar')?.style.display).toBe(selecting ? 'none' : '')
  if (selecting) {
    const header = document.querySelector('thead th')!
    expect(header.getAttribute('aria-label')).toBe('common.select')
    expect(header.textContent).toBe('')
  }
  expect(() => runtime.updateBulkBar()).not.toThrow()
  runtime.toggleFilamentSelection(17, true)
  expect(runtime.selectedFilamentIds.size).toBe(selecting ? 0 : 1)
  runtime.toggleFilamentSelection(17, false)
  if (selecting) {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#bulk-action-bar button')) button.click()
    expect(document.querySelector('#bulk-prompt-modal')?.classList.contains('open')).toBe(false)
  }

  for (const render of [runtime.renderFilaments, runtime.renderGroupedFilaments]) {
    render([{ id: 17, designation: 'PLA "silk"', material_type: 'PLA', colors: [] }])
    const row = document.querySelector('#filaments-table tr:not([data-group])')!
    expect(row.getAttribute('onclick')).toContain(selecting ? '/spools/new?filament_id=17' : '/filaments/17')
    const select = row.querySelector<HTMLAnchorElement>('a')
    if (selecting) {
      expect(select?.getAttribute('href')).toBe('/spools/new?filament_id=17')
      expect(select?.getAttribute('aria-label')).toContain('PLA "silk"')
      expect(select?.getAttribute('title')).toBe(select?.getAttribute('aria-label'))
      expect(select?.textContent).toBe('')
      expect(select?.querySelector('svg[aria-hidden="true"] use')?.getAttribute('href')).toBe('/icons.svg?v=2#icon-status')
      expect(select?.getAttribute('onclick')).toBeNull()
      expect(select?.getAttribute('tabindex')).toBeNull()
      expect(row.querySelector('.bulk-checkbox')).toBeNull()
    } else {
      expect(select).toBeNull()
      expect(row.querySelector('.bulk-checkbox')).not.toBeNull()
    }
    render([])
    expect(document.querySelector('#filaments-table a')?.getAttribute('href')).toBe(selecting ? '/filaments/new?create_spool=1' : '/filaments/new')
  }
  if (selecting) {
    sessionStorage.setItem('filaman_spool_create_draft', '{"fields":{"spool_quantity":"3"}}')
    sessionStorage.setItem('filaman_duplicate_spool', '{"rfid_uid":"AABBCCDD"}')
    document.getElementById('spool-selection-back')!.dispatchEvent(new Event('click'))
    expect(sessionStorage.getItem('filaman_spool_create_draft')).toBeNull()
    expect(sessionStorage.getItem('filaman_duplicate_spool')).toBe('{"rfid_uid":"AABBCCDD"}')
  }
})

it.each(['', '?create_spool=1', '?create_spool=0'])('returns a newly created filament to the right flow for %s', async search => {
  document.body.innerHTML = '<a class="detail-back-link" href="/filaments"></a><a id="filament-form-cancel" href="/filaments"></a><form id="filament-form"></form>'
  let options: { onSubmit: (payload: { scalar: object, colors: unknown[] }) => Promise<void> } | undefined
  const fakeWindow = { location: { search, href: '' } }
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 31 }) }))
  const script = createSource.slice(createSource.indexOf('  <script>') + '  <script>'.length, createSource.indexOf('  </script>')).replace(/^\s*import .*$/gm, '')
  const run = new Function('window', 'document', 'sessionStorage', 'fetch', 'initI18n', 't', 'getAbortSignal', 'isAbortError', 'CACHE_KEYS', 'invalidateCachePrefix', 'createFilamentFormController', `return (async () => { ${compile(script)} })()`)
  await run(fakeWindow, document, { getItem: () => null }, fetch, async () => {}, (key: string) => key, () => undefined, () => false, { FILAMENTS: 'filaments' }, vi.fn(), (value: typeof options) => {
    options = value
    return { loadReferenceData: async () => {} }
  })
  const returnHref = search === '?create_spool=1' ? '/filaments?select_for_spool=1' : '/filaments'
  for (const link of document.querySelectorAll('a')) expect(link.getAttribute('href')).toBe(returnHref)
  await options!.onSubmit({ scalar: { designation: 'PLA' }, colors: [] })
  expect(fakeWindow.location.href).toBe(search === '?create_spool=1' ? '/spools/new?filament_id=31' : '/filaments/31')
  expect(fetch.mock.calls).toHaveLength(1)
})
