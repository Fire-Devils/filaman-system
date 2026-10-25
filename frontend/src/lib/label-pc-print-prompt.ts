import { t } from './i18n'
import { api, ApiError } from './api'
import { getPrintPdfPreference } from './label-pdf-preview'
import type { PcPrintLabel } from './label-pc-print-output'

type PendingPrint = {
  id: number
  preset_id: number | null
  created_at: string
  expires_at: string
  has_more?: boolean
} & ({ spool_id: number } | { filament_id: number })

const fingerprint = (request: PendingPrint) => JSON.stringify({ ...request, has_more: undefined })

/** The database queue survives login; only the currently displayed label is rendered. */
export function setupPcPrintPrompt() {
  const banner = document.getElementById('pc-print-prompt')!
  const waiting = document.getElementById('pc-print-prompt-waiting')!
  waiting.textContent = t('labelPrint.pcPrintWaiting')
  const title = banner.querySelector<HTMLElement>('.pc-print-prompt-title')!
  const age = banner.querySelector<HTMLElement>('.pc-print-prompt-age')!
  const image = banner.querySelector<HTMLImageElement>('.pc-print-prompt-preview')!
  const message = banner.querySelector<HTMLElement>('.pc-print-prompt-message')!
  const errorMessage = banner.querySelector<HTMLElement>('.pc-print-prompt-error')!
  const printButton = banner.querySelector<HTMLButtonElement>('.pc-print-prompt-print')!
  const download = banner.querySelector<HTMLAnchorElement>('.pc-print-prompt-download')!
  const editButton = banner.querySelector<HTMLButtonElement>('.pc-print-prompt-edit')!
  const closeButton = banner.querySelector<HTMLButtonElement>('.pc-print-prompt-close')!
  banner.querySelector<HTMLElement>('.pc-print-prompt-note')!.textContent = t('labelPrint.pcPrintSettings')
  editButton.querySelector('span')!.textContent = t('common.edit')
  download.querySelector('span')!.textContent = t('labelPrint.downloadPdf')
  closeButton.title = closeButton.ariaLabel = t('labelPrint.dismissRequest')
  image.alt = t('labelPrint.pcPrintPreview')

  let active: PendingPrint | null = null
  let label: PcPrintLabel | null = null
  let dismissed: string | null = null
  let previewAbort: AbortController | undefined
  let checking = false
  let busy = false
  let claimed = false
  let disposed = false
  let generation = 0

  const claim = (id: number) => api.post<void>(`/labels/print-requests/${id}/claim`)
  const printText = (key: string) => { printButton.querySelector('span')!.textContent = t(key) }
  function showError(error: unknown) {
    errorMessage.textContent = error instanceof Error ? error.message : t('labelPrint.browserPrintFailed')
    errorMessage.hidden = false
  }
  function hide() {
    generation++
    previewAbort?.abort()
    active = null
    label = null
    claimed = false
    if (download.hasAttribute('href')) URL.revokeObjectURL(download.href)
    download.removeAttribute('href')
    download.hidden = true
    printButton.hidden = false
    image.removeAttribute('src')
    image.hidden = true
    banner.classList.add('hidden')
    waiting.hidden = true
  }
  function updateAge() {
    if (!active) return
    const created = Date.parse(active.created_at)
    const expires = Date.parse(active.expires_at)
    if (!Number.isFinite(created) || !Number.isFinite(expires) || Date.now() >= expires) {
      hide()
      return
    }
    const minutes = Math.max(0, Math.floor((Date.now() - created) / 60_000))
    age.hidden = minutes < 1
    const ageText = t('labelPrint.requestAge', { minutes })
    if (age.textContent !== ageText) age.textContent = ageText
    age.classList.toggle('is-expiring', minutes >= 55)
  }
  async function prepare(request: PendingPrint) {
    previewAbort?.abort()
    const abort = previewAbort = new AbortController()
    printButton.disabled = true
    errorMessage.hidden = true
    title.textContent = t('labelPrint.pcPrintLoading')
    printText('common.print')
    try {
      const { loadPcPrintLabel } = await import('./label-pc-print-output')
      if (abort.signal.aborted) return
      const rendered = await loadPcPrintLabel(request.id, abort.signal)
      updateAge()
      if (active !== request || abort.signal.aborted || disposed) return
      label = rendered
      image.src = rendered.dataUrl
      image.hidden = false
      message.textContent += ` · ${rendered.widthMm} × ${rendered.heightMm} mm`
      title.textContent = t('labelPrint.pcPrintTitle')
    } catch (error) {
      if (active !== request || abort.signal.aborted || disposed) return
      if (error instanceof ApiError && error.status === 409) { hide(); return }
      title.textContent = t('labelPrint.pcPrintUnavailable')
      showError(error)
      printText('common.retry')
    } finally {
      if (active === request && !disposed) printButton.disabled = busy
    }
  }

  function action(edit: boolean) {
    updateAge()
    if (!active || busy) return
    const request = active
    if (!edit && !label) { void prepare(request); return }
    const rendered = label
    const asPdf = getPrintPdfPreference()
    // Reserve the window during the user's click, before claiming asynchronously.
    const popup = edit ? window.open('about:blank', '_blank') : null
    if (edit && !popup) { showError(new Error(t('labelPrint.printPopupBlocked'))); return }
    if (edit) previewAbort?.abort()
    busy = true
    errorMessage.hidden = true
    printButton.disabled = editButton.disabled = closeButton.disabled = true
    void (async () => {
      try {
        if (!claimed) {
          await claim(request.id)
          if (active !== request || disposed) { popup?.close(); return }
          claimed = true
        }
        updateAge()
        if (active !== request || disposed) { popup?.close(); return }
        if (edit) {
          const path = 'filament_id' in request ? `filaments/${request.filament_id}` : `spools/${request.spool_id}`
          popup!.location.href = `/${path}/print?scale_print=1${request.preset_id ? `&preset_id=${request.preset_id}` : ''}`
        } else {
          const { printPcLabel } = await import('./label-pc-print-output')
          const canPrint = () => { updateAge(); return active === request && !disposed }
          if (!canPrint()) return
          const pdf = await printPcLabel(rendered!, asPdf, canPrint)
          updateAge()
          if (active !== request || disposed) return
          if (pdf) {
            download.href = URL.createObjectURL(pdf)
            download.hidden = false
            printButton.hidden = true
            download.focus()
            return
          }
        }
        hide()
      } catch (error) {
        popup?.close()
        if (active !== request || disposed) return
        if (error instanceof ApiError && error.status === 409) hide()
        else showError(error)
      } finally {
        busy = false
        printButton.disabled = editButton.disabled = closeButton.disabled = false
      }
    })()
  }
  printButton.onclick = () => action(false)
  editButton.onclick = () => action(true)
  closeButton.onclick = () => {
    if (!active || busy) return
    const request = active
    const alreadyClaimed = claimed
    dismissed = fingerprint(request)
    hide()
    if (!alreadyClaimed) void claim(request.id).catch(() => {})
  }

  async function check() {
    updateAge()
    if (checking || busy || disposed || document.hidden) return
    checking = true
    const before = generation
    try {
      const pending = await api.get<PendingPrint | null>('/labels/print-requests/pending')
      if (disposed || before !== generation || busy) return
      if (claimed) {
        if (pending?.id !== active?.id) waiting.hidden = !pending
        return
      }
      if (!pending) { if (active) hide(); return }
      if (fingerprint(pending) === dismissed) {
        // Retry failed dismissals so the oldest request cannot block the queue.
        await claim(pending.id).catch(() => {})
        return
      }
      if (active && fingerprint(active) === fingerprint(pending)) {
        waiting.hidden = !pending.has_more
        return
      }
      hide()
      active = pending
      updateAge()
      if (!active) return
      message.textContent = t('filament_id' in pending ? 'labelPrint.pcPrintFilamentPrompt' : 'labelPrint.pcPrintPrompt', {
        id: 'filament_id' in pending ? pending.filament_id : pending.spool_id,
      })
      banner.classList.remove('hidden')
      waiting.hidden = !pending.has_more
      void prepare(pending)
    } catch {
      // Keep the preview and its expiry timer usable while the server is unavailable.
    } finally { checking = false }
  }
  function resume() { updateAge(); void check() }
  void check()
  const poll = window.setInterval(() => { void check() }, 3000)
  const clock = window.setInterval(updateAge, 1000)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('pageshow', resume)
  function onPageHide(event: PageTransitionEvent) {
    if (event.persisted) return
    disposed = true
    hide()
    window.clearInterval(poll)
    window.clearInterval(clock)
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('pagehide', onPageHide)
  }
  window.addEventListener('pagehide', onPageHide)
}
