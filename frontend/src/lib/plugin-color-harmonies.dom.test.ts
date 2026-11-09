// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import { mountColorHarmonyWheel } from './plugin-color-harmonies'

it('uses the supplied stop and ranks each candidate once in its nearest range', () => {
  const container = document.createElement('div')
  const onChange = vi.fn()
  const wheel = mountColorHarmonyWheel(container, {
    referenceHex: '#f00',
    candidates: [
      { id: 1, hexes: ['#F30', '#0FF'] },
      { id: 2, hexes: ['#00EEFF'] },
      { id: 3, hexes: ['#FF8000'] },
      { id: 4, hexes: ['#80FF00'] },
      { id: 5, hexes: ['#FF0080'] },
      { id: 6, hexes: ['#FF0'] },
    ],
    modes: ['complementary', 'triadic', 'analogous', 'split-complementary'],
    locale: 'de-DE',
    onChange,
  })
  expect(container.querySelector('select')?.getAttribute('aria-label')).toBe('Farbharmonie')
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    mode: 'complementary', referenceHex: '#FF0000',
    groups: [
      { offset: 0, targetHue: 0, matches: [] },
      { offset: 180, targetHue: 180, matches: [{ id: 1, hex: '#00FFFF', distance: 0 }, { id: 2 }] },
    ],
  })
  expect(container.querySelectorAll('[data-color-window]:not([hidden])')).toHaveLength(2)
  expect(container.querySelectorAll('circle.is-matching')).toHaveLength(3)
  expect(container.querySelector('[data-color-marker="#FF3300"]')?.classList.contains('is-matching')).toBe(true)
  expect(container.querySelector('circle.is-reference')?.getAttribute('fill')).toBe('#FF0000')

  const select = container.querySelector('select')!
  const cyan = container.querySelector('[data-color-marker="#00FFFF"]')
  select.value = 'analogous'
  select.dispatchEvent(new Event('change'))
  expect(onChange.mock.lastCall?.[0].groups.map((g: { offset: number }) => g.offset)).toEqual([0, 30, 330])
  expect(onChange.mock.lastCall?.[0].groups[2].matches).toMatchObject([{ id: 5 }])
  expect(container.querySelectorAll('[data-color-guide]:not([hidden])')).toHaveLength(3)
  expect(container.querySelector('[data-color-marker="#00FFFF"]')).toBe(cyan)
  expect(cyan?.parentElement?.parentElement?.dataset.colorMarkerLayer).toBe('excluded')

  wheel.update({ mode: 'split-complementary', referenceHex: '#8000FF' })
  expect(onChange.mock.lastCall?.[0].groups.map((g: { targetHue: number }) => Math.round(g.targetHue))).toEqual([270, 60, 120])
  wheel.update({ mode: 'triadic', referenceHex: '#808080' })
  expect(onChange.mock.lastCall?.[0].groups).toEqual([])
  expect(container.querySelectorAll('[data-color-window]:not([hidden])')).toHaveLength(0)
  wheel.destroy()
  expect(container.children).toHaveLength(0)
})

it('ranks against the exact RGB of a neutral reference and keeps the chosen mode on update', () => {
  const container = document.createElement('div')
  const onChange = vi.fn()
  const candidates = ['#000', '#777', '#85858588', '#fff', '#999', '#aaa', '#bbb', 'invalid']
    .map((hex, id) => ({ id, hexes: [hex] }))
  const wheel = mountColorHarmonyWheel(container, {
    referenceHex: '#808080', candidates, modes: ['complementary', 'similar'], mode: 'similar', onChange,
  })
  const result = onChange.mock.lastCall?.[0]
  expect(result.groups[0].offset).toBeNull()
  expect(result.groups[0].matches.map((m: { id: number }) => m.id)).toEqual([2, 1, 4, 5, 6])
  expect(container.querySelector('.fm-header-color-wheel')?.classList.contains('is-neutral')).toBe(true)
  expect(container.querySelector('[data-color-marker="#85858588"]')?.previousElementSibling?.classList.contains('fm-header-color-marker-backing')).toBe(true)
  wheel.update({ referenceHex: '#F00' })
  expect(onChange.mock.lastCall?.[0].mode).toBe('similar')
  wheel.update({ referenceHex: 'invalid' })
  expect(onChange.mock.lastCall?.[0]).toMatchObject({ referenceHex: null, groups: [] })
})

it('keeps SVG pattern IDs separate across mounts and defaults to native harmony modes', () => {
  const first = document.createElement('div')
  const second = document.createElement('div')
  const options = { referenceHex: '#123', candidates: [] }
  mountColorHarmonyWheel(first, options)
  mountColorHarmonyWheel(second, options)
  expect(first.querySelector('pattern')?.id).not.toBe(second.querySelector('pattern')?.id)
  expect(Array.from(first.querySelectorAll('option'), option => option.value)).toEqual(['complementary', 'triadic'])
})

it('uses a reference ring when a matching color dot shares its position', () => {
  const container = document.createElement('div')
  mountColorHarmonyWheel(container, {
    referenceHex: '#FF0000', candidates: [{ id: 1, hexes: ['#800000'] }],
  })
  const reference = container.querySelector('circle.is-reference')!
  const dot = container.querySelector('[data-color-marker="#800000"]')!
  expect(reference.getAttribute('cx')).toBe(dot.getAttribute('cx'))
  expect(reference.classList.contains('is-reference-ring')).toBe(true)
  expect(dot.classList.contains('is-matching')).toBe(true)
})
