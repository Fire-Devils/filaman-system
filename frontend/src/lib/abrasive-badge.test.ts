import { describe, expect, it } from 'vitest'
import { renderAbrasiveBadge } from './filament-detail'

const t = (key: string) => key

describe('renderAbrasiveBadge', () => {
  it('renders nothing for non-abrasive filaments', () => {
    expect(renderAbrasiveBadge({ abrasive: false }, t)).toBe('')
    expect(renderAbrasiveBadge({}, t)).toBe('')
  })

  it('renders the badge with the minimum nozzle', () => {
    const html = renderAbrasiveBadge({ abrasive: true, min_nozzle_mm: 0.4 }, t)
    expect(html).toContain('filaments.abrasiveBadge')
    expect(html).toContain('filaments.minNozzle')
    expect(html).toContain('0.4 mm')
  })

  it('can omit the minimum nozzle', () => {
    const html = renderAbrasiveBadge({ abrasive: true, min_nozzle_mm: 0.6 }, t, false)
    expect(html).toContain('filaments.abrasiveBadge')
    expect(html).not.toContain('0.6')
  })
})
