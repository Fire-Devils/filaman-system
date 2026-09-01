// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import TemporaryPdfPreview from '../components/TemporaryPdfPreview.astro'
import { setLang, t, translatePage } from './i18n'
import { bindTemporaryPdfPreview, detectInlinePdfSupport } from './label-pdf-preview'

function renderHost() {
  document.body.innerHTML = `
    <button id="btn-print">Print</button>
    <main class="preview-container">
      <div class="preview-zoom-bar">Zoom</div>
      <div class="preview-scroll-area"><div class="label-preview">PETG</div></div>
      <section id="temporary-pdf-preview" class="temporary-pdf-preview" hidden tabindex="-1">
        <div class="temporary-pdf-toolbar">
          <button id="temporary-pdf-back">Back</button>
          <button id="temporary-pdf-open">Open</button>
          <a id="temporary-pdf-download">Download</a>
        </div>
        <div id="temporary-pdf-content"></div>
        <div id="temporary-pdf-unsupported" hidden>Unsupported</div>
      </section>
    </main>`
}

const blob = new Blob(['%PDF-1.3'], { type: 'application/pdf' })

beforeEach(() => {
  renderHost()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLang('en')
})

describe('detectInlinePdfSupport', () => {
  it('detects all three support states', () => {
    expect(detectInlinePdfSupport({ pdfViewerEnabled: true })).toBe('supported')
    expect(detectInlinePdfSupport({ pdfViewerEnabled: false })).toBe('unsupported')
    expect(detectInlinePdfSupport({})).toBe('unknown')
  })
})

