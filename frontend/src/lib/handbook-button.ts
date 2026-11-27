import { getHandbookUrl, findOpenHandbookKey, isHandbookKey } from './handbook'
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
  document.querySelectorAll('.fm-help-btn:not(.fm-help-btn--dialog)').forEach(el => el.remove())
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

/** Things that count as a dialog: native dialogs, overlay modals, and anything marked `data-help-dialog`. */
export const DIALOG_ROOTS = 'dialog, .fm-modal-overlay, [data-help-dialog]'

/**
 * Where the help button goes inside a dialog, first match wins. Dialogs without any of these
 * (plain confirm/alert boxes, a bare title without a header) get no button.
 * Special cases: put `data-help-slot` on the header (or its actions) of the dialog.
 */
export const DIALOG_HEADS = [
  '[data-help-slot]',
  '.fm-form-dialog-header .fm-header-actions',
  '.fm-form-dialog-header',
  '.fm-section-header',
  '.entity-extra-fields-dialog-header',
  '.filament-color-dialog-header',
]

/** Dialogs that never get a button, even if they have a header (confirm/alert style). */
const DIALOG_SKIP = '#fm-confirm-overlay, [data-help-skip]'

function isCloseButton(el: Element): boolean {
  if (!el.matches('button, a')) return false
  if (el.classList.contains('fm-help-btn')) return false
  const names = Array.from(el.attributes).map(a => a.name).join(' ')
  if (/close/i.test(`${el.id} ${el.className} ${names}`)) return true
  return /^[×✕✖xX]$/.test((el.textContent ?? '').trim())
}

export function findDialogHead(root: Element): Element | null {
  for (const selector of DIALOG_HEADS) {
    const head = root.querySelector(selector)
    if (head) return head
  }
  return null
}

/** Manual URL for a button inside a dialog: nearest data-handbook ancestor, else the route. */
export function updateDialogHandbookHref(link: HTMLAnchorElement): void {
  const own = link.closest('[data-handbook]')?.getAttribute('data-handbook')
  link.href = getHandbookUrl({
    pathname: location.pathname,
    lang: getLang(),
    dialogKey: isHandbookKey(own) ? own : null,
  })
}

/** Adds a help button to one dialog head if it has none yet. Returns the button when added. */
export function addDialogHelpButton(root: Element, proto: HTMLAnchorElement): HTMLAnchorElement | null {
  if (root.matches(DIALOG_SKIP) || root.querySelector('.fm-help-btn--dialog')) return null
  const head = findDialogHead(root)
  if (!head) return null
  const link = proto.cloneNode(true) as HTMLAnchorElement
  link.removeAttribute('id')
  link.hidden = false
  link.classList.add('fm-help-btn', 'fm-help-btn--dialog')
  const last = head.lastElementChild
  if (last && isCloseButton(last)) head.insertBefore(link, last)
  else head.append(link)
  for (const type of ['pointerdown', 'focus', 'mouseenter', 'click', 'contextmenu'] as const) {
    link.addEventListener(type, () => updateDialogHandbookHref(link))
  }
  updateDialogHandbookHref(link)
  return link
}

/** Walks all dialogs in the document; safe to call repeatedly. */
export function placeDialogHelpButtons(root: ParentNode = document): void {
  const proto = root.querySelector<HTMLAnchorElement>('#fm-handbook-proto')
  if (!proto) return
  root.querySelectorAll(DIALOG_ROOTS).forEach(el => addDialogHelpButton(el, proto))
}

let dialogObserver: MutationObserver | undefined

/** Dialogs are created by pages and scripts at any time, and the body is replaced on navigation. */
function watchDialogs(): void {
  dialogObserver?.disconnect()
  if (typeof MutationObserver === 'undefined') return
  let queued = false
  dialogObserver = new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      placeDialogHelpButtons()
    })
  })
  dialogObserver.observe(document.documentElement, { childList: true, subtree: true })
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
      if (!document.querySelector('.fm-help-btn:not(.fm-help-btn--dialog)')) placeHandbookButton()
    })
  })
  observer.observe(main, { childList: true, subtree: true })
}

export function setupHandbookButton(): void {
  placeHandbookButton()
  placeDialogHelpButtons()
  watchMain()
  watchDialogs()
  document.addEventListener('astro:after-swap', () => {
    placeHandbookButton()
    placeDialogHelpButtons()
    watchMain()
    watchDialogs()
  })
}
