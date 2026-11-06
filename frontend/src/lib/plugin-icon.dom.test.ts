// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { createPluginIcon } from './plugin-icon'

it('keeps the fallback until the icon loads, then uses an alpha mask that inherits the theme color', () => {
  const icon = createPluginIcon('/api/v1/plugin-icons/bambulab?v=1.0.0')
  const image = icon.querySelector('img')!
  const fallback = icon.querySelector('svg')!
  expect(image.src).toContain('/api/v1/plugin-icons/bambulab?v=1.0.0')
  expect(image.alt).toBe('')
  expect(icon.getAttribute('aria-hidden')).toBe('true')
  expect(image.hidden).toBe(true)
  image.dispatchEvent(new Event('load'))
  expect(icon.querySelector('img')).toBeNull()
  expect(icon.contains(fallback)).toBe(false)
  const mask = icon.querySelector<HTMLElement>('.fm-plugin-icon-mask')!
  expect(mask.style.maskImage).toContain('/api/v1/plugin-icons/bambulab?v=1.0.0')
  expect(mask.tagName).toBe('I')
})

it('keeps a puzzle icon on failed loads', () => {
  const icon = createPluginIcon('/api/v1/plugin-icons/example')
  icon.querySelector('img')!.dispatchEvent(new Event('error'))
  expect(icon.querySelector('img')).toBeNull()
  expect(icon.querySelector('use')!.getAttribute('href')).toContain('#icon-plugin')
})

it.each([undefined, null, '', 'https://example.com/a.svg', '//example.com/a.svg', '/api/v1/plugin-icons/../../auth/logout'])('uses the fallback for absent or unexpected icon URLs: %s', url => {
  const icon = createPluginIcon(url)
  expect(icon.querySelector('img')).toBeNull()
  expect(icon.querySelector('svg')).not.toBeNull()
})
