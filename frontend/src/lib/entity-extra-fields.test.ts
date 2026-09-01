import { describe, expect, it } from 'vitest'
import {
  buildEntityExtraFieldsForPrint,
  buildSystemExtraFieldDefinitionMap,
  extraFieldPathOverlaps,
  flattenExtraFieldValues,
  getExtraFieldValue,
  mergeExtraFieldValues,
  normalizeEntityExtraFieldDefinitions,
  renderEntityExtraFieldRows,
  renderRecordExtraField,
  renderUnregisteredExtraFieldRows,
  resolveRecordExtraFieldDefinition,
  unflattenCollectedSystemFieldValues,
} from './entity-extra-fields'
import {
  buildDesignerExtraFieldsFromFilament,
  buildFilamentExtraFieldsForPrint,
} from './filament-label-data'
import { buildDesignerExtraFieldsFromApiSpool } from './spool-label-data'

const dryingTemperatureFilament = {
  custom_fields: { drying: { temperature: 55 } },
  custom_field_definitions: {
    'drying.temperature': {
      label: 'Drying temperature',
      field_type: 'number',
      config: { unit: '°C' },
    },
  },
}

describe('entity extra field helpers', () => {
  it('resolves dotted values from nested custom fields', () => {
    expect(getExtraFieldValue({ drying: { temperature: 55 } }, 'drying.temperature')).toBe(55)
  })

  it('normalizes record-local definitions for shared renderers', () => {
    const definitions = normalizeEntityExtraFieldDefinitions({
      'drying.temperature': {
        label: 'Drying temperature',
        field_type: 'number',
        config: { unit: '°C' },
      },
    })

    expect(definitions['drying.temperature']).toMatchObject({
      key: 'drying.temperature',
      label: 'Drying temperature',
      field_type: 'number',
    })
  })

  it('keeps record-local batch definitions out of the authoritative System map', () => {
    const definitions = [
      {
        id: 1,
        key: 'inspection',
        label: 'System inspection',
        field_type: 'checkbox',
      },
      {
        id: 0,
        key: 'tolerance',
        label: 'First record tolerance',
        field_type: 'number',
        config: { unit: '%' },
      },
    ]
    const systemKeys = new Set(['inspection'])

    expect(
      buildSystemExtraFieldDefinitionMap(
        definitions,
        definition => systemKeys.has(definition.key),
      ),
    ).toEqual({
      inspection: definitions[0],
    })
  })

  it('flattens nested values while keeping configured labels and types', () => {
    const values = flattenExtraFieldValues(
      { drying: { temperature: 55 }, humidity: { min: 10, max: 20 } },
      {
        'drying.temperature': {
          label: 'Drying temperature',
          field_type: 'number',
          config: { unit: '°C' },
        },
        humidity: {
          label: 'Storage humidity',
          field_type: 'range',
          config: { unit: '%' },
        },
      },
    )

    expect(values.map(field => [field.key, field.label])).toEqual([
      ['drying.temperature', 'Drying temperature'],
      ['humidity', 'Storage humidity'],
    ])
    expect(values[1].value).toEqual({ min: 10, max: 20 })
  })

  it('merges system and record-local values without losing nested siblings', () => {
    expect(
      mergeExtraFieldValues(
        { drying: { duration: 4 }, vendor: 'ACME' },
        { drying: { temperature: 55 } },
      ),
    ).toEqual({
      drying: { duration: 4, temperature: 55 },
      vendor: 'ACME',
    })
  })

  it('reconstructs dotted multiselect values as nested JSON', () => {
    expect(
      unflattenCollectedSystemFieldValues({
        flat: { note: 'Keep dry' },
        direct: { 'storage.tags': ['dry', 'sealed'] },
      }),
    ).toEqual({
      note: 'Keep dry',
      storage: { tags: ['dry', 'sealed'] },
    })
  })

  it('renders unknown nested siblings beside typed children', () => {
    const rows = renderUnregisteredExtraFieldRows(
      {
        drying: {
          temperature: 55,
          note: 'Keep sealed',
        },
      },
      {
        'drying.temperature': {
          label: 'Drying temperature',
          field_type: 'number',
        },
      },
    )

    expect(rows).toContain('drying.note')
    expect(rows).toContain('Keep sealed')
    expect(rows).not.toContain('drying.temperature')
  })

  it('merges reserved legacy properties without mutating object prototypes', () => {
    const objectPrototype = Object.prototype as Record<string, unknown>
    delete objectPrototype.polluted
    delete objectPrototype.infected
    const legacy = JSON.parse(
      '{"__proto__":{"polluted":"no"},"constructor":{"prototype":{"infected":"no"}}}',
    ) as Record<string, unknown>

    const result = mergeExtraFieldValues(legacy)

    expect(objectPrototype.polluted).toBeUndefined()
    expect(objectPrototype.infected).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual({
      polluted: 'no',
    })
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')?.value).toEqual({
      prototype: { infected: 'no' },
    })
  })

  it('does not resolve inherited or reserved path values', () => {
    expect(getExtraFieldValue({}, 'toString')).toBeUndefined()
    expect(getExtraFieldValue({}, '__proto__.polluted')).toBeUndefined()
  })

  it('detects exact and nested system-field path collisions', () => {
    const systemKeys = new Set(['drying.temperature'])

    expect(extraFieldPathOverlaps('drying.temperature', systemKeys)).toBe(true)
    expect(extraFieldPathOverlaps('drying', systemKeys)).toBe(true)
    expect(extraFieldPathOverlaps('drying.temperature.target', systemKeys)).toBe(true)
    expect(extraFieldPathOverlaps('storage.humidity', systemKeys)).toBe(false)
    expect(extraFieldPathOverlaps('drying_temperature', systemKeys)).toBe(false)
    expect(extraFieldPathOverlaps('spool.drying.temperature', systemKeys)).toBe(false)
    expect(extraFieldPathOverlaps('filament:drying.temperature', new Set(['spool:drying.temperature']))).toBe(false)
  })

  it('suppresses record-local detail rows owned by overlapping system fields', () => {
    const html = renderEntityExtraFieldRows(
      {
        drying: { temperature: 55 },
        storage: { humidity: 30 },
      },
      {
        'drying.temperature': {
          label: 'Local drying temperature',
          field_type: 'number',
        },
        'storage.humidity': {
          label: 'Storage humidity',
          field_type: 'number',
        },
      },
      new Set(['drying']),
    )

    expect(html).not.toContain('Local drying temperature')
    expect(html).toContain('Storage humidity')
  })

  it('preserves unknown siblings beside a dotted definition in print data', () => {
    const fields = buildEntityExtraFieldsForPrint(
      {
        drying: {
          temperature: 55,
          note: 'Keep sealed',
        },
      },
      {
        'drying.temperature': {
          label: 'Drying temperature',
          field_type: 'number',
          config: { unit: '°C' },
        },
      },
    )

    expect(fields).toEqual([
      {
        key: 'drying.temperature',
        label: 'Drying temperature',
        value: '55 °C',
        rawValue: 55,
        fieldType: 'number',
        origin: 'custom',
      },
      {
        key: 'drying.note',
        label: 'drying.note',
        value: 'Keep sealed',
        rawValue: 'Keep sealed',
        fieldType: undefined,
        origin: 'custom',
      },
    ])
  })

  it('gives nested System definitions precedence over overlapping local definitions', () => {
    const fields = buildEntityExtraFieldsForPrint(
      { drying: { min: 45, max: 60 } },
      {
        drying: {
          label: 'Local drying range',
          field_type: 'range',
          config: { unit: '°C' },
        },
      },
      {
        'drying.min': {
          id: 1,
          key: 'drying.min',
          label: 'System minimum',
          field_type: 'number',
          config: { unit: '°C' },
        },
      },
    )

    expect(fields.map(field => [field.key, field.label, field.value])).toEqual([
      ['drying.min', 'System minimum', '45 °C'],
      ['drying.max', 'drying.max', '60'],
    ])
    expect(fields.some(field => field.label === 'Local drying range')).toBe(false)
  })

  it('does not re-emit children owned by a parent System definition', () => {
    const fields = buildEntityExtraFieldsForPrint(
      { drying: { temperature: 55 } },
      {
        'drying.temperature': {
          label: 'Local drying temperature',
          field_type: 'number',
        },
      },
      {
        drying: {
          id: 3,
          key: 'drying',
          label: 'System drying group',
          field_type: 'text',
        },
      },
    )

    expect(fields.map(field => [field.key, field.label])).toEqual([
      ['drying', 'System drying group'],
    ])
  })

  it('can include empty record-local and System definitions for print selectors', () => {
    const fields = buildEntityExtraFieldsForPrint(
      {},
      {
        certified_at: {
          label: 'Certified at',
          field_type: 'datetime',
        },
      },
      {
        'storage.humidity': {
          id: 2,
          key: 'storage.humidity',
          label: 'System humidity',
          field_type: 'number',
          config: { unit: '%' },
        },
      },
      true,
    )

    expect(fields).toMatchObject([
      {
        key: 'certified_at',
        label: 'Certified at',
        rawValue: undefined,
        fieldType: 'datetime',
      },
      {
        key: 'storage.humidity',
        label: 'System humidity',
        rawValue: undefined,
        fieldType: 'number',
      },
    ])
  })

  it('identifies System and record-local fields for separate print catalogs', () => {
    const fields = buildEntityExtraFieldsForPrint(
      {
        certified_at: '2026-07-25',
        storage: { humidity: 45 },
      },
      {
        certified_at: {
          label: 'Certified at',
          field_type: 'date',
        },
      },
      {
        'storage.humidity': {
          id: 2,
          key: 'storage.humidity',
          label: 'System humidity',
          field_type: 'number',
        },
      },
    )

    expect(fields.map(field => [field.key, field.origin])).toEqual([
      ['certified_at', 'custom'],
      ['storage.humidity', 'system'],
    ])
  })

  it('resolves batch-print metadata from the current record', () => {
    const batchDefinition = {
      key: 'certification',
      label: 'Another record label',
      field_type: 'number',
      config: { unit: '%' },
    }
    const currentDefinitions = normalizeEntityExtraFieldDefinitions({
      certification: {
        label: 'Current record label',
        field_type: 'number',
        config: { unit: 'mm' },
      },
    })

    expect(
      resolveRecordExtraFieldDefinition(
        'certification',
        batchDefinition,
        currentDefinitions,
        false,
      ),
    ).toMatchObject({
      label: 'Current record label',
      field_type: 'number',
      config: { unit: 'mm' },
    })
    expect(
      resolveRecordExtraFieldDefinition('certification', batchDefinition, {}, false),
    ).toMatchObject({
      key: 'certification',
      label: 'certification',
      field_type: 'text',
    })
    expect(
      resolveRecordExtraFieldDefinition(
        'certification',
        batchDefinition,
        currentDefinitions,
        true,
      ),
    ).toBe(batchDefinition)
  })

  it('renders mixed-record batches with each record’s own label, type, and unit', () => {
    const batchDefinition = {
      key: 'inspection',
      label: 'First record inspection',
      field_type: 'number',
      config: { unit: '%' },
    }
    const secondRecordDefinitions = normalizeEntityExtraFieldDefinitions({
      inspection: {
        label: 'Second record tolerance',
        field_type: 'number',
        config: { unit: 'mm', decimal_places: 2 },
      },
    })

    expect(
      renderRecordExtraField(
        'inspection',
        12.345,
        batchDefinition,
        secondRecordDefinitions,
        false,
      ),
    ).toEqual({
      label: 'Second record tolerance',
      value: '12.35 mm',
    })
    expect(renderRecordExtraField('inspection', 12.345, batchDefinition, {}, false)).toEqual({
      label: 'inspection',
      value: '12.345',
    })
  })

  it('renders a system-owned collision with system metadata for every record', () => {
    const systemDefinition = {
      key: 'inspection',
      label: 'System inspection',
      field_type: 'number',
      config: { unit: '%' },
    }
    const recordDefinitions = normalizeEntityExtraFieldDefinitions({
      inspection: {
        label: 'Local inspection',
        field_type: 'number',
        config: { unit: 'mm' },
      },
    })

    expect(
      renderRecordExtraField(
        'inspection',
        20,
        systemDefinition,
        recordDefinitions,
        true,
      ),
    ).toEqual({
      label: 'System inspection',
      value: '20 %',
    })
  })
})

