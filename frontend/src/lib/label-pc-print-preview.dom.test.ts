// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setupPcPrintPrompt } from './label-pc-print-prompt'

const output = vi.hoisted(() => ({ load: vi.fn(), print: vi.fn() }))
vi.mock('./label-pc-print-output', () => ({ loadPcPrintLabel: output.load, printPcLabel: output.print }))
let pending: Record<string, unknown> | null
let claims: string[]
let claimStatus: number
const now = Date.parse('2026-10-24T12:00:00Z')
const request = (kind = 'spool', age = 0, id = 7) => ({
  id, [`${kind}_id`]: 73, preset_id: 9,
  created_at: new Date(now - age * 60_000).toISOString(),
  expires_at: new Date(now + (60 - age) * 60_000).toISOString(),
})
const button = (name: string) => document.querySelector<HTMLButtonElement>(`.pc-print-prompt-${name}`)!
const visible = () => !document.getElementById('pc-print-prompt')!.classList.contains('hidden')
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  localStorage.clear()
  document.body.innerHTML = `<div id="pc-print-prompt" class="hidden">
    <strong class="pc-print-prompt-title"></strong><span class="pc-print-prompt-age" hidden></span>
    <img class="pc-print-prompt-preview" hidden><p class="pc-print-prompt-message"></p>
    <p class="pc-print-prompt-error" hidden></p><small class="pc-print-prompt-note"></small>
    <button class="pc-print-prompt-print"><span></span></button>
    <a class="pc-print-prompt-download" download="label.pdf" hidden><span></span></a>
    <button class="pc-print-prompt-edit"><span></span></button>
    <button class="pc-print-prompt-close"></button></div>
    <div id="pc-print-prompt-waiting" hidden></div>`
  pending = request()
  claims = []
  claimStatus = 204
  output.load.mockReset().mockResolvedValue({ dataUrl: 'data:image/png;base64,cHJldmlldw==', widthMm: 40, heightMm: 30 })
  output.print.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/claim')) {
      claims.push(url)
      if (claimStatus === 204) pending = null
      return new Response(null, { status: claimStatus })
    }
    return new Response(JSON.stringify(pending))
  })
})
afterEach(() => {
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['spool', 'filament'])('prepares %s once and prints the displayed label without opening an editor', async kind => {
  pending = request(kind)
  const open = vi.spyOn(window, 'open')
  setupPcPrintPrompt()
  await flush()
  expect(visible()).toBe(true)
  expect(document.querySelector<HTMLImageElement>('.pc-print-prompt-preview')!.src).toBe('data:image/png;base64,cHJldmlldw==')
  expect(document.querySelector('.pc-print-prompt-message')!.textContent).toContain('40 × 30 mm')
  await vi.advanceTimersByTimeAsync(9000)
  expect(output.load).toHaveBeenCalledTimes(1)
  button('print').click()
  await flush()
  expect(claims).toHaveLength(1)
  expect(output.print).toHaveBeenCalledWith(await output.load.mock.results[0].value, false, expect.any(Function))
  expect(open).not.toHaveBeenCalled()
  expect(visible()).toBe(false)
})
it('ages from submission, turns red at 55 minutes and expires offline at 60', async () => {
  setupPcPrintPrompt()
  await flush()
  const badge = document.querySelector<HTMLElement>('.pc-print-prompt-age')!
  expect(badge.hidden).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(badge.hidden).toBe(false)
  expect(badge.textContent).toBe('Age: 1 min')
  expect(badge.classList.contains('is-expiring')).toBe(false)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')))
  vi.setSystemTime(now + 55 * 60_000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(badge.textContent).toBe('Age: 55 min')
  expect(badge.classList.contains('is-expiring')).toBe(true)
  vi.setSystemTime(now + 60 * 60_000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(visible()).toBe(false)
})
it('leaves age text unchanged between minute boundaries', async () => {
  pending = request('spool', 1)
  setupPcPrintPrompt()
  await flush()
  const badge = document.querySelector<HTMLElement>('.pc-print-prompt-age')!
  const text = badge.firstChild
  await vi.advanceTimersByTimeAsync(9000)
  expect(badge.firstChild).toBe(text)
  await vi.advanceTimersByTimeAsync(51_000)
  expect(badge.textContent).toBe('Age: 2 min')
})
it('shows a request waiting at login and ignores expired requests', async () => {
  pending = request('filament', 56)
  setupPcPrintPrompt()
  await flush()
  expect(document.querySelector('.pc-print-prompt-age')!.textContent).toBe('Age: 56 min')
  pending = request('spool', 60, 8)
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(false)
  expect(output.load).toHaveBeenCalledTimes(1)
})
it.each(['spool', 'filament'])('Edit opens the requested %s preset after claiming', async kind => {
  pending = request(kind)
  const popup = { location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  setupPcPrintPrompt()
  await flush()
  button('edit').click()
  await flush()
  expect(popup.location.href).toBe(`/${kind}s/73/print?scale_print=1&preset_id=9`)
  expect(claims).toHaveLength(1)
})
it.each(['dismiss', 'expiry', 'unload'])('keeps PDF in the card without a popup and releases it on %s', async reason => {
  localStorage.setItem('filaman-label-print-pdf-v1', 'true')
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:label-pdf')
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  output.print.mockResolvedValue(new Blob(['pdf']))
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  const link = document.querySelector<HTMLAnchorElement>('.pc-print-prompt-download')!
  expect(output.print).toHaveBeenCalledWith(await output.load.mock.results[0].value, true, expect.any(Function))
  expect(open).not.toHaveBeenCalled()
  expect(visible()).toBe(true)
  expect(button('print').hidden).toBe(true)
  expect(link.hidden).toBe(false)
  expect(link.href).toBe('blob:label-pdf')
  expect(link.download).toBe('label.pdf')
  expect(link.textContent).toBe('Download PDF')
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(true)
  expect(claims).toHaveLength(1)
  expect(localStorage.getItem('filaman-label-print-pdf-v1')).toBe('true')
  if (reason === 'dismiss') button('close').click()
  else if (reason === 'expiry') {
    vi.setSystemTime(now + 60 * 60_000)
    await vi.advanceTimersByTimeAsync(1000)
  } else window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }))
  expect(revoke).toHaveBeenCalledWith('blob:label-pdf')
  expect(link.hasAttribute('href')).toBe(false)
  expect(visible()).toBe(false)
  expect(claims).toHaveLength(1)
})
it('does not expose PDF output that finishes after expiry', async () => {
  localStorage.setItem('filaman-label-print-pdf-v1', 'true')
  pending = request('spool', 59)
  let finish!: (value: Blob) => void
  output.print.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const create = vi.spyOn(URL, 'createObjectURL')
  vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window)
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  vi.setSystemTime(now + 60_000)
  await vi.advanceTimersByTimeAsync(1000)
  finish(new Blob(['pdf']))
  await flush()
  expect(create).not.toHaveBeenCalled()
  expect(visible()).toBe(false)
  pending = request('filament', 0, 99)
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(true)
  expect(button('print').hidden).toBe(false)
  expect(document.querySelector<HTMLAnchorElement>('.pc-print-prompt-download')!.hidden).toBe(true)
})
it('retries failed rendering without consuming the request', async () => {
  output.load.mockRejectedValueOnce(new Error('Renderer busy'))
  setupPcPrintPrompt()
  await flush()
  expect(button('print').disabled).toBe(false)
  expect(button('print').textContent).toBe('Retry')
  button('print').click()
  await flush()
  expect(output.load).toHaveBeenCalledTimes(2)
  expect(claims).toHaveLength(0)
  expect(button('print').textContent).toBe('Print')
})
it('keeps a claimed label available to retry a print failure', async () => {
  output.print.mockRejectedValueOnce(new Error('Print unavailable'))
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(true)
  button('print').click()
  await flush()
  expect(claims).toHaveLength(1)
  expect(output.print).toHaveBeenCalledTimes(2)
  expect(visible()).toBe(false)
})
it('never prints a request already claimed by another tab', async () => {
  claimStatus = 409
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  expect(output.print).not.toHaveBeenCalled()
  expect(visible()).toBe(false)
})
it('dismisses during rendering and ignores the late image', async () => {
  let finish!: (value: unknown) => void
  output.load.mockReturnValue(new Promise(resolve => { finish = resolve }))
  setupPcPrintPrompt()
  await flush()
  button('close').click()
  await flush()
  finish({ dataUrl: 'old-image', widthMm: 40, heightMm: 30 })
  await flush()
  expect(visible()).toBe(false)
  expect(document.querySelector<HTMLImageElement>('.pc-print-prompt-preview')!.hasAttribute('src')).toBe(false)
})
it('retries a failed dismissal and then shows the next request', async () => {
  claimStatus = 503
  setupPcPrintPrompt()
  await flush()
  button('close').click()
  await flush()
  expect(visible()).toBe(false)
  claimStatus = 204
  await vi.advanceTimersByTimeAsync(3000)
  expect(claims).toHaveLength(2)
  pending = request('filament', 0, 8)
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(true)
})
it('ignores a stale image after the request changes', async () => {
  let finish!: (value: unknown) => void
  output.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  setupPcPrintPrompt()
  await flush()
  pending = { ...request('filament'), filament_id: 99, preset_id: 10 }
  await vi.advanceTimersByTimeAsync(3000)
  finish({ dataUrl: 'old-image', widthMm: 80, heightMm: 80 })
  await flush()
  expect(document.querySelector<HTMLImageElement>('.pc-print-prompt-preview')!.src).toBe('data:image/png;base64,cHJldmlldw==')
  expect(document.querySelector('.pc-print-prompt-message')!.textContent).toContain('99')
})
it('continues the queue when a claim finishes after expiry', async () => {
  pending = request('spool', 59)
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', (url: string) => url.endsWith('/claim')
    ? new Promise<Response>(resolve => { finish = resolve })
    : Promise.resolve(new Response(JSON.stringify(pending))))
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  vi.setSystemTime(now + 60_000)
  await vi.advanceTimersByTimeAsync(1000)
  finish(new Response(null, { status: 204 }))
  await flush()
  expect(output.print).not.toHaveBeenCalled()
  pending = request('filament', 0, 99)
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(true)
})
it('retains a failed print for retry when an earlier poll returns after the claim', async () => {
  setupPcPrintPrompt()
  await flush()
  let finishPoll!: (value: Response) => void
  vi.stubGlobal('fetch', (url: string) => url.endsWith('/claim')
    ? Promise.resolve(new Response(null, { status: 204 }))
    : new Promise<Response>(resolve => { finishPoll = resolve }))
  await vi.advanceTimersByTimeAsync(3000)
  output.print.mockRejectedValueOnce(new Error('Print failed'))
  button('print').click()
  await flush()
  finishPoll(new Response('null'))
  await flush()
  expect(visible()).toBe(true)
  button('print').click()
  await flush()
  expect(output.print).toHaveBeenCalledTimes(2)
})
it('opens Edit even when the in-flight preview reports the request was consumed', async () => {
  const { ApiError } = await import('./api')
  let failPreview!: (error: Error) => void
  let finishClaim!: (value: Response) => void
  output.load.mockReturnValueOnce(new Promise((_resolve, reject) => { failPreview = reject }))
  const popup = { location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  setupPcPrintPrompt()
  await flush()
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finishClaim = resolve }))
  button('edit').click()
  await flush()
  failPreview(new ApiError(409, 'claimed', 'Request already claimed'))
  await flush()
  finishClaim(new Response(null, { status: 204 }))
  await flush()
  expect(popup.close).not.toHaveBeenCalled()
  expect(popup.location.href).toBe('/spools/73/print?scale_print=1&preset_id=9')
})
it('resumes after bfcache and stops on actual unload', async () => {
  setupPcPrintPrompt()
  await flush()
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }))
  pending = null
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(false)
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }))
  pending = request('spool', 0, 10)
  await vi.advanceTimersByTimeAsync(3000)
  expect(visible()).toBe(false)
})

