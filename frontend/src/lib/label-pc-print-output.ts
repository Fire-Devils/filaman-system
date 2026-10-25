import { ApiError } from './api'
import { printLabelBrowserJob } from './label-browser-print'
import { createLabelPagesPdf, type LabelPdfPage } from './label-export'
import { pngDataUrl } from './label-svg/browser'
import { t } from './i18n'

export type PcPrintLabel = LabelPdfPage

export async function loadPcPrintLabel(id: number, signal: AbortSignal): Promise<PcPrintLabel> {
  const response = await fetch(`/api/v1/labels/print-requests/${id}/preview`, { credentials: 'include', signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new ApiError(response.status, 'print_preview', typeof body.detail === 'string' ? body.detail : t('labelPrint.pcPrintUnavailable'))
  }
  const widthMm = Number(response.headers.get('X-Label-Width-Mm'))
  const heightMm = Number(response.headers.get('X-Label-Height-Mm'))
  if (response.headers.get('Content-Type') !== 'image/png' || ![widthMm, heightMm].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error(t('labelPrint.pcPrintUnavailable'))
  }
  const dataUrl = pngDataUrl(new Uint8Array(await response.arrayBuffer()))
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  signal.throwIfAborted()
  return { dataUrl, widthMm, heightMm }
}

export async function printPcLabel(label: PcPrintLabel, asPdf: boolean, canPrint?: () => boolean): Promise<Blob | void> {
  if (asPdf) {
    const pdf = await createLabelPagesPdf([label])
    if (!pdf) throw new Error(t('labelPrint.printPdfFailed'))
    return pdf.output('blob')
  }
  const page = document.createElement('div')
  page.style.cssText = `width:${label.widthMm}mm;height:${label.heightMm}mm;overflow:hidden`
  const image = new Image()
  image.src = label.dataUrl
  image.style.cssText = 'display:block;width:100%;height:100%'
  page.append(image)
  await printLabelBrowserJob({ kind: 'individual', widthMm: label.widthMm, heightMm: label.heightMm,
    pages: [page], printGrid: false }, canPrint)
}
