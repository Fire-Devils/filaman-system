import { filters as en } from '../i18n/en.json'
import { filters as de } from '../i18n/de.json'
import { filters as fr } from '../i18n/fr.json'
import {
  COLOR_HARMONY_OFFSETS, colorWheelHueMask, colorWheelPoint, createColorWheel,
  hueDistance, parseColorSample, syncColorWheelMarkers, type ColorWheelPoint,
} from './color-wheel'

const LABEL_KEYS = {
  complementary: 'complementary',
  triadic: 'triadic',
  analogous: 'analogous',
  'split-complementary': 'splitComplementary',
  similar: 'similar',
} as const

export type ColorHarmonyMode = keyof typeof LABEL_KEYS
export type ColorHarmonyCandidate = { id: string | number; hexes: readonly string[] }
export type ColorHarmonyMatch = { id: ColorHarmonyCandidate['id']; hex: string; distance: number }
export type ColorHarmonyGroup = { offset: number | null; targetHue: number | null; matches: ColorHarmonyMatch[] }
export type ColorHarmonyResult = { mode: ColorHarmonyMode; referenceHex: string | null; groups: ColorHarmonyGroup[] }
export type ColorHarmonyOptions = {
  referenceHex: string
  candidates: readonly ColorHarmonyCandidate[]
  modes?: readonly ColorHarmonyMode[]
  mode?: ColorHarmonyMode
  locale?: string
  onChange?: (result: ColorHarmonyResult) => void
}

const DEFAULT_MODES = ['complementary', 'triadic'] as const
const HUE_SPAN = 35
let nextWheelId = 0

function rgbDistance(a: string, b: string): number {
  return Math.hypot(...[1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)))
}

function matchColors(
  mode: ColorHarmonyMode,
  reference: ColorWheelPoint | null,
  candidates: ReadonlyMap<ColorHarmonyCandidate['id'], readonly ColorWheelPoint[]>,
  matched: Map<string, number>,
): ColorHarmonyGroup[] {
  if (!reference) return []
  const similar = mode === 'similar'
  const groups: ColorHarmonyGroup[] = similar
    ? [{ offset: null, targetHue: null, matches: [] }]
    : reference.saturation === 0 ? [] : COLOR_HARMONY_OFFSETS[mode].map(offset => ({
      offset, targetHue: (reference.hue + offset) % 360, matches: [],
    }))
  if (!groups.length) return groups

  const colorMatches = new Map<string, { group: number; distance: number } | null>()
  for (const [id, colors] of candidates) {
    let best: ColorHarmonyMatch | undefined
    let bestGroup = 0
    for (const color of colors) {
      let match = colorMatches.get(color.hex)
      if (match === undefined) {
        match = similar ? { group: 0, distance: rgbDistance(reference.hex, color.hex) } : null
        if (!similar && color.saturation > 0) {
          for (const [group, { targetHue }] of groups.entries()) {
            const distance = hueDistance(targetHue!, color.hue)
            if (distance <= HUE_SPAN / 2 && (!match || distance < match.distance)) match = { group, distance }
          }
        }
        colorMatches.set(color.hex, match)
        if (match && !similar) matched.set(color.hex, match.group)
      }
      if (match && (!best || match.distance < best.distance
        || (match.distance === best.distance && match.group < bestGroup))) {
        best = { id, hex: color.hex, distance: match.distance }
        bestGroup = match.group
      }
    }
    if (best) groups[bestGroup].matches.push(best)
  }
  for (const group of groups) {
    group.matches.sort((a, b) => a.distance - b.distance)
    if (similar) {
      group.matches.splice(5)
      group.matches.forEach(match => matched.set(match.hex, 0))
    }
  }
  return groups
}