describe('TemporaryPdfPreview toolbar', () => {
  async function renderToolbar() {
    const container = await AstroContainer.create()
    document.body.innerHTML = await container.renderToString(TemporaryPdfPreview)
  }

  it('renders Back as an accessible text action with a decorative arrow', async () => {
    await renderToolbar()

    const back = document.querySelector<HTMLButtonElement>('#temporary-pdf-back')!

    expect(back.getAttribute('aria-label')).toBe('Back to label preview')
    expect(back.textContent?.trim()).toBe('Back to label preview')
    expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it.each([
    ['#temporary-pdf-open', 'Open PDF for printing'],
    ['#temporary-pdf-download', 'Download PDF'],
  ] as const)(
    'renders %s as an accessible icon-only action',
    async (selector, label) => {
      await renderToolbar()

      const control = document.querySelector<HTMLElement>(selector)!
      expect(control.getAttribute('aria-label')).toBe(label)
      expect(control.title).toBe(label)
      expect(control.textContent?.trim()).toBe('')
      expect(control.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
        'true',
      )
    },
  )

  it('translates visible text, tooltips, and accessible names together', async () => {
    await renderToolbar()
    setLang('de')

    translatePage()

    const back = document.querySelector<HTMLButtonElement>('#temporary-pdf-back')!
    const open = document.querySelector<HTMLButtonElement>('#temporary-pdf-open')!
    const download = document.querySelector<HTMLAnchorElement>(
      '#temporary-pdf-download',
    )!

    expect(back.textContent?.trim()).toBe('Zurück zur Labelvorschau')
    expect(back.title).toBe('Zurück zur Labelvorschau')
    expect(back.getAttribute('aria-label')).toBe('Zurück zur Labelvorschau')
    expect(open.title).toBe('PDF zum Drucken öffnen')
    expect(open.getAttribute('aria-label')).toBe('PDF zum Drucken öffnen')
    expect(download.title).toBe('PDF herunterladen')
    expect(download.getAttribute('aria-label')).toBe('PDF herunterladen')
  })

  it.each(['supported', 'unsupported', 'unknown'] as const)(
    'keeps Open and Download available when inline PDF support is %s',
    async inlinePdfSupport => {
      await renderToolbar()
      document.body.innerHTML = `
        <main class="preview-container">
          <div class="label-preview">PETG</div>
          ${document.body.innerHTML}
        </main>`
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:inline-pdf')
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const preview = bindTemporaryPdfPreview({
        getTranslation: (_key, fallback) => fallback,
        inlinePdfSupport,
      })

      preview.show({ blob, filename: 'label.pdf' })

      expect(
        document.querySelector<HTMLElement>('#temporary-pdf-preview')!.hidden,
      ).toBe(false)
      expect(
        document.querySelector<HTMLButtonElement>('#temporary-pdf-open')!.hidden,
      ).toBe(false)
      expect(
        document.querySelector<HTMLAnchorElement>('#temporary-pdf-download')!
          .hidden,
      ).toBe(false)

      preview.dispose()
    },
  )
})

describe('bindTemporaryPdfPreview', () => {
  function bind(inlinePdfSupport?: 'supported' | 'unsupported' | 'unknown') {
    return bindTemporaryPdfPreview({
      getTranslation: (_key, fallback) => fallback,
      inlinePdfSupport,
    })
  }

  function stubObjectUrls(...urls: string[]) {
    return {
      create: vi
        .spyOn(URL, 'createObjectURL')
        .mockImplementation(() => urls.shift()!),
      revoke: vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
    }
  }

  function bindWithCurrentPageTranslation(
    inlinePdfSupport: 'supported' | 'unsupported' | 'unknown' = 'supported',
  ) {
    return bindTemporaryPdfPreview({
      getTranslation: (key, fallback) => {
        const translated = t(key)
        return translated === key ? fallback : translated
      },
      inlinePdfSupport,
    })
  }

  it.each([
    ['en', 'Temporary print PDF preview'],
    ['de', 'Vorschau der temporären Druck-PDF'],
  ] as const)(
    'names the inline PDF object in the current %s locale',
    (locale, accessibleTitle) => {
      stubObjectUrls('blob:inline-pdf')
      const preview = bindWithCurrentPageTranslation()
      setLang(locale)

      preview.show({ blob, filename: 'label.pdf' })

      expect(
        document.querySelector<HTMLObjectElement>(
          '#temporary-pdf-content object',
        )?.title,
      ).toBe(accessibleTitle)
    },
  )

  it.each([
    ['en', 'Temporary print PDF preview'],
    ['de', 'Vorschau der temporären Druck-PDF'],
  ] as const)(
    'names the popup PDF object in the current %s locale',
    (locale, accessibleTitle) => {
      stubObjectUrls('blob:inline-pdf', 'blob:external-pdf')
      const popupDocument = document.implementation.createHTMLDocument('PDF')
      vi.spyOn(window, 'open').mockReturnValue({
        document: popupDocument,
      } as unknown as Window)
      const preview = bindWithCurrentPageTranslation()
      setLang(locale)

      preview.show({ blob, filename: 'label.pdf' })
      document.querySelector<HTMLButtonElement>('#temporary-pdf-open')!.click()

      expect(popupDocument.querySelector<HTMLObjectElement>('object')?.title)
        .toBe(accessibleTitle)
    },
  )

  it.each(['supported', 'unknown'] as const)(
    'renders an inline object when support is %s',
    inlinePdfSupport => {
      stubObjectUrls('blob:inline-pdf')
      const preview = bind(inlinePdfSupport)

      preview.show({ blob, filename: 'label.pdf' })

      const object = document.querySelector<HTMLObjectElement>(
        '#temporary-pdf-content object',
      )
      const surface = document.querySelector<HTMLElement>(
        '#temporary-pdf-preview',
      )!
      const livePreview = document.querySelector<HTMLElement>(
        '.preview-scroll-area',
      )!
      const download = document.querySelector<HTMLAnchorElement>(
        '#temporary-pdf-download',
      )!

      expect(object).not.toBeNull()
      expect(object!.type).toBe('application/pdf')
      expect(object!.data).toBe('blob:inline-pdf')
      expect(livePreview.textContent).toContain('PETG')
      expect(livePreview.inert).toBe(true)
      expect(livePreview.getAttribute('aria-hidden')).toBe('true')
      expect(surface.hidden).toBe(false)
      expect(document.activeElement).toBe(surface)
      expect(download.href).toBe('blob:inline-pdf')
      expect(download.download).toBe('label.pdf')
    },
  )

  it('shows the unsupported panel without an inline object', () => {
    stubObjectUrls('blob:inline-pdf')
    const preview = bind('unsupported')

    preview.show({ blob, filename: 'label.pdf' })

    expect(document.querySelector('#temporary-pdf-content object')).toBeNull()
    expect(
      document.querySelector<HTMLElement>('#temporary-pdf-unsupported')!.hidden,
    ).toBe(false)
  })

  it('returns through Back and restores focus after revoking the inline URL', () => {
    const { revoke } = stubObjectUrls('blob:inline-pdf')
    const preview = bind('supported')
    const printButton = document.querySelector<HTMLElement>('#btn-print')!
    const back = document.querySelector<HTMLButtonElement>('#temporary-pdf-back')!
    const surface = document.querySelector<HTMLElement>('#temporary-pdf-preview')!

    preview.show({ blob, filename: 'label.pdf', returnFocus: printButton })
    back.click()

    expect(surface.hidden).toBe(true)
    expect(document.activeElement).toBe(printButton)
    expect(revoke).toHaveBeenCalledWith('blob:inline-pdf')
  })

  it('opens a separate PDF object without revoking its external URL until disposal', () => {
    const { revoke } = stubObjectUrls('blob:inline-pdf', 'blob:external-pdf')
    const popupDocument = document.implementation.createHTMLDocument('PDF')
    const popup = { document: popupDocument }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const preview = bind('supported')

    preview.show({ blob, filename: 'label.pdf' })
    document.querySelector<HTMLButtonElement>('#temporary-pdf-open')!.click()

    expect(popupDocument.querySelector('object')?.data).toBe('blob:external-pdf')
    preview.hide()
    expect(revoke).not.toHaveBeenCalledWith('blob:external-pdf')
    window.dispatchEvent(new Event('pagehide'))
    expect(revoke).toHaveBeenCalledWith('blob:external-pdf')
  })

  it('replaces only the prior inline URL and disposes each owned URL once', () => {
    const { revoke } = stubObjectUrls(
      'blob:inline-pdf',
      'blob:replacement-pdf',
    )
    const preview = bind('supported')

    preview.show({ blob, filename: 'label.pdf' })
    preview.show({ blob, filename: 'replacement.pdf' })

    expect(revoke).toHaveBeenCalledWith('blob:inline-pdf')
    expect(revoke).not.toHaveBeenCalledWith('blob:replacement-pdf')

    preview.dispose()
    preview.dispose()

    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledWith('blob:replacement-pdf')
  })

  it('alerts and revokes the external URL when the PDF popup is blocked', () => {
    const { revoke } = stubObjectUrls('blob:inline-pdf', 'blob:external-pdf')
    vi.spyOn(window, 'open').mockReturnValue(null)
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const preview = bind('supported')

    preview.show({ blob, filename: 'label.pdf' })
    document.querySelector<HTMLButtonElement>('#temporary-pdf-open')!.click()

    expect(alert).toHaveBeenCalledWith('Allow pop-ups to open the print PDF.')
    expect(revoke).toHaveBeenCalledWith('blob:external-pdf')
  })
})
