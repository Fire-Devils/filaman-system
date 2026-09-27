/** AMS View bay fill. Only validated hex reaches the style attribute. */

const HEX6 = /^#[0-9A-F]{6}$/

export function amsSwatchHexes(values: unknown, fallback?: unknown): string[] {
  const list = Array.isArray(values) ? values : []
  const hexes = list
    .map(value => String(value ?? '').trim().toUpperCase())
    .filter(value => HEX6.test(value))
  if (hexes.length > 0) return hexes
  const one = String(fallback ?? '').trim().toUpperCase()
  return HEX6.test(one) ? [one] : []
}

/** Stripes are hard bands. Gradient is a smooth blend along the bay. */
export function amsSwatchFill(hexes: string[], style: unknown): string {
  if (hexes.length === 0) return '#202020'
  if (hexes.length === 1) return hexes[0]
  if (String(style ?? '').trim().toLowerCase() === 'gradient') {
    return `linear-gradient(105deg, ${hexes.join(', ')})`
  }
  const stops = hexes.map((color, index) => {
    const start = (index / hexes.length) * 100
    const end = ((index + 1) / hexes.length) * 100
    return `${color} ${start.toFixed(2)}% ${end.toFixed(2)}%`
  })
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** Finish types the bay paints. Neon and solid stay a plain color. */
export function amsFinish(value: unknown): '' | 'translucent' | 'glow' {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === 'translucent' || raw === 'glow' ? raw : ''
}