export function mountColorHarmonyWheel(container: HTMLElement, initial: ColorHarmonyOptions) {
  const root = document.createElement('div')
  root.className = 'fm-plugin-color-harmonies'
  const select = document.createElement('select')
  const { wheel, wheelWrap, markers } = createColorWheel(`fm-plugin-color-wheel-${++nextWheelId}`, 3)
  wheel.classList.add('is-muted')
  wheelWrap.setAttribute('role', 'img')
  const windows = wheel.querySelectorAll<HTMLElement>('[data-color-window]')
  const guides = Array.from(windows, (_, index) => {
    const guide = document.createElement('span')
    guide.className = 'fm-header-color-guide'
    guide.dataset.colorGuide = String(index)
    guide.setAttribute('aria-hidden', 'true')
    wheelWrap.append(guide)
    return guide
  })
  root.append(select, wheelWrap)
  container.append(root)

  let options = initial
  let mode = initial.mode
  let samples = new Map<string, ColorWheelPoint>()
  let candidateSamples = new Map<ColorHarmonyCandidate['id'], ColorWheelPoint[]>()
  let reference: ColorWheelPoint | null = null

  function loadColors() {
    samples = new Map()
    candidateSamples = new Map()
    function add(raw: string) {
      const sample = parseColorSample(raw)
      if (!sample) return null
      let point = samples.get(sample.hex)
      if (!point) {
        point = colorWheelPoint(sample)
        samples.set(sample.hex, point)
      }
      return point
    }
    for (const { id, hexes } of options.candidates) {
      const colors = candidateSamples.get(id) || []
      for (const hex of hexes) {
        const point = add(hex)
        if (point) colors.push(point)
      }
      candidateSamples.set(id, colors)
    }
    reference = add(options.referenceHex)
  }

  function render() {
    const modes = Array.from(new Set(options.modes?.filter(value => Object.hasOwn(LABEL_KEYS, value))))
    if (!modes.length) modes.push(...DEFAULT_MODES)
    const locale = (options.locale || document.documentElement.lang).toLowerCase().split('-')[0]
    const labels = locale === 'de' ? de : locale === 'fr' ? fr : en
    const current = mode && modes.includes(mode) ? mode : modes[0]
    mode = current
    select.setAttribute('aria-label', labels.colorHarmony)
    select.replaceChildren(...modes.map(value => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = labels[LABEL_KEYS[value]]
      return option
    }))
    select.value = current
    wheelWrap.setAttribute('aria-label', reference ? `${labels.referenceColor}: ${reference.hex}` : labels.colorHarmony)

    const matched = new Map<string, number>()
    const groups = matchColors(current, reference, candidateSamples, matched)
    const offsets = groups.flatMap(group => group.offset === null ? [] : [group.offset])
    const endHue = (reference?.hue ?? 0) + HUE_SPAN / 2
    const neutral = reference?.saturation === 0
    wheel.classList.toggle('is-neutral', neutral)
    wheel.style.setProperty('--color-hue-mask', colorWheelHueMask(endHue, offsets.length ? HUE_SPAN : 360, offsets))
    windows.forEach((window, index) => {
      const offset = offsets[index]
      window.hidden = guides[index].hidden = offset === undefined
      if (offset === undefined) return
      window.style.setProperty('--color-hue-from', `${90 - endHue - offset}deg`)
      guides[index].style.setProperty('--color-guide-angle', `${-groups[index].targetHue!}deg`)
      if (index > 0) {
        window.dataset.colorHarmonyTone = current
        guides[index].dataset.colorHarmonyTone = current
      }
    })

    const point = reference
    const referenceRing = !!point && [...matched.keys()].some(hex => {
      if (hex === point.hex) return false
      const sample = samples.get(hex)!
      return neutral ? sample.value === point.value : sample.x === point.x && sample.y === point.y
    })
    syncColorWheelMarkers(markers, samples, hex => matched.get(hex), {
      active: groups.length > 0, neutral, tone: current, referenceHex: reference?.hex, referenceRing,
    })
    options.onChange?.({ mode: current, referenceHex: reference?.hex ?? null, groups })
  }

  select.addEventListener('change', () => {
    mode = select.value as ColorHarmonyMode
    render()
  })
  loadColors()
  render()
  return {
    update({ referenceHex = options.referenceHex, candidates = options.candidates, ...next }: Partial<ColorHarmonyOptions>) {
      const colorsChanged = referenceHex !== options.referenceHex || candidates !== options.candidates
      options = { ...options, ...next, referenceHex, candidates }
      if (next.mode !== undefined) mode = next.mode
      if (colorsChanged) loadColors()
      render()
    },
    destroy() { root.remove() },
  }
}
