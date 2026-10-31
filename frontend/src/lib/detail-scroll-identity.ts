/** Bind again when a detail page replaces its hero, reusing the same strip/listeners. */
export function createDetailScrollIdentity(toolbar: HTMLElement) {
  const main = toolbar.closest('main')!
  const strip = toolbar.querySelector<HTMLElement>('.detail-scroll-identity')!
  const recordId = strip.querySelector<HTMLElement>('.detail-scroll-id')!
  const name = strip.querySelector<HTMLElement>('.detail-scroll-name')!
  const pill = strip.querySelector<HTMLElement>('.detail-scroll-swatch')!
  let title: HTMLElement | null = null
  let color: HTMLElement | null = null
  let colorName: HTMLElement | null = null

  function syncVisibility(): void {
    const visible = !!title?.isConnected
      && title.getBoundingClientRect().bottom <= toolbar.getBoundingClientRect().bottom
    if (strip.classList.contains('is-visible') === visible) return
    strip.classList.toggle('is-visible', visible)
    strip.setAttribute('aria-hidden', String(!visible))
  }

  function refresh(): void {
    name.textContent = title?.textContent ?? ''
    name.title = name.textContent
    // Reuse the hero fill, including multicolor and transparency; do not clone its IDs.
    pill.style.cssText = color?.getAttribute('style') ?? ''
    pill.hidden = !pill.style.backgroundImage
    pill.setAttribute('aria-label', colorName?.textContent ?? '')
    syncVisibility()
  }

  const observer = new MutationObserver(refresh)
  main.addEventListener('scroll', syncVisibility, { passive: true })
  window.addEventListener('resize', syncVisibility)

  return (hero: HTMLElement, label: string): void => {
    observer.disconnect()
    title = hero.querySelector<HTMLElement>('.detail-record-name, #filament-editor-title')
    color = hero.querySelector<HTMLElement>('.filament-color-dot')
    colorName = hero.querySelector<HTMLElement>('.filament-color-name')
    recordId.textContent = label
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true })
    if (color) observer.observe(color, { attributes: true, attributeFilter: ['style'] })
    if (colorName) observer.observe(colorName, { childList: true, characterData: true, subtree: true })
    refresh()
  }
}
