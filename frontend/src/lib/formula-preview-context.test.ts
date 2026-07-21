import { describe, expect, it } from 'vitest'
import { scaffoldFormulaPreviewContext } from './formula-preview-context'

describe('scaffoldFormulaPreviewContext', () => {
  const placeholders = {
    remaining_weight_g: 225,
    'filament.designation': 'PLA Basic',
    'filament.manufacturer.name': 'Example Materials',
    'filament.custom_fields.temp_band.min': 195,
  }

  it('creates the nested object shape used by JSON Logic var paths', () => {
    const context: Record<string, unknown> = {}

    expect(scaffoldFormulaPreviewContext(context, [
      'remaining_weight_g',
      'filament.designation',
      'filament.manufacturer.name',
      'filament.custom_fields.temp_band.min',
    ], placeholders)).toBe(true)
    expect(context).toEqual({
      remaining_weight_g: 225,
      filament: {
        designation: 'PLA Basic',
        manufacturer: { name: 'Example Materials' },
        custom_fields: { temp_band: { min: 195 } },
      },
    })
  })

  it('preserves user-supplied nested values', () => {
    const context = { filament: { designation: 'User PLA' } }

    expect(scaffoldFormulaPreviewContext(
      context,
      ['filament.designation'],
      placeholders,
    )).toBe(false)
    expect(context.filament.designation).toBe('User PLA')
  })

  it('migrates obsolete flat dotted keys to nested values', () => {
    const context: Record<string, unknown> = { 'filament.designation': 'Legacy PLA' }

    expect(scaffoldFormulaPreviewContext(
      context,
      ['filament.designation'],
      {},
    )).toBe(true)
    expect(context).toEqual({ filament: { designation: 'Legacy PLA' } })
  })

  it('does not assign prototype-polluting paths', () => {
    const context: Record<string, unknown> = {}

    expect(scaffoldFormulaPreviewContext(
      context,
      ['__proto__.polluted', 'filament.constructor.polluted'],
      {},
    )).toBe(false)
    expect(context).toEqual({})
  })
})
