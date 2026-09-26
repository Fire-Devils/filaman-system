// @vitest-environment happy-dom
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FieldDock from '../../components/freeform-label/FieldDock.astro'
import { initFreeformLabelDesignerEditor } from './editor-page'
import type { FreeformLabelDesignerEditorController, FreeformLabelDesignerEditorOptions } from './editor-types'
import { renderTemplateText } from '../label-template'
import { buildSpoolDataFromFlatLabel } from '../label-designer'

vi.mock('./assets', () => ({ createLabelAssetClient: () => ({ list: async () => [] }) }))
let editor: FreeformLabelDesignerEditorController | undefined
beforeEach(() => { localStorage.clear(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 }) })
afterEach(() => { editor?.destroy(); editor = undefined; document.body.replaceChildren() })

async function setup(options: Partial<FreeformLabelDesignerEditorOptions> = {}) {
  const container = await AstroContainer.create()
  document.body.innerHTML = await container.renderToString(FieldDock)
  editor = await initFreeformLabelDesignerEditor({
    settingsKey: 'picker-settings', presetsKey: 'picker-presets', onChange: async () => {}, ...options,
  })
  return editor
}
const extraTokens = () => [...document.querySelectorAll<HTMLButtonElement>('.freeform-extra-fields [data-field-token]')]