describe('record-local fields in label designer', () => {
  it('exposes legacy-named temperatures in the correct Extra Fields catalog', () => {
    const fields = buildDesignerExtraFieldsFromFilament(
      {
        custom_fields: { extruder_temp: 215, bed_temp: 60 },
        custom_field_definitions: {
          bed_temp: { label: 'Bed temperature', field_type: 'number' },
        },
      },
      {
        extruder_temp: {
          key: 'extruder_temp',
          label: 'Extruder temperature',
          field_type: 'number',
        },
      },
    )

    expect(fields.map(field => [field.key, field.origin]).sort()).toEqual([
      ['filament.bed_temp', 'custom'],
      ['filament.extruder_temp', 'system'],
    ])
  })

  it('uses a dotted filament field label and unit', () => {
    const fields = buildDesignerExtraFieldsFromFilament(dryingTemperatureFilament)

    expect(fields).toEqual([
      {
        key: 'filament.drying.temperature',
        label: 'Drying temperature',
        value: '55 °C',
        rawValue: 55,
        fieldType: 'number',
        source: 'filament',
        origin: 'custom',
      },
    ])
  })

  it('preserves System ownership in designer fields', () => {
    const fields = buildDesignerExtraFieldsFromFilament(
      {
        custom_fields: { drying_temperature: 55 },
      },
      {
        drying_temperature: {
          id: 4,
          key: 'drying_temperature',
          label: 'Drying temperature',
          field_type: 'number',
        },
      },
    )

    expect(fields).toMatchObject([
      {
        key: 'filament.drying_temperature',
        source: 'filament',
        origin: 'system',
      },
    ])
  })

  it('uses record-local labels for both spool and filament fields', () => {
    const fields = buildDesignerExtraFieldsFromApiSpool({
      custom_fields: { storage: { humidity: 30 } },
      custom_field_definitions: {
        'storage.humidity': {
          label: 'Spool humidity',
          field_type: 'number',
          config: { unit: '%' },
        },
      },
      filament: dryingTemperatureFilament,
    })

    expect(fields.map(field => [field.key, field.label, field.value])).toEqual([
      ['spool.storage.humidity', 'Spool humidity', '30 %'],
      ['filament.drying.temperature', 'Drying temperature', '55 °C'],
    ])
  })

  it('exposes datetime type and raw value for date-only label tokens', () => {
    const raw = '2026-07-25T14:30:45.123Z'
    const fields = buildDesignerExtraFieldsFromFilament({
      custom_fields: { certified_at: raw },
      custom_field_definitions: {
        certified_at: {
          label: 'Certified at',
          field_type: 'datetime',
        },
      },
    })

    expect(fields[0]).toMatchObject({
      key: 'filament.certified_at',
      fieldType: 'datetime',
      rawValue: raw,
    })
  })

  it('keeps record-local metadata in the single-filament Standard Label payload', () => {
    const fields = buildFilamentExtraFieldsForPrint(
      {
        custom_fields: {
          certified_at: '2026-07-25T14:30:45.123Z',
        },
        custom_field_definitions: {
          certified_at: {
            label: 'Certified date',
            field_type: 'datetime',
          },
        },
      },
      {},
    )

    expect(fields.find(field => field.key === 'filament.certified_at')).toMatchObject({
      key: 'filament.certified_at',
      label: 'Certified date',
      rawValue: '2026-07-25T14:30:45.123Z',
      fieldType: 'datetime',
      source: 'filament',
    })
  })

  it('keeps configured unset System fields in the single-filament print handoff', () => {
    const fields = buildFilamentExtraFieldsForPrint(
      { custom_fields: {} },
      {
        drying_temperature: {
          id: 7,
          key: 'drying_temperature',
          label: 'Drying temperature',
          field_type: 'number',
        },
      },
    )

    expect(fields).toMatchObject([
      {
        key: 'filament.drying_temperature',
        label: 'Drying temperature',
        value: '',
        source: 'filament',
        origin: 'system',
      },
    ])
  })
})
