import { describe, expect, it } from 'vitest'

import { filterPrinterModels, printerModelLabel, suggestPrinterModels, type PrinterModelItem } from './printer-model-picker'

const items: PrinterModelItem[] = [
  { id: 1, manufacturer: 'Bambu Lab', model: 'X1 Carbon' },
  { id: 2, manufacturer: 'Bambu Lab', model: 'P1S' },
  { id: 3, manufacturer: 'Prusa', model: 'MK4' },
]

describe('printer model picker', () => {
  it('builds a label from manufacturer and model', () => {
    expect(printerModelLabel(items[0])).toBe('Bambu Lab X1 Carbon')
    expect(printerModelLabel({ manufacturer: null, model: 'MK4' })).toBe('MK4')
  })

  it('filters by all search words regardless of case', () => {
    expect(filterPrinterModels(items, 'bambu p1').map(i => i.id)).toEqual([2])
    expect(filterPrinterModels(items, '').length).toBe(3)
    expect(filterPrinterModels(items, 'zzz')).toEqual([])
  })

  it('suggests close matches for free text, best first', () => {
    const result = suggestPrinterModels(items, 'Bambulab', 'X1 Carbon')
    expect(result[0]?.id).toBe(1)
    expect(suggestPrinterModels(items, 'Prusa', 'mk4').map(i => i.id)).toEqual([3])
  })

  it('suggests nothing for empty or unrelated input', () => {
    expect(suggestPrinterModels(items, '', '')).toEqual([])
    expect(suggestPrinterModels(items, 'Voron', 'Trident')).toEqual([])
  })
})
