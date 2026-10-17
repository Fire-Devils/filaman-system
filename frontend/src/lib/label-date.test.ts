import { expect, it } from 'vitest'
import { renderTemplateText, type SpoolData } from './label-template'
import { buildSpoolDataFromApiSpool } from './label-designer-data'

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
