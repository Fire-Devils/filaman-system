// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { renderSystemFieldRow } from './extra-fields'
import { renderSpoolFieldInput, type SpoolDetailRow } from './spool-detail'
import { renderFilamentDetailRow, safeExternalUrl } from './filament-detail'

afterEach(() => document.body.replaceChildren())

it('keeps zero, date-only values, units and control identity in ordinary spool controls', () => {
  const row: SpoolDetailRow = { key: 'empty_spool_weight_g', labelKey: 'spools.emptySpoolWeightLabel', value: '0 g', field: { type: 'number', step: '1', unit: 'g' } }
  document.body.innerHTML = renderSpoolFieldInput(row, 0, key => key, row.key)
  const input = document.querySelector('input')!
  expect([input.id, input.name, input.value, input.type, input.step]).toEqual(['empty_spool_weight_g', 'empty_spool_weight_g', '0', 'number', '1'])
  expect(input.parentElement!.textContent).toBe('g')
  document.body.innerHTML = renderSpoolFieldInput({ key: 'purchase_date', labelKey: 'date', value: '', field: { type: 'date' } }, '2026-09-28T00:00:00Z', key => key)
  expect(document.querySelector('input')!.value).toBe('2026-09-28')
  expect(document.querySelector('input')!.hasAttribute('id')).toBe(false)
})

it('shares translated material choices without losing i18n hooks or selected values', () => {
  document.body.innerHTML = renderSpoolFieldInput({ key: 'spool_material', labelKey: 'material', value: '', field: { type: 'select', options: ['', 'Plastic', 'Cardboard'] } }, 'Cardboard', key => key === 'spools.spoolMaterialCardboard' ? 'Karton' : key, 'spool_material')
  const selected = document.querySelector<HTMLOptionElement>('option[selected]')!
  expect(selected.value).toBe('Cardboard')
  expect(selected.textContent).toBe('Karton')
  expect(selected.getAttribute('data-i18n')).toBe('spools.spoolMaterialCardboard')
})

it('renders system checkboxes with one escaped label and preserves defaults and validation', () => {
  document.body.innerHTML = renderSystemFieldRow({ key: 'sealed', label: '<Sealed>', field_type: 'checkbox', default_value: 'true' }, false)
  expect(document.querySelectorAll('label')).toHaveLength(1)
  expect(document.querySelector('label')!.textContent).toContain('<Sealed>')
  expect(document.querySelector('input')!.checked).toBe(false)
  expect(document.querySelector('input')!.dataset.key).toBe('sealed')
  document.body.innerHTML = renderSystemFieldRow({ key: 'weight', label: 'Weight', field_type: 'number', default_value: '0', config: { min_bound: 0, max_bound: 100, decimal_places: 1 } }, null)
  const input = document.querySelector('input')!
  expect([input.value, input.min, input.max, input.step]).toEqual(['0', '0', '100', '0.1'])
  expect(document.querySelectorAll('label')).toHaveLength(1)
})

it('renders filament rows with safe links and escaped values and translations', () => {
  document.body.innerHTML = renderFilamentDetailRow({ labelKey: 'label', value: '<spec>', href: 'https://example.com/?a=1&b=2' }, () => '<Label>')
  const link = document.querySelector('a')!
  expect(link.href).toBe('https://example.com/?a=1&b=2')
  expect(link.rel).toBe('noopener noreferrer')
  expect(link.textContent).toBe('<spec>')
  expect(document.querySelector('.filament-spec-label')!.textContent).toBe('<Label>')
  document.body.innerHTML = renderFilamentDetailRow({ labelKey: 'label', value: '<img src=x onerror=alert(1)>', href: 'javascript:alert(1)' }, () => 'Label')
  expect(document.querySelector('a, img')).toBeNull()
  expect(document.querySelector('.filament-spec-value')!.textContent).toBe('<img src=x onerror=alert(1)>')
  expect(safeExternalUrl('/logo.png')).toBe(`${window.location.origin}/logo.png`)
  expect(safeExternalUrl('data:image/svg+xml,test')).toBe('')
})
