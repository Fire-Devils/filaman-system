export function columnClassName(key: string): string {
  return /\s/.test(key) ? '' : `col-${key}`
}

export function createSortableColumnHeader(key: string, label: string): HTMLTableCellElement {
  const header = document.createElement('th')
  header.className = `sortable ${columnClassName(key)}`
  header.dataset.columnKey = encodeURIComponent(key)
  header.dataset.sort = key
  header.textContent = label
  return header
}

export function getColKey(el: Element): string | null {
  const encodedKey = el.getAttribute('data-column-key')
  if (encodedKey !== null) return decodeURIComponent(encodedKey)
  for (const cls of el.classList) {
    if (cls.startsWith('col-') && cls !== 'col-resizable') return cls.slice(4)
  }
  return null
}

export function columnCellSelector(key: string): string {
  return `:is(.col-${CSS.escape(key)}, [data-column-key="${CSS.escape(encodeURIComponent(key))}"])`
}
