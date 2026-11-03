// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { initSpoolmanImportController } from './spoolman-import-controller'
import { initSpoolmanRepairController } from './spoolman-repair-controller'
import { fakeSpoolmanApi } from './spoolman-controller-test-support'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })
const dependencies = {
  initI18n: async () => {},
  t: (key: string) => key,
  getAbortSignal: () => new AbortController().signal,
}

it('connects Spoolman preview, import and offline repair through the page controls', async () => {
  Object.assign(window, { __fmConfirm: vi.fn(async () => true), __fmAlert: vi.fn(async () => undefined) })
  const api = fakeSpoolmanApi({
    loadPreview: vi.fn(async () => ({
      summary: { vendors: 0, filaments: 0, spools: 0, locations: 0, colors: 0 },
      vendors: [], filaments: [], spools: [], locations: [], colors: [],
      extra_field_fingerprint: 'reviewed-preview', extra_field_targets: ['filament', 'spool'],
    })),
  })
  await bootAstroPage('admin/system/spoolman-import', {
    ...dependencies,
    createSpoolmanApi: () => api,
    initSpoolmanImportController,
    initSpoolmanRepairController,
  })
  expect(document.querySelector('.fm-admin-back')?.getAttribute('href')).toBe('/admin/system')
  expect(document.querySelector('h1')?.textContent).toBe('Spoolman Import')
  const step = document.getElementById('step-import')!
  expect(step.style.pointerEvents).toBe('none')
  const input = document.querySelector<HTMLInputElement>('#spoolman-url')!
  expect(document.querySelector('label[for="spoolman-url"]')).not.toBeNull()
  input.value = 'http://spoolman'
  document.querySelector<HTMLButtonElement>('#btn-test')!.click()
  await vi.waitFor(() => expect(document.getElementById('step-preview')?.style.pointerEvents).toBe('auto'))
  document.querySelector<HTMLButtonElement>('#btn-preview')!.click()
  await vi.waitFor(() => expect(step.style.pointerEvents).toBe('auto'))
  document.querySelector<HTMLButtonElement>('#btn-import')!.click()
  await vi.waitFor(() => expect(api.executeImport).toHaveBeenCalledWith(expect.objectContaining({
    url: 'http://spoolman', extra_field_mode: 'system', extra_field_fingerprint: 'reviewed-preview',
  }), expect.any(AbortSignal)))
  await vi.waitFor(() => expect(document.getElementById('import-result')?.style.display).toBe('block'))
  document.querySelector<HTMLButtonElement>('#btn-repair-preview')!.click()
  await vi.waitFor(() => expect(api.previewRepair).toHaveBeenCalledWith(expect.objectContaining({ mode: 'offline' }), expect.any(AbortSignal)))
})

it('keeps FilamentDB import unavailable after a failed preview and permits retry', async () => {
  const fetch = vi.fn(async () => Response.json({ detail: { message: 'Preview unavailable' } }, { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  await bootAstroPage('admin/system/filamentdb-import', {
    ...dependencies, checkFilamentDbActive: async () => true,
    isAbortError: () => false, toColorSwatchBackground: () => '',
  })
  expect(document.getElementById('step-filaments')?.style.pointerEvents).toBe('none')
  expect(document.querySelector<HTMLInputElement>('input[name="spool-detail-target"]:checked')?.value).toBe('filament')
  document.querySelector<HTMLButtonElement>('#btn-preview')!.click()
  await vi.waitFor(() => expect(document.getElementById('preview-result')?.textContent).toContain('Preview unavailable'))
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/system/filamentdb-import/preview', expect.objectContaining({ method: 'POST', credentials: 'include' }))
  expect(document.getElementById('step-import')?.style.pointerEvents).toBe('none')
  expect(document.querySelector<HTMLButtonElement>('#btn-preview')?.disabled).toBe(false)
})

it('mounts Swagger on the page with the API schema and try-it-out disabled', async () => {
  const SwaggerUI = vi.fn()
  await bootAstroPage('admin/api-docs', { ...dependencies, SwaggerUI })
  expect(document.querySelector('h1')?.textContent).toBe('API Documentation')
  expect(document.getElementById('swagger-container')).not.toBeNull()
  expect(SwaggerUI).toHaveBeenCalledWith(expect.objectContaining({ dom_id: '#swagger-container', url: '/openapi.json', tryItOutEnabled: false }))
})
