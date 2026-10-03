import { describe, expect, it } from 'vitest'

import { buildSpoolDetailSections, buildSpoolUpdatePayload, formatSpoolDate } from './spool-detail'

describe('spool detail', () => {
  it('keeps operational values read-only while exposing standard spool fields', () => {
    const sections = buildSpoolDetailSections({
      status: 'Opened',
      remaining: '742 g',
      location: 'Workshop',
      initial_total_weight_g: 1250,
      empty_spool_weight_g: 250,
      low_weight_threshold_g: 100,
    })

    const rows = sections.flatMap((section) => section.rows)
    expect(rows.find((row) => row.key === 'status')?.field).toBeUndefined()
    expect(rows.find((row) => row.key === 'remaining')?.field).toBeUndefined()
    expect(rows.find((row) => row.key === 'location')?.field).toBeUndefined()
    expect(rows.find((row) => row.key === 'empty_spool_weight_g')?.field).toMatchObject({ type: 'number' })
    expect(rows.find((row) => row.key === 'empty_spool_weight_g')?.field?.unit).toBe('g')
    expect(rows.find((row) => row.key === 'spool_width_mm')?.field?.unit).toBe('mm')
    expect(rows.find((row) => row.key === 'lot_number')?.value).toBe('—')
  })

  it('builds a patch containing only inline-editable fields', () => {
    const values = new FormData()
    values.set('initial_total_weight_g', '1250')
    values.set('empty_spool_weight_g', '250')
    values.set('spool_core_weight_g', '42')
    values.set('spool_material', 'Cardboard')
    values.set('spool_outer_diameter_mm', '200.5')
    values.set('spool_width_mm', '')
    values.set('low_weight_threshold_g', '100')
    values.set('lot_number', ' LOT-1 ')
    values.set('external_id', '')
    values.set('purchase_price', '24.95')
    values.set('purchase_date', '2026-09-28')
    values.set('status_id', '4')
    values.set('location_id', '2')
    values.set('remaining_weight_g', '1')
    values.set('rfid_uid', 'unsafe')

    expect(buildSpoolUpdatePayload(values, true)).toEqual({
      initial_total_weight_g: 1250,
      empty_spool_weight_g: 250,
      spool_core_weight_g: 42,
      spool_material: 'Cardboard',
      spool_outer_diameter_mm: 200.5,
      spool_width_mm: null,
      low_weight_threshold_g: 100,
      lot_number: 'LOT-1',
      external_id: null,
      purchase_price: 24.95,
      purchase_date: '2026-09-28',
    })
  })

  it('stores zero when the spool core is explicitly disabled', () => {
    expect(buildSpoolUpdatePayload(new FormData(), false).spool_core_weight_g).toBe(0)
  })

  it('keeps every core/adapter state visible on the detail page', () => {
    const coreValue = (spoolCoreWeight: number | null) => buildSpoolDetailSections({
      spool_core_weight_g: spoolCoreWeight,
    }).flatMap((section) => section.rows).find((row) => row.key === 'spool_core_weight_g')?.value

    expect(coreValue(0)).toBe('Off')
    expect(coreValue(null)).toBe('Global default')
    expect(coreValue(42)).toBe('42 g')
  })

  it('keeps a date-only purchase date stable across timezones', () => {
    expect(formatSpoolDate('2026-09-28T00:00:00Z')).toBe('2026-09-28')
    expect(formatSpoolDate(null)).toBeNull()
  })
})
