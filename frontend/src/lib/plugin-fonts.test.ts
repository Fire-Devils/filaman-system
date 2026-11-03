import { expect, it } from 'vitest'
import { GET } from '../pages/plugin-fonts.css'

it('serves local core font faces for standalone plugins without an external font service', async () => {
  const response = GET()
  const css = await response.text()
  expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
  expect(css.match(/@font-face/g)).toHaveLength(4)
  for (const weight of [400, 500, 600, 700]) expect(css).toContain(`font-weight:${weight};`)
  expect(css).toContain('font-family:"Space Grotesk"')
  expect(css).toContain('font-display:swap')
  expect(css).not.toMatch(/https?:/)
})
