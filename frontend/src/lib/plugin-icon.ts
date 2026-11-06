/** Decorative plugin identity, with the existing puzzle icon as a load-safe fallback. */
export function createPluginIcon(url?: string | null): HTMLSpanElement {
  const icon = document.createElement('span')
  icon.className = 'fm-plugin-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = '<svg><use href="/icons.svg?v=2#icon-plugin"></use></svg>'
  if (!url || !/^\/api\/v1\/plugin-icons\/[a-z][a-z0-9_]{2,49}(?:\?v=[A-Za-z0-9._%-]+)?$/.test(url)) return icon

  const image = document.createElement('img')
  // Match the CSS mask's fetch mode so both reuse the authenticated request.
  image.crossOrigin = 'anonymous'
  image.alt = ''
  image.width = 22
  image.height = 22
  image.hidden = true
  image.addEventListener('load', () => {
    const mask = document.createElement('i')
    mask.className = 'fm-plugin-icon-mask'
    mask.style.maskImage = `url("${url}")`
    mask.style.webkitMaskImage = mask.style.maskImage
    icon.replaceChildren(mask)
  }, { once: true })
  image.addEventListener('error', () => image.remove(), { once: true })
  image.src = url
  icon.appendChild(image)
  return icon
}
