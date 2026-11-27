import { getHandbookUrl, findOpenHandbookKey } from './handbook'
import { getLang } from './i18n'

const TOOLBARS = '.fm-list-toolbar, .fm-admin-toolbar, .dashboard-header'

/** Where the help button goes: explicit slot, header controls, header itself, or next to the first h1. */
export function findHelpSlot(main: ParentNode): { parent: Element; row: boolean } | null {
  const slot = main.querySelector('[data-help-slot]')
  if (slot) return { parent: slot, row: false }
  const detail = main.querySelector('.detail-page-toolbar')
  if (detail) return { parent: detail, row: false }
  const h1 = main.querySelector('h1')
  if (!h1) return null
  const toolbar = h1.closest(TOOLBARS)
  if (toolbar) return { parent: toolbar.querySelector(':scope > .fm-list-controls') ?? toolbar, row: false }
  const parent = h1.parentElement
  return parent ? { parent, row: true } : null
}

export function updateHandbookHref(link: HTMLAnchorElement): void {
  link.href = getHandbookUrl({
    pathname: location.pathname,
    lang: getLang(),
    dialogKey: findOpenHandbookKey(document),
  })
}

/**
 * The layout renders one hidden prototype link. Pages are swapped without a reload
 * (ClientRouter), so a fresh clone is attached to the new page header every time.
 */
export function placeHandbookButton(root: ParentNode = document): HTMLAnchorElement | null {
  const proto = root.querySelector<HTMLAnchorElement>('#fm-handbook-proto')
  const main = root.querySelector('main')
  if (!proto || !main) return null
  document.querySelectorAll('.fm-help-btn').forEach(el => el.remove())
  const slot = findHelpSlot(main)
  if (!slot) return null
  const link = proto.cloneNode(true) as HTMLAnchorElement
  link.removeAttribute('id')
  link.hidden = false
  link.classList.add('fm-help-btn')
  if (slot.row) slot.parent.classList.add('fm-help-row')
  slot.parent.append(link)
  const refresh = () => updateHandbookHref(link)
  for (const type of ['pointerdown', 'focus', 'mouseenter', 'click', 'contextmenu'] as const) {
    link.addEventListener(type, refresh)
  }
  refresh()
  return link
}

let observer: MutationObserver | undefined

/** Some pages render their header after load (printer, print job): keep an eye on <main>. */
function watchMain(): void {
  observer?.disconnect()
  const main = document.querySelector('main')
  if (!main || typeof MutationObserver === 'undefined') return
  let queued = false
  observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (!document.querySelector('.fm-help-btn')) placeHandbookButton()
    })
  })
  observer.observe(main, { childList: true, subtree: true })
}

export function setupHandbookButton(): void {
  placeHandbookButton()
  watchMain()
  document.addEventListener('astro:after-swap', () => {
    placeHandbookButton()
    watchMain()
  })
}
