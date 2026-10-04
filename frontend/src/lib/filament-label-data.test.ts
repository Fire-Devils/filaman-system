import { describe, expect, it } from 'vitest'

import {
  buildCanonicalFilamentLabelData,
  buildFilamentLabelDataFromApi,
  buildFilamentLabelDataFromParams,
} from './filament-label-data'
import { buildSpoolDataFromFlatLabel } from './label-designer'
import { renderTemplateText } from './label-template'

describe('canonical filament label data', () => {
  it('formats standard ranges and collapses a single-value range', () => {
    const canonical = buildFilamentLabelDataFromApi({
      extruder_temp_range_c: { min: 200, max: 220 },
      bed_temp_range_c: { min: 60, max: 60 },
      custom_fields: {
        settings_extruder_temp: 999,
        settings_bed_temp: 999,
      },
    })

    expect(canonical.extruder_temp).toBe('200–220')
    expect(canonical.bed_temp).toBe('60')
  })

  it('keeps legacy temperature templates working with imported custom-field keys', () => {
    const canonical = buildFilamentLabelDataFromApi({
      id: 42,
      custom_fields: {
        settings_extruder_temp: 215,
        settings_bed_temp: 60,
      },
    })
    const designer = buildSpoolDataFromFlatLabel(canonical)

    expect(renderTemplateText('{filament.extruder_temp}', designer)).toBe('215')
    expect(renderTemplateText('{filament.bed_temp}', designer)).toBe('60')
  })

  it('keeps API values canonical and uses URL values only as fallbacks', () => {
    const query = buildFilamentLabelDataFromParams(
      '42',
      new URLSearchParams({
        designation: 'Stale query name',
        color: 'Query-only color',
      }),
    )

    const result = buildCanonicalFilamentLabelData(
      {
        id: 42,
        designation: 'Current API name',
      },
      query,
      '42',
    )

    expect(result.designation).toBe('Current API name')
    expect(result.color).toBe('Query-only color')
    expect(result.id).toBe('42')
  })
})
