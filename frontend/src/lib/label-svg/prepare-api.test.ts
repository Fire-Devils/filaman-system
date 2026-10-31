import { expect, it } from 'vitest'
import { prepareSvgApiInput } from './prepare-api'
import { buildSpoolDataFromApiSpool } from '../label-designer'
import { createDefaultLabelDesign } from '../freeform-label/defaults'
import { API_DEFAULT_LABEL_SETTINGS } from '../label-standard'
import type { ApiLabelRenderPayload } from './prepare-api'
import { readFile } from 'node:fs/promises'
import { createSvgRuntime } from './runtime.mjs'
import { renderSvgLabel } from './core.mjs'
import { renderTemplateText } from '../label-template'
import { buildLabelExtraFieldCatalogGroups } from '../label-extra-fields'
import { buildDesignerExtraFieldsFromApiSpool } from '../spool-label-data'
import { buildDesignerExtraFieldsFromFilament } from '../filament-label-data'

export const payload: ApiLabelRenderPayload = {
  spool: { id: 295, remaining_weight_g: 432, purchase_date: '2026-10-05',
    filament: { id: 8, designation: 'Grüße', manufacturer: { name: 'Bambu Lab' },
      type: 'PLA', extra: { article: '11101' } }, extra: { note: 'Ä Ö Ü ß' } },
  preset: null, fieldDefinitions: { spool: {}, filament: {} }, assets: {},
  pixelWidth: 480, pixelHeight: 320, thermal: false,
}

it('passes configured currency to saved label tokens without converting the price', () => {
  const result = prepareSvgApiInput({ ...payload, purchaseCurrency: 'USD',
    spool: { ...payload.spool as object, purchase_price: 12.5 } }, 'https://fila.test', {})
  expect(renderTemplateText('{purchase_price} {purchase_currency}', result.data)).toBe('12.5 USD')
})