describe('restored extra-field token picker', () => {
  it('opens the Spool tab for spool presets', async () => {
    await setup({ entityType: 'spool' })
    expect(document.getElementById('freeform-field-tab-spool')!.getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('freeform-field-panel-spool')!.hidden).toBe(false)
    expect(document.getElementById('freeform-field-panel-filament')!.hidden).toBe(true)
  })

  it('offers the existing filament temperature tokens', async () => {
    await setup()
    const tokens = [...document.querySelectorAll<HTMLButtonElement>('#freeform-field-panel-filament [data-field-token]')]
      .map(button => button.dataset.fieldToken)
    expect(tokens).toContain('{filament.extruder_temp}')
    expect(tokens).toContain('{filament.bed_temp}')
  })

  it('shows extra and custom fields inside their source tabs', async () => {
    await setup({ extraFields: [
      { key: 'filament.batch', label: 'Batch', source: 'filament', origin: 'system', value: '' },
      { key: 'spool.note', label: 'Note', source: 'spool', origin: 'custom', value: '' },
    ] })
    expect(document.querySelectorAll('[data-field-group-tab]')).toHaveLength(2)
    const filament = document.getElementById('freeform-field-panel-filament')!
    const spool = document.getElementById('freeform-field-panel-spool')!
    expect([...filament.querySelectorAll('.ds-tokens-group-label')].map(node => node.textContent)).toEqual(['Extra Fields', 'Custom Fields'])
    expect([...spool.querySelectorAll('.ds-tokens-group-label')].map(node => node.textContent)).toEqual(['Extra Fields', 'Custom Fields'])
    expect(filament.querySelector('[data-field-token="{extra.filament.batch}"]')).not.toBeNull()
    expect(filament.querySelector('[data-field-token="{extra.spool.note}"]')).toBeNull()
    expect(spool.querySelector('[data-field-token="{extra.spool.note}"]')).not.toBeNull()
  })

  it('inserts extra-prefixed tokens that resolve the supplied values, including legacy unscoped keys', async () => {
    const editor = await setup({ extraFields: [
      { key: 'filament.certified_at', label: 'Certified', source: 'filament', origin: 'system', value: '2026-09-07' },
      { key: 'favorite', label: 'Favorite', source: 'spool', origin: 'custom', value: 'Yes' },
    ] })
    const chips = extraTokens()
    expect(chips.map(chip => chip.dataset.fieldToken)).toEqual(['{extra.filament.certified_at}', '{extra.favorite}'])
    const data = buildSpoolDataFromFlatLabel({ id: 1, extraFields: [
      { key: 'filament.certified_at', label: 'Certified', value: '2026-09-07' },
      { key: 'favorite', label: 'Favorite', value: 'Yes' },
    ] })
    expect(chips.map(chip => renderTemplateText(chip.dataset.fieldToken!, data))).toEqual(['2026-09-07', 'Yes'])
    chips[0].click()
    expect(editor.getDesign().elements.some(element => element.type === 'text' && element.template.includes('{extra.filament.certified_at}'))).toBe(true)
  })

  it('restores source/origin groups, alphabetical ordering and duplicate removal', async () => {
    await setup({ extraFields: [
      { key: 'spool.z', label: 'Zulu', source: 'spool', origin: 'custom', value: '' },
      { key: 'spool.a', label: 'Alpha', source: 'spool', origin: 'custom', value: '' },
      { key: 'spool.a', label: 'Duplicate', source: 'spool', origin: 'custom', value: '' },
      { key: 'filament.a', label: 'Alpha', source: 'filament', origin: 'custom', value: '' },
    ] })
    expect([...document.querySelectorAll('.freeform-extra-fields .ds-tokens-group-label')].map(node => node.textContent)).toEqual([
      'Extra Fields', 'Custom Fields', 'Extra Fields', 'Custom Fields',
    ])
    expect(extraTokens().map(chip => chip.dataset.fieldToken)).toEqual(['{extra.filament.a}', '{extra.spool.a}', '{extra.spool.z}'])
    expect(document.querySelector('[data-extra-field-source="filament"]')!.textContent).toContain('No Filament System Extra Fields are configured.')
  })

  it('limits long custom groups with Show all / Show fewer without losing their tokens', async () => {
    await setup({ entityType: 'filament', extraFields: Array.from({ length: 13 }, (_, index) => ({
      key: `filament.field${index}`, label: `Field ${String(index).padStart(2, '0')}`, source: 'filament', value: '',
    })) })
    expect(extraTokens()).toHaveLength(12)
    document.querySelector<HTMLButtonElement>('.ds-custom-fields-toggle')!.click()
    expect(extraTokens()).toHaveLength(13)
    expect(extraTokens()[12].dataset.fieldToken).toBe('{extra.filament.field12}')
    document.querySelector<HTMLButtonElement>('.ds-custom-fields-toggle')!.click()
    expect(extraTokens()).toHaveLength(12)
  })

  it('restricts filament batch catalogs to filament system fields, including refreshes', async () => {
    const fields = [
      { key: 'filament.system', label: 'System', source: 'filament', origin: 'system' as const, value: '' },
      { key: 'filament.custom', label: 'Custom', source: 'filament', origin: 'custom' as const, value: '' },
      { key: 'spool.system', label: 'Spool system', source: 'spool', origin: 'system' as const, value: '' },
    ]
    const editor = await setup({ entityType: 'filament', batchMode: true, extraFields: fields })
    expect(extraTokens().map(chip => chip.dataset.fieldToken)).toEqual(['{extra.filament.system}'])
    expect(document.querySelector('[data-extra-field-source="filament"]')!.textContent).toContain('Per-filament Custom Fields are not enabled for batch printing.')
    editor.refreshExtraFields(fields)
    expect(extraTokens().map(chip => chip.dataset.fieldToken)).toEqual(['{extra.filament.system}'])
  })

  it.each([
    ['spool', 'No Spool Custom Fields are enabled.'],
    ['filament', 'No Filament Custom Fields are enabled.'],
  ] as const)('explains empty %s custom fields on a single-record printer', async (entityType, message) => {
    await setup({ entityType, extraFields: [] })
    const content = document.querySelector(`[data-extra-field-source="${entityType}"]`)!.textContent!
    expect(content).toContain(message)
    expect(content).not.toContain('batch printing')
  })

  it('hides the Spool tab on filament pages and skips it in keyboard navigation', async () => {
    await setup({ entityType: 'filament' })
    const filament = document.getElementById('freeform-field-tab-filament')!
    const spool = document.getElementById('freeform-field-tab-spool')!
    expect(spool.hidden).toBe(true)
    filament.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(filament.getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('freeform-field-panel-spool')!.hidden).toBe(true)
  })
})
