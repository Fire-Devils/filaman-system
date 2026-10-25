// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { loadPcPrintLabel, printPcLabel } from './label-pc-print-output'
import { printLabelBrowserJob } from './label-browser-print'
import { createLabelPagesPdf } from './label-export'

vi.mock('./label-browser-print', () => ({ printLabelBrowserJob: vi.fn() }))
vi.mock('./label-export', () => ({ createLabelPagesPdf: vi.fn() }))
vi.mock('./label-svg/browser', () => ({ pngDataUrl: () => 'data:image/png;base64,cGljdHVyZQ==' }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('loads the request-scoped PNG and dimensions without changing its shape', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { headers: {
    'Content-Type': 'image/png', 'X-Label-Width-Mm': '30', 'X-Label-Height-Mm': '100',
  } })))
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined)
  const label = await loadPcPrintLabel(7, new AbortController().signal)
  expect(label).toEqual({ dataUrl: 'data:image/png;base64,cGljdHVyZQ==', widthMm: 30, heightMm: 100 })
  expect(fetch).toHaveBeenCalledWith('/api/v1/labels/print-requests/7/preview', expect.objectContaining({ credentials: 'include' }))
})
it('rejects invalid dimensions and server errors before printing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { headers: { 'Content-Type': 'image/png' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Label renderer is busy' }), { status: 503 })))
  await expect(loadPcPrintLabel(7, new AbortController().signal)).rejects.toThrow()
  await expect(loadPcPrintLabel(7, new AbortController().signal)).rejects.toThrow('Label renderer is busy')
})
it('prints one image at physical dimensions regardless of thumbnail limits', async () => {
  await printPcLabel({ dataUrl: 'data:image/png;base64,cGljdHVyZQ==', widthMm: 30, heightMm: 100 }, false)
  const job = vi.mocked(printLabelBrowserJob).mock.calls.at(-1)![0]
  expect(job.widthMm).toBe(30)
  expect(job.heightMm).toBe(100)
  expect(job.pages).toHaveLength(1)
  expect(job.pages[0].style.width).toBe('30mm')
  expect(job.pages[0].style.height).toBe('100mm')
  expect(job.pages[0].querySelector('img')!.src).toBe('data:image/png;base64,cGljdHVyZQ==')
})
it('uses the same pixels and physical size for PDF', async () => {
  const label = { dataUrl: 'data:image/png;base64,cGljdHVyZQ==', widthMm: 40, heightMm: 30 }
  const blob = new Blob(['pdf'])
  vi.mocked(createLabelPagesPdf).mockResolvedValue({ output: () => blob, save: vi.fn() })
  expect(await printPcLabel(label, true)).toBe(blob)
  expect(createLabelPagesPdf).toHaveBeenCalledWith([label])
})
