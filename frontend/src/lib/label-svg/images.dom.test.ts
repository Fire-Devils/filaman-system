// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearPreparedImages, loadPreparedImage } from './images'

const assetUrl = (id: number) => `/api/v1/me/label-assets/00000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}/content`
const png = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
let fetchImage: ReturnType<typeof vi.fn>
let decode: ReturnType<typeof vi.fn>
let close: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchImage = vi.fn(async () => png())
  close = vi.fn()
  decode = vi.fn(async () => ({ width: 20, height: 10, close }))
  vi.stubGlobal('fetch', fetchImage)
  vi.stubGlobal('createImageBitmap', decode)
})
afterEach(() => { clearPreparedImages(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each([assetUrl(1), '/logo-qr.png', `blob:${location.origin}/image-1`])('shares concurrent and repeated stable image preparation: %s', async source => {
  const [first, concurrent] = await Promise.all([loadPreparedImage(source), loadPreparedImage(source)])
  expect(first).toEqual({ dataUrl: 'data:image/png;base64,AQID', width: 20, height: 10 })
  expect(concurrent).toBe(first)
  expect(await loadPreparedImage(source)).toBe(first)
  expect(fetchImage).toHaveBeenCalledOnce()
  expect(decode).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

it('retains a validated data URL without FileReader re-encoding', async () => {
  const source = 'data:image/png;base64,AQID'
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')
  expect(await loadPreparedImage(source)).toEqual({ dataUrl: source, width: 20, height: 10 })
  await loadPreparedImage(source)
  expect(read).not.toHaveBeenCalled()
  expect(decode).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

it('normalizes only a data URL header, preserving its case-sensitive base64 payload', async () => {
  fetchImage.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } }))
  expect((await loadPreparedImage('DATA:IMAGE/JPEG;BASE64,AqID')).dataUrl).toBe('data:image/jpeg;base64,AqID')
})

it('reloads mutable HTTP images and retries rejected stable images', async () => {
  await loadPreparedImage('/manufacturer/logo.png')
  await loadPreparedImage('/manufacturer/logo.png')
  expect(fetchImage).toHaveBeenCalledTimes(2)
  decode.mockRejectedValueOnce(new Error('Decode failed'))
  await expect(loadPreparedImage(assetUrl(1))).rejects.toThrow('Decode failed')
  await expect(loadPreparedImage(assetUrl(1))).resolves.toMatchObject({ width: 20 })
  expect(fetchImage).toHaveBeenCalledTimes(4)
})

it.each(['https://elsewhere.test/logo.png', 'blob:https://elsewhere.test/logo', 'file:///logo.png', 'data:image/svg+xml,<svg/>', 'data:text/html;base64,AQID'])('rejects unsafe image sources before fetching: %s', async source => {
  await expect(loadPreparedImage(source)).rejects.toThrow(/same-origin|Unsupported/)
  expect(fetchImage).not.toHaveBeenCalled()
})

it('keeps encoded size, MIME, response and pixel limits and closes rejected bitmaps', async () => {
  await expect(loadPreparedImage('data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024))).rejects.toThrow('Unsupported label image')
  expect(fetchImage).not.toHaveBeenCalled()
  fetchImage.mockResolvedValueOnce(new Response('', { status: 500 }))
  await expect(loadPreparedImage(assetUrl(1))).rejects.toThrow('Label image could not load')
  fetchImage.mockResolvedValueOnce(new Response('x', { headers: { 'Content-Type': 'image/svg+xml' } }))
  await expect(loadPreparedImage(assetUrl(1))).rejects.toThrow('Unsupported label image')
  fetchImage.mockResolvedValueOnce(new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }))
  await expect(loadPreparedImage(assetUrl(1))).rejects.toThrow('Unsupported label image')
  expect(decode).not.toHaveBeenCalled()
  decode.mockResolvedValueOnce({ width: 4001, height: 3000, close })
  await expect(loadPreparedImage(assetUrl(1))).rejects.toThrow('Label image exceeds pixel budget')
  expect(close).toHaveBeenCalledOnce()
  await expect(loadPreparedImage(assetUrl(1))).resolves.toMatchObject({ width: 20 })
})

it('evicts old entries and clears pending entries without restoring them on completion', async () => {
  for (let id = 0; id < 17; id++) await loadPreparedImage(assetUrl(id))
  await loadPreparedImage(assetUrl(0))
  expect(fetchImage).toHaveBeenCalledTimes(18)
  const pending = loadPreparedImage(assetUrl(20))
  clearPreparedImages()
  await pending
  await loadPreparedImage(assetUrl(20))
  expect(fetchImage).toHaveBeenCalledTimes(20)
})

it('bounds prepared string storage as well as entry count', async () => {
  const payload = 'A'.repeat(1024 * 1024)
  for (let id = 0; id < 5; id++) await loadPreparedImage(`data:image/png;base64,${payload}${id}AAA`)
  await loadPreparedImage(`data:image/png;base64,${payload}0AAA`)
  expect(fetchImage).toHaveBeenCalledTimes(6)
})
