// @vitest-environment happy-dom

import { expect, it } from 'vitest'
import { buildSpoolDataFromFlatLabel } from '../label-designer'

import { resizeLabelDesign } from './geometry'
import { migrateV1PresetData } from './migrate-v1'
import { renderFreeformLabel } from './render'

const data = buildSpoolDataFromFlatLabel({ id: 1 })

it('scales manually sized migrated logo artwork with its label', async () => {
  const source = migrateV1PresetData({ settings: {
    label: { width: 60, height: 40 },
    logo: { show: true, spaceMm: 12, scaleToFit: false, manualSizeMm: 4, align: 'left' },
    title: { show: false }, title2: { show: false },
    qr: { show: false }, info: { show: false }, info2: { show: false },
  } }, 'spool').design
  const root = document.createElement('div')
  await renderFreeformLabel({ element: root, design: source, data, logoUrl: '/logo.png' })
  expect(root.querySelector('img')?.style.height).toBe('15px')

  const resized = resizeLabelDesign(source, 120, 80)
  await renderFreeformLabel({ element: root, design: resized, data, logoUrl: '/logo.png' })

  expect(root.querySelector('img')?.style.height).toBe('30px')
})

it('scales the collapsed margins of an empty migrated title with its label', async () => {
  const source = migrateV1PresetData({ settings: {
    label: { width: 60, height: 40, marginMm: 1, border: false },
    logo: { show: false },
    title: { show: true, template: '{filament.color}', sizeMm: 4, marginMm: 1, dividerBelow: false },
    title2: { show: false }, qr: { show: false },
    info: { show: true, template: 'Visible info', marginMm: 0 }, info2: { show: false },
  } }, 'spool').design
  const root = document.createElement('div')
  await renderFreeformLabel({ element: root, design: source, data })
  expect(root.lastElementChild?.textContent).toBe('Visible info')
  expect((root.lastElementChild as HTMLElement).style.top).toBe('1mm')

  const resized = resizeLabelDesign(source, 120, 80)
  await renderFreeformLabel({ element: root, design: resized, data })

  expect(root.lastElementChild?.textContent).toBe('Visible info')
  expect((root.lastElementChild as HTMLElement).style.top).toBe('2mm')
})
