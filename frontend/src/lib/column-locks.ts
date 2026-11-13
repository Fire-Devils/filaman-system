import { ensureHeaderControls, preserveTranslatedHeading } from './table-column-filters'
import { t } from './i18n'

export function initColumnLocks(
  table: HTMLTableElement,
  storageKey: string,
  isVisible: (cell: HTMLTableCellElement) => boolean = () => true,
) {
  const wrapper = table.parentElement!
  const header = table.querySelector('thead tr')!
  const actions = header.querySelector<HTMLTableCellElement>('[data-column-actions]')
  const selection = header.querySelector<HTMLTableCellElement>('[data-column-selection]')

  const locks = (['start', 'end'] as const).flatMap(edge => {
    if (edge === 'end' && !actions) return []
    const key = `${storageKey}-unlock-${edge}`
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fm-header-lock-trigger'
    button.dataset.columnLock = edge
    const label = edge === 'start' ? 'common.lockFirstColumn' : 'common.lockActionsColumn'
    button.dataset.i18nAriaLabel = label
    button.setAttribute('aria-label', t(label))
    const lock = { edge, button, enabled: localStorage.getItem(key) !== 'true' }
    button.addEventListener('click', event => {
      event.stopPropagation()
      lock.enabled = !lock.enabled
      localStorage.setItem(key, String(!lock.enabled))
      table.dispatchEvent(new Event('filaman:columns-changed'))
    })
    return [lock]
  })

  function updateScrollEdges() {
    const overflow = wrapper.scrollWidth - wrapper.clientWidth
    const offset = Math.abs(wrapper.scrollLeft)
    wrapper.toggleAttribute('data-overflow-start', overflow > 1 && offset > 1)
    wrapper.toggleAttribute('data-overflow-end', overflow - offset > 1)
  }

  function updateScrollPadding() {
    const width = (pin: string) =>
      header.querySelector(`[data-column-pin="${pin}"]`)?.getBoundingClientRect().width ?? 0
    const selectionWidth = width('selection')
    wrapper.style.setProperty('--fm-selection-width', `${selectionWidth}px`)
    wrapper.style.scrollPaddingInlineStart = `${selectionWidth + width('start')}px`
    wrapper.style.scrollPaddingInlineEnd = `${width('end')}px`
    updateScrollEdges()
  }

  const observer = new ResizeObserver(updateScrollPadding)
  observer.observe(wrapper)
  observer.observe(table)

  function updateLocks() {
    const headers = Array.from(header.querySelectorAll('th'))
    const first = headers.find(cell => cell !== selection && cell !== actions && isVisible(cell))
    const rows = table.querySelectorAll('tbody > tr')
    for (const cell of header.querySelectorAll('[data-column-pin]')) observer.unobserve(cell)
    table.querySelectorAll('[data-column-pin]').forEach(cell => cell.removeAttribute('data-column-pin'))

    function pin(cell: HTMLTableCellElement, edge: string) {
      cell.dataset.columnPin = edge
      observer.observe(cell)
      const index = headers.indexOf(cell)
      for (const row of rows) {
        if (row.children.length === headers.length) row.children[index].setAttribute('data-column-pin', edge)
      }
    }

    if (selection) pin(selection, 'selection')
    wrapper.toggleAttribute('data-start-locked', !!first && locks.some(lock => lock.edge === 'start' && lock.enabled))
    for (const { edge, button, enabled } of locks) {
      const cell = edge === 'start' ? first : actions
      if (!cell) {
        button.remove()
        continue
      }
      if (!cell.contains(button)) {
        const oldWrap = button.parentElement
        const focused = document.activeElement === button
        const labelKey = cell.dataset.i18n
        if (labelKey) preserveTranslatedHeading(cell, t(labelKey))
        ensureHeaderControls(cell).appendChild(button)
        if (oldWrap && !oldWrap.childElementCount) oldWrap.remove()
        if (focused) button.focus({ preventScroll: true })
      }
      const pressed = String(enabled)
      if (button.getAttribute('aria-pressed') !== pressed) {
        button.setAttribute('aria-pressed', pressed)
        const titleKey = enabled ? 'common.unlockColumn' : 'common.lockColumn'
        button.dataset.i18nTitle = titleKey
        button.title = t(titleKey)
        button.innerHTML = `<svg width="16" height="16" aria-hidden="true"><use href="/icons.svg?v=3#icon-${enabled ? 'lock' : 'unlock'}" /></svg>`
      }
      if (enabled) pin(cell, edge)
    }
    updateScrollPadding()
  }

  table.addEventListener('filaman:columns-changed', updateLocks)
  table.addEventListener('focusin', event => {
    const control = event.target
    if (control instanceof HTMLElement && !control.closest('[data-column-pin]')) {
      control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  })
  wrapper.addEventListener('scroll', updateScrollEdges, { passive: true })
  updateLocks()
}
