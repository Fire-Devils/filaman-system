export interface ManufacturerLogoLike {
  name?: string | null
  logo_url?: string | null
  logo_file_path?: string | null
  resolved_logo_url?: string | null
}

interface RenderManufacturerLogoOptions {
  size?: number
  width?: number
  height?: number
  borderRadius?: string
  previewUrl?: string | null
  tooltipText?: string | null
}

export function escapeHtml(value: string | number | null | undefined): string {
  const div = document.createElement('div')
  div.textContent = value == null ? '' : String(value)
  return div.innerHTML
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function getManufacturerLogoUrl(manufacturer?: ManufacturerLogoLike | null): string | null {
  return normalizeOptionalString(manufacturer?.resolved_logo_url) ?? normalizeOptionalString(manufacturer?.logo_url)
}

export function renderManufacturerLogo(
  manufacturer?: ManufacturerLogoLike | null,
  options: RenderManufacturerLogoOptions = {},
): string {
  const size = options.size ?? 40
  const width = options.width ?? size
  const height = options.height ?? size
  const borderRadius = options.borderRadius ?? '10px'
  const previewUrl = normalizeOptionalString(options.previewUrl)
  const tooltipText = normalizeOptionalString(options.tooltipText)
  const imageUrl = previewUrl ?? getManufacturerLogoUrl(manufacturer)
  const altText = escapeHtml(`${manufacturer?.name || 'Manufacturer'} logo`)
  const fallbackText = escapeHtml(manufacturer?.name?.trim() || 'Logo')
  const fallbackFontSize = Math.max(12, Math.floor(Math.min(width, height) * 0.34))
  const titleAttr = tooltipText ? ` title="${escapeHtml(tooltipText)}"` : ''

  if (imageUrl) {
    return `<img src="${escapeHtml(imageUrl)}" alt="${altText}"${titleAttr} style="width: ${width}px; height: ${height}px; object-fit: contain; border-radius: ${borderRadius}; flex-shrink: 0;" />`
  }

  return `<div aria-hidden="true"${titleAttr} style="width: ${width}px; height: ${height}px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: ${fallbackFontSize}px; font-weight: 600; font-family: var(--font-serif); letter-spacing: 0.03em; font-style: italic; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${fallbackText}</div>`
}