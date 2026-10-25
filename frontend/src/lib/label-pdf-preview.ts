export type InlinePdfSupport = 'supported' | 'unsupported' | 'unknown'

export const LABEL_PRINT_PDF_MODE_KEY = 'filaman-label-print-pdf-v1'

export function getPrintPdfPreference(): boolean {
  try { return localStorage.getItem(LABEL_PRINT_PDF_MODE_KEY) === 'true' }
  catch { return false }
}

/** The caller reserves this window synchronously during the user's click. */
export function showPrintPdfWindow(
  popup: Window, blob: Blob, filename: string,
  getTranslation: (key: string, fallback: string) => string,
) {
  const popupUrl = (popup as Window & { URL: typeof URL }).URL
  const url = popupUrl.createObjectURL(blob)
  popup.addEventListener('pagehide', () => popupUrl.revokeObjectURL(url), { once: true })
  const doc = popup.document
  const object = createPdfObject(doc, url, getTranslation)
  object.style.cssText = 'width:100%;flex:1;min-height:0;border:0'
  const download = doc.createElement('a')
  download.href = url
  download.download = filename
  download.textContent = getTranslation('labelPrint.downloadPdf', 'Download PDF')
  download.style.cssText = 'padding:8px;font:14px system-ui'
  doc.title = filename
  doc.documentElement.style.height = '100%'
  doc.body.style.cssText = 'display:flex;flex-direction:column;height:100%;margin:0'
  doc.body.replaceChildren(download, object)
}

export interface TemporaryPdfPreviewDocument {
  blob: Blob
  filename: string
  returnFocus?: HTMLElement
}

export interface TemporaryPdfPreviewController {
  show(document: TemporaryPdfPreviewDocument): void
  hide(): void
  dispose(): void
}

export interface BindTemporaryPdfPreviewOptions {
  root?: ParentNode
  getTranslation(key: string, fallback: string): string
  inlinePdfSupport?: InlinePdfSupport
}

const INLINE_PDF_UNSUPPORTED =
  'This browser cannot display the temporary PDF in the preview. Open or download the PDF to print it.'
const PRINT_POPUP_BLOCKED = 'Allow pop-ups to open the print PDF.'
const TEMPORARY_PDF_PREVIEW_TITLE = 'Temporary print PDF preview'

export function detectInlinePdfSupport(
  navigatorLike: object = navigator,
): InlinePdfSupport {
  const { pdfViewerEnabled } = navigatorLike as {
    pdfViewerEnabled?: unknown
  }

  if (pdfViewerEnabled === true) return 'supported'
  if (pdfViewerEnabled === false) return 'unsupported'
  return 'unknown'
}

export function bindTemporaryPdfPreview(
  options: BindTemporaryPdfPreviewOptions,
): TemporaryPdfPreviewController {
  const root = options.root ?? document
  const previewContainer = resolvePreviewContainer(root)
  const surface = resolveElement<HTMLElement>(root, '#temporary-pdf-preview')
  const backButton = resolveElement<HTMLButtonElement>(
    root,
    '#temporary-pdf-back',
  )
  const openButton = resolveElement<HTMLButtonElement>(
    root,
    '#temporary-pdf-open',
  )
  const download = resolveElement<HTMLAnchorElement>(
    root,
    '#temporary-pdf-download',
  )
  const content = resolveElement<HTMLElement>(root, '#temporary-pdf-content')
  const unsupported = resolveElement<HTMLElement>(
    root,
    '#temporary-pdf-unsupported',
  )
  const liveChildren = Array.from(previewContainer.children)
    .filter(child => child !== surface)
    .map(element => ({
      element: element as HTMLElement,
      inert: (element as HTMLElement).inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }))
  const inlinePdfSupport =
    options.inlinePdfSupport ?? detectInlinePdfSupport()
  let inlineUrl: string | undefined
  let currentDocument: TemporaryPdfPreviewDocument | undefined
  let returnFocus: HTMLElement | undefined
  let disposed = false

  const releaseInlineUrl = () => {
    if (!inlineUrl) return
    URL.revokeObjectURL(inlineUrl)
    inlineUrl = undefined
  }

  const restoreLiveChildren = () => {
    previewContainer.classList.remove('is-temporary-pdf-preview-active')
    for (const child of liveChildren) {
      child.element.inert = child.inert
      if (child.ariaHidden === null) {
        child.element.removeAttribute('aria-hidden')
      } else {
        child.element.setAttribute('aria-hidden', child.ariaHidden)
      }
    }
  }

  const hide = () => {
    content.replaceChildren()
    unsupported.hidden = true
    surface.hidden = true
    releaseInlineUrl()
    currentDocument = undefined
    restoreLiveChildren()
    returnFocus?.focus()
    returnFocus = undefined
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    hide()
    window.removeEventListener('pagehide', onPageHide)
    backButton.removeEventListener('click', onBack)
    openButton.removeEventListener('click', onOpen)
  }

  const onBack = () => hide()

  const onOpen = () => {
    const popup = window.open('', '_blank')

    if (!popup) {
      window.alert(
        options.getTranslation('labelPrint.printPopupBlocked', PRINT_POPUP_BLOCKED),
      )
      return
    }

    showPrintPdfWindow(popup, currentDocumentBlob(), download.download, options.getTranslation)
  }

  const onPageHide = () => dispose()

  const currentDocumentBlob = () => {
    if (!currentDocument) {
      throw new Error('Cannot open a temporary PDF preview before showing one.')
    }
    return currentDocument.blob
  }

  backButton.addEventListener('click', onBack)
  openButton.addEventListener('click', onOpen)
  window.addEventListener('pagehide', onPageHide)

  return {
    show(document) {
      if (disposed) return

      currentDocument = document
      returnFocus = document.returnFocus
      content.replaceChildren()
      unsupported.hidden = true
      releaseInlineUrl()
      inlineUrl = URL.createObjectURL(document.blob)
      download.href = inlineUrl
      download.download = document.filename

      for (const child of liveChildren) {
        child.element.inert = true
        child.element.setAttribute('aria-hidden', 'true')
      }
      previewContainer.classList.add('is-temporary-pdf-preview-active')

      if (inlinePdfSupport === 'unsupported') {
        unsupported.textContent = options.getTranslation(
          'labelPrint.inlinePdfUnsupported',
          INLINE_PDF_UNSUPPORTED,
        )
        unsupported.hidden = false
      } else {
        const object = createPdfObject(
          documentOwner(content),
          inlineUrl,
          options.getTranslation,
        )
        content.append(object)
      }

      surface.hidden = false
      surface.focus()
    },
    hide,
    dispose,
  }
}

function createPdfObject(
  owner: Document,
  url: string,
  getTranslation: (key: string, fallback: string) => string,
): HTMLObjectElement {
  const object = owner.createElement('object')
  object.type = 'application/pdf'
  object.data = url
  object.title = getTranslation(
    'labelPrint.temporaryPdfPreviewTitle',
    TEMPORARY_PDF_PREVIEW_TITLE,
  )
  object.append(
    owner.createTextNode(
      getTranslation('labelPrint.inlinePdfUnsupported', INLINE_PDF_UNSUPPORTED),
    ),
  )
  return object
}

function documentOwner(element: Element): Document {
  return element.ownerDocument
}

function resolvePreviewContainer(root: ParentNode): HTMLElement {
  if (root instanceof HTMLElement && root.matches('.preview-container')) {
    return root
  }
  return resolveElement<HTMLElement>(root, '.preview-container')
}

function resolveElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Temporary PDF preview is missing required element ${selector}.`)
  }
  return element
}