it.each(['expiry', 'unload'])('cancels browser printing when %s happens during asset preparation', async reason => {
  const realOutput = await vi.importActual<typeof import('./label-pc-print-output')>('./label-pc-print-output')
  const readiness = await import('./label-output-readiness')
  let finishAssets!: () => void
  vi.spyOn(readiness, 'waitForLabelOutputAssets').mockReturnValue(new Promise<void>(resolve => { finishAssets = resolve }))
  output.print.mockImplementation(realOutput.printPcLabel)
  const print = vi.spyOn(window, 'print').mockImplementation(() => {})
  pending = { ...request(), expires_at: new Date(now + 1000).toISOString() }
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  expect(document.getElementById('filaman-label-print-host')).not.toBeNull()
  if (reason === 'expiry') await vi.advanceTimersByTimeAsync(1000)
  else window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }))
  expect(visible()).toBe(false)
  finishAssets()
  await vi.advanceTimersByTimeAsync(200)
  expect(print).not.toHaveBeenCalled()
  expect(document.getElementById('filaman-label-print-host')).toBeNull()
})


it('shows another waiting request without rendering it or reloading the active label', async () => {
  setupPcPrintPrompt()
  await flush()
  const waiting = document.getElementById('pc-print-prompt-waiting')!
  expect(waiting.hidden).toBe(true)
  pending = { ...pending, has_more: true }
  await vi.advanceTimersByTimeAsync(3000)
  expect(waiting.hidden).toBe(false)
  expect(waiting.textContent).toBe('Another label is waiting')
  expect(output.load).toHaveBeenCalledTimes(1)
  pending = { ...pending, has_more: false }
  await vi.advanceTimersByTimeAsync(3000)
  expect(waiting.hidden).toBe(true)
  expect(output.load).toHaveBeenCalledTimes(1)
})
it('keeps a PDF card and indicates the next request until dismissed', async () => {
  localStorage.setItem('filaman-label-print-pdf-v1', 'true')
  output.print.mockResolvedValue(new Blob(['pdf']))
  setupPcPrintPrompt()
  await flush()
  button('print').click()
  await flush()
  pending = request('filament', 0, 8)
  await vi.advanceTimersByTimeAsync(3000)
  const waiting = document.getElementById('pc-print-prompt-waiting')!
  expect(waiting.hidden).toBe(false)
  expect(output.load).toHaveBeenCalledTimes(1)
  expect(document.querySelector<HTMLAnchorElement>('.pc-print-prompt-download')!.hidden).toBe(false)
  button('close').click()
  expect(waiting.hidden).toBe(true)
  await vi.advanceTimersByTimeAsync(3000)
  expect(output.load).toHaveBeenLastCalledWith(8, expect.any(AbortSignal))
  expect(visible()).toBe(true)
  expect(waiting.hidden).toBe(true)
})
