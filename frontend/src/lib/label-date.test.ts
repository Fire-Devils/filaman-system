import { expect, it } from 'vitest'
import { renderTemplateText, type SpoolData } from './label-template'
import { buildSpoolDataFromApiSpool, buildFilamentDataFromApiFilament } from './label-designer-data'
import { buildSpoolLabelDataFromApi, buildSpoolStandardModelFields } from './spool-label-data'
import { prepareSvgApiInput } from './label-svg/prepare-api'

it.each([
  ['date', '2026/04/28'],
  ['date:%d.%m.%Y', '28.04.2026'],
  ['date:%m/%d/%y', '04/28/26'],
  ['date:%Y-%m-%d', '2026-04-28'],
  ['date:%d %% %m %% %Y', '28 % 04 % 2026'],
])('renders %s independently of locale and timezone', (modifier, expected) => {
  const data = { created_at: '2026-04-28T00:30:00+14:00' } as SpoolData
  expect(renderTemplateText(`{created_at|${modifier}}`, data)).toBe(expected)
  expect(renderTemplateText('{created_at}', data)).toBe('2026-04-28T00:30:00+14:00')
})

it.each([
  ['2024-02-29', '2024/02/29'],
  ['2026-02-29', '2026-02-29'],
  ['not a date', 'not a date'],
  ['0001-01-02', '0001/01/02'],
])('keeps invalid dates visible without normalizing them: %s', (raw, expected) => {
  expect(renderTemplateText('{created_at|date}', { created_at: raw } as SpoolData)).toBe(expected)
})

it('formats raw purchase dates and custom datetime fields without changing bare values', () => {
  const data = buildSpoolDataFromApiSpool({
    id: 1, purchase_date: '2026-04-28',
    custom_fields: { inspected: '2026-04-28T23:30:00-10:00' },
    custom_field_definitions: { inspected: { field_type: 'datetime' } },
  })
  expect(renderTemplateText('{purchase_date|date:%d.%m.%Y}', data)).toBe('28.04.2026')
  expect(renderTemplateText('{extra.spool.inspected|date}', data)).toBe('2026/04/28')
  expect(renderTemplateText('{extra.spool.inspected}', data)).toBe(data.extra!['spool.inspected'])
})

it('preserves literal modifier-like field names and optional empty phrases', () => {
  const data = { ...buildSpoolDataFromApiSpool({ id: 1 }), extra: { 'spool.note|date:%Y': 'literal' } }
  expect(renderTemplateText('{extra.spool.note|date:%Y}', data)).toBe('literal')
  expect(renderTemplateText('{Added: {created_at|date:%d.%m.%Y}}', data)).toBe('')
})

it('uses the stored purchase day for designer and Standard labels without a modifier', () => {
  const spool = { id: 1, purchase_date: '2026-04-20', created_at: '2026-04-20T00:30:00+14:00' }
  expect(renderTemplateText('{purchase_date}', buildSpoolDataFromApiSpool(spool))).toBe('2026/04/20')
  expect(buildSpoolStandardModelFields(buildSpoolLabelDataFromApi(spool))).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'purchase_date', value: '2026/04/20' }),
    expect.objectContaining({ key: 'created_at', value: '2026/04/20' }),
  ]))
})

it.each(['spool', 'filament'] as const)('keeps %s extra-field timestamps until a date modifier removes the time', kind => {
  const raw = '2026-04-20T00:30:45.123+14:00'
  const entity = { id: 1, custom_fields: { inspected: raw, certified: raw },
    custom_field_definitions: { inspected: { field_type: 'datetime' } } }
  const fieldDefinitions = { [kind]: { certified: { id: 1, key: 'certified', label: 'Certified', field_type: 'datetime' } } }
  const preview = kind === 'spool'
    ? buildSpoolDataFromApiSpool(entity, undefined, fieldDefinitions)
    : buildFilamentDataFromApiFilament(entity, fieldDefinitions)
  const api = prepareSvgApiInput({ [kind]: entity, preset: null, fieldDefinitions,
    assets: {}, pixelWidth: 480, pixelHeight: 320 }, 'https://fila.test', {}).data
  for (const data of [preview, api]) {
    for (const key of ['inspected', 'certified']) {
      const token = `extra.${kind}.${key}`
      expect(renderTemplateText(`{${token}}`, data)).toBe(raw)
      expect(renderTemplateText(`{${token}|date}`, data)).toBe('2026/04/20')
      expect(renderTemplateText(`{${token}|date:%d/%m/%Y}`, data)).toBe('20/04/2026')
    }
  }
})
