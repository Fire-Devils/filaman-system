import { describe, expect, it } from 'vitest'
import { buildFilamentDetailSections, renderAbrasiveBadge } from './filament-detail'

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

describe('abrasive detail row', () => {
  const translate = (key: string) => ({ 'filaments.abrasiveAuto': 'Automatisch', 'filaments.abrasiveNo': 'Nein', 'common.yes': 'Ja', 'common.no': 'Nein' } as Record<string, string>)[key] ?? key
  const rowValue = (filament: Record<string, unknown>) =>
    buildFilamentDetailSections(filament as never, { translate } as never)
      .flatMap((section) => section.rows)
      .find((row) => row.labelKey === 'filaments.abrasive')?.value

  it('shows the auto-detected result when no override is set', () => {
    expect(rowValue({ is_abrasive: null, abrasive: true })).toBe('Automatisch (Ja)')
    expect(rowValue({ is_abrasive: null, abrasive: false })).toBe('Automatisch (Nein)')
  })

  it('shows the explicit override as is', () => {
    expect(rowValue({ is_abrasive: false, abrasive: false })).toBe('Nein')
  })
})
