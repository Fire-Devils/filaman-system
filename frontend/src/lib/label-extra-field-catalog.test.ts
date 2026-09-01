// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import * as labelExtraFields from './label-extra-fields'

type CatalogField = {
  key: string
  label?: string
  source?: string
  origin?: 'system' | 'custom'
}

type CatalogGroup = {
  source: 'filament' | 'spool'
  origin: 'system' | 'custom'
  fields: CatalogField[]
}

type BuildCatalogGroups = (
  fields: CatalogField[],
  options: { entityType: 'filament' | 'spool'; batchMode: boolean },
) => CatalogGroup[]

type AppendCatalogGroup = (
  container: HTMLElement,
  group: CatalogGroup,
  options: {
    batchMode: boolean
    makeChip: (token: string, label: string) => HTMLElement
    translate: (key: string, fallback: string) => string
  },
) => void

type DedupeCatalogFields = (
  fields: CatalogField[],
  defaultSource: 'filament' | 'spool',
) => CatalogField[]

type ScopeCatalogField = <T extends CatalogField>(
  field: T,
  source: 'filament' | 'spool',
) => T & { key: string; source: 'filament' | 'spool' }

const buildCatalogGroups = (
  labelExtraFields as typeof labelExtraFields & {
    buildLabelExtraFieldCatalogGroups?: BuildCatalogGroups
  }
).buildLabelExtraFieldCatalogGroups

const appendCatalogGroup = (
  labelExtraFields as typeof labelExtraFields & {
    appendLabelExtraFieldCatalogGroup?: AppendCatalogGroup
  }
).appendLabelExtraFieldCatalogGroup

const dedupeCatalogFields = (
  labelExtraFields as typeof labelExtraFields & {
    dedupeLabelExtraFields?: DedupeCatalogFields
  }
).dedupeLabelExtraFields

const scopeCatalogField = (
  labelExtraFields as typeof labelExtraFields & {
    scopeLabelExtraField?: ScopeCatalogField
  }
).scopeLabelExtraField

describe('label extra-field catalog', () => {
  it('shows only System Extra Fields in batch mode', () => {
    const groups = buildCatalogGroups?.(
      [
        { key: 'filament.drying_temp', label: 'Drying temperature', source: 'filament', origin: 'system' },
        { key: 'filament.note', label: 'Private note', source: 'filament', origin: 'custom' },
        { key: 'spool.bin', label: 'Storage bin', source: 'spool', origin: 'system' },
        { key: 'spool.inspected_by', label: 'Inspected by', source: 'spool', origin: 'custom' },
      ],
      { entityType: 'spool', batchMode: true },
    )

    expect(groups?.map(group => ({
      source: group.source,
      origin: group.origin,
      keys: group.fields.map(field => field.key),
    }))).toEqual([
      { source: 'filament', origin: 'system', keys: ['filament.drying_temp'] },
      { source: 'spool', origin: 'system', keys: ['spool.bin'] },
    ])
  })

  it('separates and alphabetizes System and Custom Fields for one filament', () => {
    const groups = buildCatalogGroups?.(
      [
        { key: 'filament.z_note', label: 'Z note', source: 'filament', origin: 'custom' },
        { key: 'filament.humidity', label: 'Humidity', source: 'filament', origin: 'system' },
        { key: 'filament.a_note', label: 'A note', source: 'filament', origin: 'custom' },
      ],
      { entityType: 'filament', batchMode: false },
    )

    expect(groups?.map(group => ({
      source: group.source,
      origin: group.origin,
      labels: group.fields.map(field => field.label),
    }))).toEqual([
      { source: 'filament', origin: 'system', labels: ['Humidity'] },
      { source: 'filament', origin: 'custom', labels: ['A note', 'Z note'] },
    ])
  })

  it('keeps distinct tokens that share a display label', () => {
    const fields = dedupeCatalogFields?.(
      [
        { key: 'system_note', label: 'Note', source: 'filament', origin: 'system' },
        { key: 'private_note', label: 'Note', source: 'filament', origin: 'custom' },
        { key: 'system_note', label: 'Duplicate Note', source: 'filament', origin: 'system' },
      ],
      'filament',
    )

    expect(fields?.map(field => [field.source, field.key, field.label])).toEqual([
      ['filament', 'system_note', 'Note'],
      ['filament', 'private_note', 'Note'],
    ])
  })

  it('scopes a field without dropping its catalog metadata', () => {
    const field = scopeCatalogField?.(
      {
        key: 'drying.temperature',
        label: 'Drying temperature',
        origin: 'custom',
        fieldType: 'number',
      },
      'filament',
    )

    expect(field).toEqual({
      key: 'filament.drying.temperature',
      label: 'Drying temperature',
      source: 'filament',
      origin: 'custom',
      fieldType: 'number',
    })
  })

  it('labels a batch System section and explains that per-record fields are disabled', () => {
    const container = document.createElement('div')
    appendCatalogGroup?.(
      container,
      {
        source: 'filament',
        origin: 'system',
        fields: [
          { key: 'filament.humidity', label: 'Humidity', source: 'filament', origin: 'system' },
        ],
      },
      {
        batchMode: true,
        makeChip: (token, label) => {
          const chip = document.createElement('button')
          chip.className = 'ds-token-chip'
          chip.title = token
          chip.textContent = label
          return chip
        },
        translate: (_key, fallback) => fallback,
      },
    )

    expect(container.querySelector('.ds-tokens-group-label')?.textContent)
      .toBe('Filament System Extra Fields')
    expect(container.querySelector('.ds-token-chip')?.getAttribute('title'))
      .toBe('{extra.filament.humidity}')
    expect(container.querySelector('.ds-batch-custom-fields-note')?.textContent)
      .toBe('Per-filament Custom Fields are not enabled for batch printing.')
  })

  it('shows an empty System message and bounds a large single-record Custom section', () => {
    const systemContainer = document.createElement('div')
    appendCatalogGroup?.(
      systemContainer,
      { source: 'spool', origin: 'system', fields: [] },
      {
        batchMode: false,
        makeChip: () => document.createElement('button'),
        translate: (_key, fallback) => fallback,
      },
    )
    expect(systemContainer.querySelector('.ds-tokens-empty')?.textContent)
      .toBe('No Spool System Extra Fields are configured.')

    const customContainer = document.createElement('div')
    const fields = Array.from({ length: 13 }, (_, index) => ({
      key: `filament.field_${String(index + 1).padStart(2, '0')}`,
      label: `Field ${String(index + 1).padStart(2, '0')}`,
      source: 'filament',
      origin: 'custom' as const,
    }))
    appendCatalogGroup?.(
      customContainer,
      { source: 'filament', origin: 'custom', fields },
      {
        batchMode: false,
        makeChip: (token, label) => {
          const chip = document.createElement('button')
          chip.className = 'ds-token-chip'
          chip.title = token
          chip.textContent = label
          return chip
        },
        translate: (_key, fallback) => fallback,
      },
    )

    expect(customContainer.querySelectorAll('.ds-token-chip')).toHaveLength(12)
    const showAll = customContainer.querySelector<HTMLButtonElement>('.ds-custom-fields-toggle')!
    expect(showAll.textContent).toBe('Show all 13 Custom Fields')
    showAll.click()
    expect(customContainer.querySelectorAll('.ds-token-chip')).toHaveLength(13)
    expect(customContainer.querySelector('.ds-custom-fields-toggle')?.textContent)
      .toBe('Show fewer Custom Fields')
  })
})
