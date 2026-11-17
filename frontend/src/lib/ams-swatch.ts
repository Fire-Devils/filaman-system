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

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Hyphen and space separated words, so PA6-CF splits into pa6 and cf. */
function tokens(value: unknown): string[] {
  return norm(value).split(/[^a-z0-9]+/).filter(Boolean)
}

/** Galaxy, sparkle, and glitter share the speck overlay. Glitter is denser. */
export function amsSparkleKind(value: unknown): '' | 'galaxy' | 'sparkle' | 'glitter' {
  const raw = norm(value)
  if (raw === 'glitter') return 'glitter'
  if (raw === 'sparkle') return 'sparkle'
  if (raw === 'galaxy') return 'galaxy'
  return ''
}

/** Carbon- or glass-filled. Subgroup cf/gf, or a material type such as PA6-CF. */
export function amsFiber(subgroup: unknown, material: unknown): '' | 'cf' | 'gf' {
  const all = [...tokens(subgroup), ...tokens(material)]
  if (all.includes('cf')) return 'cf'
  if (all.includes('gf')) return 'gf'
  return ''
}

/** Finish types the bay paints. Neon and solid stay a plain color. */
export function amsFinish(value: unknown): '' | 'translucent' | 'glow' {
  const raw = norm(value)
  return raw === 'translucent' || raw === 'glow' ? raw : ''
}

/** Finish type wins. Glow and translucent subgroups paint the same overlays. */
export function amsSwatchFinish(finish: unknown, subgroup: unknown): '' | 'translucent' | 'glow' {
  const painted = amsFinish(finish)
  if (painted) return painted
  const raw = norm(subgroup)
  if (raw === 'glow') return 'glow'
  if (raw === 'translucent') return 'translucent'
  return ''
}
