// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { buildDesignerExtraFieldsFromFilament, buildFilamentExtraFieldsForPrint } from './filament-label-data'
import { buildDesignerExtraFieldsFromApiSpool } from './spool-label-data'
import { buildLabelExtraFields, buildLabelExtraFieldCatalogGroups, standardLabelExtraFields } from './label-extra-fields'
import { buildFilamentDataFromApiFilament, buildSpoolDataFromApiSpool } from './label-designer-data'
import { appendLabelSettingsCheckbox } from './label-print-page'
import { consumeScopedLabelFields, writeScopedLabelFields } from './label-print-session'
import { renderTemplateText } from './label-template'
import { API_DEFAULT_LABEL_SETTINGS, buildStandardLabelDataFromFlat, renderStandardLabel } from './label-standard'

const definition = { label: 'Extruder temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } }
function retainedRecord(nested: boolean) {
  const key = nested ? 'spoolman_extra.settings_extruder_temp' : 'settings_extruder_temp'
  return { key, record: {
    custom_fields: nested ? { spoolman_extra: { settings_extruder_temp: 210 } } : { settings_extruder_temp: 210 },
    custom_field_definitions: null,
    label_field_aliases: { [key]: { target: 'extruder_temp_range_c.min', definition,
      wire: { target: 'extruder_temp_range_c', value: 210, native: { min: 210, max: 210 },
        source: nested ? ['spoolman_extra', 'settings_extruder_temp'] : ['settings_extruder_temp'], retained: true, definition } } },
  } }
}

it.each([['filament', false], ['spool', false], ['filament', true], ['spool', true]] as const)(
  'projects migration-retained %s tokens after native edits and clears (nested=%s)', (kind, nested) => {
    const { key, record } = retainedRecord(nested)
    const native = { id: 8, extruder_temp_range_c: { min: 225, max: 230 } as { min: number; max: number } | null }
    const filament = { ...native, ...(kind === 'filament' ? record : {}) }
    const spool = { id: 42, filament, ...(kind === 'spool' ? record : {}) }
    const render = () => renderTemplateText(`{extra.${kind}.${key}}`, kind === 'filament'
      ? buildFilamentDataFromApiFilament(filament) : buildSpoolDataFromApiSpool(spool))
    const fields = () => kind === 'filament' ? buildDesignerExtraFieldsFromFilament(filament) : buildDesignerExtraFieldsFromApiSpool(spool)
    expect(render()).toBe('225.0 °C')
    expect(fields().filter(field => field.key === `${kind}.${key}`)).toHaveLength(1)
    expect(buildLabelExtraFieldCatalogGroups(fields(), { entityType: kind, batchMode: false }).flatMap(group => group.fields)).toEqual([])
    filament.extruder_temp_range_c = null
    expect(render()).toBe('')
    expect(record.custom_fields).toEqual(retainedRecord(nested).record.custom_fields)
  },
)

it.each(['filament', 'spool'] as const)('preserves independent effective definitions and raw values for %s retained sources', kind => {
  const { key, record } = retainedRecord(false)
  const filament = { id: 8, extruder_temp_range_c: { min: 225, max: 230 }, ...(kind === 'filament' ? record : {}) }
  const spool = { id: 42, filament, ...(kind === 'spool' ? record : {}) }
  const fields = (defs = {}) => kind === 'filament'
    ? buildDesignerExtraFieldsFromFilament(filament, defs)
    : buildDesignerExtraFieldsFromApiSpool(spool, { spool: defs })
  expect(fields({ [key]: { ...definition, key, id: 99, config: { decimal_places: 1, unit: '°C' } } })[0].value).toBe('225.0 °C')
  expect(fields({ [key]: { ...definition, key, id: 99, config: { unit: '°F', decimal_places: 0 } } })[0].value).toBe('210 °F')
  const entity = kind === 'filament' ? filament : spool
  Object.assign(entity, { custom_field_definitions: { [key]: { ...definition, config: { unit: '°F' } } } })
  expect(fields()[0].value).toBe('210 °F')
  expect(fields({ [key]: { ...definition, key, id: 99 } })[0].value).toBe('225.0 °C')
  Object.assign(entity, { custom_fields: { [key]: 0 }, custom_field_definitions: null })
  expect(fields()[0]).toMatchObject({ value: '0.0 °C', rawValue: 0 })
})

it('keeps the saved Standard selection, label, and units after promotion', async () => {
  const dryDefinition = { label: 'Drying temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } }
  const filament = { id: 8, drying_temp_c: 55, custom_fields: null, custom_field_definitions: null,
    label_field_aliases: { dry_temp: { target: 'drying_temp_c', definition: dryDefinition,
      wire: { target: 'drying_temp_c', value: 55, native: 55, source: ['dry_temp'], definition: dryDefinition } } } }
  const preset = JSON.parse('{"extraFields":{"filament.dry_temp":true}}')
  const fields = buildFilamentExtraFieldsForPrint(filament, {})
  expect(fields.find(field => field.key === 'filament.dry_temp')).toMatchObject({ label: 'Drying temperature', value: '55.0 °C', legacyAlias: true })
  const element = document.createElement('div')
  await renderStandardLabel({ element,
    settings: { ...API_DEFAULT_LABEL_SETTINGS, showQR: false },
    data: buildStandardLabelDataFromFlat({ id: 8, extraFields: fields.filter(field => preset.extraFields[field.key]) }),
  })
  expect(element.querySelector('.label-extra-fields')?.textContent).toBe('Drying temperature: 55.0 °C')
})

it.each(['filament', 'spool'] as const)('uses captured literal source components and System priority for %s aliases', kind => {
  const key = 'spoolman_extra.profile.temp'
  const record = { custom_fields: { spoolman_extra: { 'profile.temp': 210 } },
    custom_field_definitions: { [key]: { ...definition, config: { unit: '°F' } } },
    label_field_aliases: { [key]: { target: 'extruder_temp_range_c.min', definition,
      wire: { value: 210, retained: true, source: ['spoolman_extra', 'profile.temp'], definition } } } }
  const filament = { extruder_temp_range_c: { min: 225, max: 230 }, ...(kind === 'filament' ? record : {}) }
  const spool = { filament, ...(kind === 'spool' ? record : {}) }
  const fields = (defs = {}) => kind === 'filament' ? buildDesignerExtraFieldsFromFilament(filament, defs)
    : buildDesignerExtraFieldsFromApiSpool(spool, { spool: defs })
  expect(fields({ 'profile.temp': { ...definition, id: 9, key: 'profile.temp' } })
    .find(field => field.key === `${kind}.${key}`)?.value).toBe('225.0 °C')
  Object.assign(kind === 'filament' ? filament : spool, { custom_fields: { spoolman_extra: { 'profile.temp': 0 } } })
  const independent = fields({ 'profile.temp': { ...definition, id: 9, key: 'profile.temp' } })
  expect(independent.find(field => field.key === `${kind}.${key}`)).toMatchObject({ rawValue: 0, value: '0.0 °C' })
})

it('retains the ordinary Standard temperature choice without duplicate historical selectors', () => {
  const filament = { extruder_temp_range_c: { min: 225, max: 230 }, custom_fields: { extruder_temp: 210 },
    label_field_aliases: { extruder_temp: { target: 'extruder_temp_range_c.min', definition,
      wire: { value: 210, retained: true, source: ['extruder_temp'], definition } } } }
  const fields = standardLabelExtraFields(buildFilamentExtraFieldsForPrint(filament, {}), {})
  expect(fields.filter(field => field.key === 'filament.extruder_temp')).toHaveLength(1)
})

it('does not resurrect a retained temperature in the ordinary Standard field after a native clear', () => {
  const { record } = retainedRecord(false)
  const fields = buildFilamentExtraFieldsForPrint({ ...record, extruder_temp_range_c: null }, {})
  expect(fields.find(field => field.key === 'filament.extruder_temp')?.value ?? '').toBe('')
})

it.each(['filament', 'spool'] as const)('restores only selected historical %s Standard rows through handoff and reset', async kind => {
  const definitions = {
    dry_temp: { label: 'Drying temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } },
    'old.discontinued': { label: 'Discontinued', field_type: 'checkbox' },
  }
  const filament = { drying_temp_c: 55, is_discontinued: false }
  const record = { label_field_aliases: {
    dry_temp: { target: 'drying_temp_c', definition: definitions.dry_temp },
    'old.discontinued': { target: 'is_discontinued', definition: definitions['old.discontinued'] },
  } }
  const fields = kind === 'filament' ? buildFilamentExtraFieldsForPrint({ ...filament, ...record }, {})
    : buildLabelExtraFields(record, filament, 'spool')
  const selected = { [`${kind}.dry_temp`]: true, [`${kind}.old.discontinued`]: true }
  writeScopedLabelFields('label-test', 8, fields)
  const handoff = consumeScopedLabelFields<typeof fields[number]>('label-test', 8)
  expect(standardLabelExtraFields(handoff, {}, kind)).toEqual([])
  const rows = standardLabelExtraFields([...fields, ...handoff], selected, kind)
  expect(rows).toHaveLength(2)
  const container = document.createElement('div')
  const checks = rows.map(field => ({ field, checkbox: appendLabelSettingsCheckbox({ container,
    id: `check-${field.key}`, label: field.label, checked: selected[field.key], onChange() {},
  }) }))
  const element = document.createElement('div')
  const render = () => renderStandardLabel({ element, settings: { ...API_DEFAULT_LABEL_SETTINGS, showQR: false },
    data: buildStandardLabelDataFromFlat({ id: 8, extraFields: checks.filter(item => item.checkbox.checked).map(item => item.field) }),
  })
  await render()
  expect(container.querySelectorAll('input:checked')).toHaveLength(2)
  expect(element.querySelector('.label-extra-fields')?.textContent).toBe('Drying temperature: 55.0 °CDiscontinued: ✗')
  checks.forEach(item => { item.checkbox.checked = false })
  await render()
  expect(element.querySelector('.label-extra-fields')?.textContent).toBe('')
  expect(buildLabelExtraFieldCatalogGroups(rows, { entityType: kind, batchMode: false }).flatMap(group => group.fields)).toEqual([])
})

it.each(['filament', 'spool'] as const)('keeps raw false and definition-default changes independent for %s retained aliases', kind => {
  const { record, key } = retainedRecord(false)
  const filament = { extruder_temp_range_c: null, ...(kind === 'filament' ? record : {}) }
  const spool = { filament, ...(kind === 'spool' ? record : {}) }
  const fields = (defs = {}) => kind === 'filament' ? buildDesignerExtraFieldsFromFilament(filament, defs)
    : buildDesignerExtraFieldsFromApiSpool(spool, { spool: defs })
  expect(fields({ [key]: { ...definition, id: 9, key, default_value: '210' } })[0].value).toBe('210.0 °C')
  expect(fields({ [key]: { ...definition, id: 9, key, default_value: null } })[0].value).toBe('')
  Object.assign(kind === 'filament' ? filament : spool, { custom_fields: { [key]: false },
    custom_field_definitions: { [key]: { label: 'Independent checkbox', field_type: 'checkbox' } } })
  expect(fields()[0]).toMatchObject({ value: '✗', rawValue: false })
})

it('uses a wire-only captured definition for native aliases while retaining legacy string aliases', () => {
  const filament = { drying_temp_c: 65, custom_fields: { dry_temp: 55 }, label_field_aliases: {
    dry_temp: { target: 'drying_temp_c', wire: { value: 55, retained: true, source: ['dry_temp'],
      definition: { label: 'Drying temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } } } },
    old_dryer: 'drying_temp_c',
  } }
  const fields = buildDesignerExtraFieldsFromFilament(filament)
  expect(fields.find(field => field.key === 'filament.dry_temp')).toMatchObject({ label: 'Drying temperature', value: '65.0 °C' })
  expect(fields.find(field => field.key === 'filament.old_dryer')?.value).toBe('65')
})

it.each([['filament', false], ['spool', false], ['filament', true], ['spool', true]] as const)(
  'uses the remaining native endpoint for retained scalar %s tokens (nested=%s)', (kind, nested) => {
    const { key, record } = retainedRecord(nested)
    const filament = { extruder_temp_range_c: { min: null, max: 230 }, ...(kind === 'filament' ? record : {}) }
    const spool = { filament, ...(kind === 'spool' ? record : {}) }
    const render = () => renderTemplateText(`{extra.${kind}.${key}}`, kind === 'filament'
      ? buildFilamentDataFromApiFilament(filament) : buildSpoolDataFromApiSpool(spool))
    expect(render()).toBe('230.0 °C')
    Object.assign(kind === 'filament' ? filament : spool, {
      custom_fields: nested ? { spoolman_extra: { settings_extruder_temp: 0 } } : { settings_extruder_temp: 0 },
    })
    expect(render()).toBe('0.0 °C')
  },
)

it('preserves explicit historical endpoint aliases without retained ownership', () => {
  const filament = { extruder_temp_range_c: { min: null, max: 230 }, label_field_aliases: {
    old_min: { target: 'extruder_temp_range_c.min', definition },
    old_max: { target: 'extruder_temp_range_c.max', definition },
  } }
  const data = buildFilamentDataFromApiFilament(filament)
  expect(renderTemplateText('{extra.filament.old_min}|{extra.filament.old_max}', data)).toBe('|230.0 °C')
})

it.each([['filament', false, 'number'], ['spool', false, 'number'], ['filament', true, 'number'], ['spool', true, 'number'],
  ['filament', false, 'integer'], ['spool', false, 'integer'], ['filament', true, 'integer'], ['spool', true, 'integer']] as const)(
  'keeps removed-source %s scalar aliases usable with a maximum-only range (nested=%s, type=%s)', (kind, nested, fieldType) => {
    const { key, record } = retainedRecord(nested)
    const alias = record.label_field_aliases[key]
    const scalarDefinition = { ...definition, field_type: fieldType }
    Object.assign(alias, { definition: scalarDefinition, wire: { ...alias.wire, definition: scalarDefinition } })
    const removed = { ...record, custom_fields: null }
    const filament = { extruder_temp_range_c: { min: null, max: 230 }, ...(kind === 'filament' ? removed : {}) }
    const spool = { filament, ...(kind === 'spool' ? removed : {}) }
    const data = kind === 'filament' ? buildFilamentDataFromApiFilament(filament) : buildSpoolDataFromApiSpool(spool)
    expect(renderTemplateText(`{extra.${kind}.${key}}`, data)).toBe(fieldType === 'integer' ? '230' : '230.0 °C')
  },
)

it('collapses a retained integer source to the remaining native endpoint', () => {
  const { key, record } = retainedRecord(false)
  const alias = record.label_field_aliases[key]
  const integerDefinition = { ...definition, field_type: 'integer' }
  Object.assign(alias, { definition: integerDefinition, wire: { ...alias.wire, definition: integerDefinition } })
  const fields = buildDesignerExtraFieldsFromFilament({ ...record, extruder_temp_range_c: { min: null, max: 230 } })
  expect(fields.find(field => field.key === `filament.${key}`)).toMatchObject({ rawValue: 230, value: '230' })
})