it.each([60, 60.1])('preserves saved temperature-token formatting and decimal values (%s)', temperature => {
  const definition = { label: 'Bed temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } }
  const filament = { id: 8, bed_temp_range_c: { min: temperature, max: temperature },
    label_field_aliases: { bed_temp: { target: 'bed_temp_range_c.min', definition } } }
  const data = prepareSvgApiInput({ ...payload, spool: undefined, filament }, 'https://fila.test', {}).data
  expect(renderTemplateText('{extra.filament.bed_temp}', data)).toBe(`${temperature.toFixed(1)} °C`)
  expect(renderTemplateText('{filament.bed_temp_range_c}', data)).toBe(String(temperature))
})

it('keeps a retained extra temperature separate from native temperatures and units', () => {
  const filament = { id: 8, bed_temp_range_c: { min: 60.1, max: 60.1 }, custom_fields: { bed_temp: 140.2 },
    custom_field_definitions: { bed_temp: { label: 'Bed Fahrenheit', field_type: 'number', config: { unit: '°F', decimal_places: 1 } } } }
  const data = prepareSvgApiInput({ ...payload, spool: undefined, filament }, 'https://fila.test', {}).data
  expect(renderTemplateText('{extra.filament.bed_temp}|{filament.bed_temp_range_c}', data)).toBe('140.2 °F|60.1')
})

it('renders saved scoped custom tokens while hiding duplicate picker entries', () => {
  const template = '{extra.spool.rfid_uid_2}|{extra.spool.spool_material}|{extra.spool.purchase_currency}|{extra.spool.spool_outer_diameter_mm}|{extra.spool.spool_width_mm}|{extra.filament.bed_temp_range_c}'
  const design = createDefaultLabelDesign('spool')
  const text = design.elements.find(element => element.type === 'text')!
  text.template = template
  const preset = { version: 2, design }
  const spool = { id: 42, rfid_uid_2: 'NATIVE-TAG', spool_material: 'Plastic',
    custom_fields: { rfid_uid_2: 'CUSTOM-TAG', spool_material: 'Custom ABS', purchase_currency: 'CAD', spool_outer_diameter_mm: 198, spool_width_mm: 65 },
    filament: { id: 8, custom_fields: { bed_temp_range_c: { min: 55, max: 65 } }, custom_field_definitions: { bed_temp_range_c: { label: 'Bed', field_type: 'range' } } } }
  const fieldDefinitions = { spool: {
    spool_outer_diameter_mm: { id: 1, key: 'spool_outer_diameter_mm', label: 'Outer diameter', field_type: 'number', config: { unit: 'mm' } },
  }, filament: {} }
  const result = prepareSvgApiInput({ ...payload, spool, preset, fieldDefinitions, purchaseCurrency: 'USD' }, 'https://fila.test', {})
  expect(renderTemplateText(template, result.data)).toBe('CUSTOM-TAG|Custom ABS|CAD|198 mm|65|55–65')
  expect(renderTemplateText('{rfid_uid_2}|{spool_material}|{purchase_currency}', result.data)).toBe('NATIVE-TAG|Plastic|USD')
  expect(buildLabelExtraFieldCatalogGroups(buildDesignerExtraFieldsFromApiSpool(spool, fieldDefinitions),
    { entityType: 'spool', batchMode: false }).flatMap(group => group.fields)).toEqual([])
})

it.each([1, 2])('preserves V%s preset tokens using live promoted values without rewriting the preset', version => {
  const template = '{extra.filament.min_temp}/{extra.filament.max_temp}/{extra.filament.my_dryer}/{extra.spool.bed}'
  const design = createDefaultLabelDesign('spool')
  const text = design.elements.find(element => element.type === 'text')!
  text.template = template
  const preset = version === 1 ? { version, settings: { title: { template } } } : { version, design }
  const before = structuredClone(preset)
  const filament = {
    id: 8, extruder_temp_range_c: { min: 210.5, max: 230.5 }, drying_temp_c: 55,
    bed_temp_range_c: { min: 60, max: 70 },
    label_field_aliases: { min_temp: 'extruder_temp_range_c.min', max_temp: 'extruder_temp_range_c.max', my_dryer: 'drying_temp_c' },
  }
  const value = { ...payload, preset, spool: { id: 42, filament,
    label_field_aliases: { bed: 'bed_temp_range_c' } } }
  const result = prepareSvgApiInput(value, 'https://fila.test', {})
  const savedText = result.preset.design.elements.find(element => element.type === 'text' && element.template === template)
  expect(savedText?.type).toBe('text')
  if (savedText?.type === 'text') expect(renderTemplateText(savedText.template, result.data)).toBe('210.5/230.5/55/60–70')
  filament.drying_temp_c = 65
  expect(renderTemplateText('{extra.filament.my_dryer}', prepareSvgApiInput(value, 'https://fila.test', {}).data)).toBe('65')
  expect(preset).toEqual(before)
  expect(buildLabelExtraFieldCatalogGroups(buildDesignerExtraFieldsFromApiSpool(value.spool),
    { entityType: 'spool', batchMode: false }).flatMap(group => group.fields)).toEqual([])
  const filamentResult = prepareSvgApiInput({ ...payload, spool: undefined, filament, preset }, 'https://fila.test', {})
  expect(renderTemplateText('{extra.filament.my_dryer}', filamentResult.data)).toBe('65')
  // A retained/reintroduced extra remains authoritative for that record.
  Object.assign(filament, { custom_fields: { my_dryer: 'Fahrenheit text' } })
  expect(renderTemplateText('{extra.filament.my_dryer}', prepareSvgApiInput(value, 'https://fila.test', {}).data)).toBe('Fahrenheit text')
})


it.each(['spool', 'filament'] as const)('preserves formatted promoted tokens for %s labels and live edits', kind => {
  const template = `{extra.${kind}.dry_temp}|{extra.${kind}.discontinued}`
  const filament = { id: 8, drying_temp_c: 55, is_discontinued: true }
  const aliases = {
    dry_temp: { target: 'drying_temp_c', definition: {
      label: 'Drying temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 },
    } },
    discontinued: { target: 'is_discontinued', definition: { label: 'Discontinued', field_type: 'checkbox' } },
  }
  const entity = { label_field_aliases: aliases }
  const labeledFilament = { ...filament, ...entity }
  const value = kind === 'spool'
    ? { ...payload, spool: { id: 42, filament, ...entity } }
    : { ...payload, spool: undefined, filament: labeledFilament }
  const render = () => renderTemplateText(template, prepareSvgApiInput(value, 'https://fila.test', {}).data)
  expect(render()).toBe('55.0 °C|✓')
  const native = kind === 'spool' ? filament : labeledFilament
  Object.assign(native, { drying_temp_c: 65, is_discontinued: false })
  expect(render()).toBe('65.0 °C|✗')
  const fields = kind === 'spool'
    ? buildDesignerExtraFieldsFromApiSpool(value.spool)
    : buildDesignerExtraFieldsFromFilament(labeledFilament)
  expect(buildLabelExtraFieldCatalogGroups(fields, { entityType: kind, batchMode: false })
    .flatMap(group => group.fields)).toEqual([])
})


it.each([['spool', false], ['filament', false], ['spool', true], ['filament', true]] as const)('retains rich formatting for driver-owned %s values (nested=%s)', (kind, nested) => {
  const definition = { label: 'Extruder temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } }
  const filament = { id: 8, extruder_temp_range_c: { min: 210, max: 210 } }
  const key = nested ? 'spoolman_extra.settings_extruder_temp' : 'settings_extruder_temp'
  const retained = { custom_fields: nested ? { spoolman_extra: { settings_extruder_temp: 210 } }
    : { settings_extruder_temp: 210 }, label_field_aliases: {
    [key]: { target: 'extruder_temp_range_c.min', definition },
  } }
  const labeledFilament = { ...filament, ...retained }
  const value = kind === 'spool' ? { ...payload, spool: { id: 42, filament, ...retained } }
    : { ...payload, spool: undefined, filament: labeledFilament }
  const template = `{extra.${kind}.${key}}`
  const render = () => renderTemplateText(template, prepareSvgApiInput(value, 'https://fila.test', {}).data)
  expect(render()).toBe('210.0 °C')
  const fields = kind === 'spool' ? buildDesignerExtraFieldsFromApiSpool(value.spool)
    : buildDesignerExtraFieldsFromFilament(labeledFilament)
  expect(buildLabelExtraFieldCatalogGroups(fields, { entityType: kind, batchMode: false })
    .flatMap(group => group.fields)).toEqual([])
  // A later record-specific definition remains authoritative.
  Object.assign(kind === 'spool' ? value.spool! : labeledFilament, { custom_field_definitions: {
    [key]: { ...definition, config: { unit: '°F', decimal_places: 0 } },
  } })
  expect(render()).toBe('210 °F')
})

it.each([null, { version: 1, settings: { label: { width: 40, height: 30 } } },
  { version: 2, design: createDefaultLabelDesign('spool') }])('prepares Default, V1 and V2 without changing input', preset => {
  const value = { ...structuredClone(payload), preset }, before = structuredClone(value)
  const result = prepareSvgApiInput(value, 'https://labels.example.test', {})
  expect(result.data).toEqual(buildSpoolDataFromApiSpool(value.spool, undefined, value.fieldDefinitions))
  expect(result.origin).toBe('https://labels.example.test')
  expect(result.preset.version).toBe(2)
  expect(result.assets).toEqual({})
  expect(value).toEqual(before)
  if (preset === null) {
    expect(result.preset.design.label).toMatchObject({ widthMm: API_DEFAULT_LABEL_SETTINGS.widthMm, heightMm: API_DEFAULT_LABEL_SETTINGS.heightMm })
    expect(result.preset.design.elements.filter(e => e.type === 'text').map(e => e.template).join('\n')).toContain('Remaining')
  }
})

it('resolves only supplied embedded assets and rejects invalid origins', () => {
  const logo = { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }
  expect(prepareSvgApiInput({ ...payload, logoUrl: '/manufacturer.png', assets: { photo: '/photo.png' } },
    'https://fila.test', { '/manufacturer.png': logo, '/photo.png': logo }).assets).toEqual({ logo, photo: logo })
  expect(() => prepareSvgApiInput(payload, 'file:///etc/passwd', {})).toThrow(/origin/i)
})

it('prepares filament values and QR targets without spool fields in Default', () => {
  const result = prepareSvgApiInput({ ...payload, spool: undefined, filament: {
    id: 8, designation: 'Filament only', material_type: 'PETG',
    manufacturer: { name: 'Maker' }, custom_fields: { article: 'SKU-42' },
  } }, 'https://fila.test', {})
  expect(result.data.id).toBe('8')
  expect(result.data['filament.id']).toBe('8')
  expect(result.data['filament.name']).toBe('Filament only')
  expect(result.data.extra?.['filament.article']).toBe('SKU-42')
  expect(result.entityPath).toBe('filaments')
  const templates = result.preset.design.elements.filter(e => e.type === 'text').map(e => e.template).join('\n')
  expect(templates).toContain('ID: {id}')
  expect(templates).not.toContain('remaining_weight_g')
})

it('retains the built-in Default color swatch in actual raster output', async () => {
  const value = { ...payload, spool: { id: 295, filament: { designation: 'Red and blue',
    colors: [{ color: { hex_code: 'FF0000' } }, { color: { hex_code: '0000FF' } }] } } }
  const input = prepareSvgApiInput(value, 'https://fila.test', {})
  expect(input.data['filament.color_hexes']).toBe('FF0000, 0000FF')
  const runtime = await createSvgRuntime((path: string) => readFile(`node_modules/${path}`))
  const output = renderSvgLabel(input, runtime)
  expect(output.pixels.some((channel: number, i: number) => i % 4 === 0 && channel > 200 && output.pixels[i + 1] < 50)).toBe(true)
  expect(output.pixels.some((channel: number, i: number) => i % 4 === 2 && channel > 200 && output.pixels[i - 2] < 50)).toBe(true)
})

it('keeps catalog-updated label formatting independent of refreshed wire provenance', () => {
  const definition = { label: 'Temperature', field_type: 'number', config: { unit: '°C', decimal_places: 1 } }
  const filament = { id: 8, drying_temp_c: 65, bed_temp_range_c: { min: 75, max: 85 },
    label_field_aliases: {
      dry_temp: { target: 'drying_temp_c', definition,
        wire: { target: 'drying_temp_c', value: 65, native: 65 } },
      temp_bed: { target: 'bed_temp_range_c.min', definition,
        wire: { target: 'bed_temp_range_c', value: 70, native: { min: 70, max: 70 } } },
    } }
  const data = prepareSvgApiInput({ ...payload, spool: undefined, filament }, 'https://fila.test', {}).data
  expect(renderTemplateText('{extra.filament.dry_temp}|{extra.filament.temp_bed}', data)).toBe('65.0 °C|75.0 °C')
  expect(renderTemplateText('{filament.bed_temp_range_c}', data)).toBe('75–85')
})
