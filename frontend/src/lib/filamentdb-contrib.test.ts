import { describe, expect, it } from 'vitest'

import de from '../i18n/de.json'
import en from '../i18n/en.json'
import fr from '../i18n/fr.json'
import { ApiError } from './api'
import { starsText, renderCommunityCard } from './community-profiles'
import {
  contribErrorMessage,
  formatPayloadValue,
  noTokenNoticeHtml,
  renderPreviewBody,
  statusBadge,
  statusText,
  type ContribPreview,
} from './filamentdb-contrib'
import { planBulkSend } from './filamentdb-bulk'
import { ALL_PROFILE_FIELDS } from './print-profiles'
import { tokenStatusText } from './filamentdb-token-settings'

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

const basePreview: ContribPreview = {
  type: 'filament',
  local_id: 1,
  mode: 'create',
  payload: { designation: 'Acme <PLA>', discontinued: false, colors: [{ hex_code: '#ff0000', color_name: 'Rot' }] },
  matches: [],
  blockers: [],
  dependencies: [],
}

describe('FilaMan-DB contribution texts', () => {
  it('has the same fdbContrib keys in de, en and fr', () => {
    const keys = (dict: unknown) => leafPaths((dict as Record<string, unknown>).fdbContrib, 'fdbContrib').sort()
    expect(keys(en)).toEqual(keys(de))
    expect(keys(fr)).toEqual(keys(de))
    expect(keys(de).length).toBeGreaterThan(100)
  })

  it('has the build plate label in all languages', () => {
    for (const dict of [de, en, fr]) {
      expect((dict as { printProfiles: { fields: Record<string, string> } }).printProfiles.fields.build_plate).toBeTruthy()
    }
    expect(ALL_PROFILE_FIELDS.find(field => field.key === 'build_plate')?.maxLength).toBe(100)
  })

  it('labels every payload field the backend can send', () => {
    const labels = (de as unknown as { fdbContrib: { fields: Record<string, string> } }).fdbContrib.fields
    const profileLabels = (de as unknown as { printProfiles: { fields: Record<string, string> } }).printProfiles.fields
    const backendKeys = [
      'name', 'website', 'manufacturer', 'model', 'default_nozzle_mm', 'manufacturer_id', 'material_id', 'designation',
      'material_subtype', 'color_name', 'hex_color', 'colors', 'color_mode', 'multi_color_style', 'diameter_mm',
      'density_g_cm3', 'temp_nozzle_min', 'temp_nozzle_max', 'temp_bed', 'fan_speed_min', 'fan_speed_max', 'chamber_temp',
      'max_volumetric_speed', 'flow_ratio', 'k_value', 'softening_temp', 'dry_temp', 'dry_time_hours', 'nominal_weight_g',
      'sku', 'datasheet_url', 'discontinued', 'ams_compatible', 'build_plates', 'filament_id', 'printer_model_id',
    ]
    for (const key of backendKeys) expect(labels[key], key).toBeTruthy()
    for (const field of ALL_PROFILE_FIELDS) expect(profileLabels[field.key], field.key).toBeTruthy()
  })
})

describe('FilaMan-DB contribution rendering', () => {
  it('formats payload values', () => {
    expect(formatPayloadValue(null)).toBe('—')
    expect(formatPayloadValue(215)).toBe('215')
    expect(formatPayloadValue([{ hex_code: '#ff0000', color_name: 'Rot' }])).toBe('Rot #ff0000')
    expect(formatPayloadValue(['A', 'B'])).toBe('A, B')
  })

  it('escapes payload values in the preview and lists matches, dependencies and blockers', () => {
    const html = renderPreviewBody({
      ...basePreview,
      matches: [{ type: 'filament', id: 9, label: 'Acme PLA', score: 0.9 }],
      dependencies: [{ type: 'manufacturer', local_id: 2, label: 'Acme' }],
      blockers: [{ code: 'implausible_value', message: 'x', field: 'nozzle_temp_c', min: 150, max: 500 }],
    })
    expect(html).not.toContain('<PLA>')
    expect(html).toContain('Acme &lt;PLA&gt;')
    expect(html).toContain('data-fdb-link="9"')
    expect(html).toContain('150')
    expect(html).toContain('Acme')
  })

  it('maps status and waiting dependencies to text keys', () => {
    expect(statusText({ status: 'pending' })).toBe('In review')
    expect(statusText({ status: 'waiting', depends_on: { entity_type: 'filament', local_id: 1, label: null, status: 'pending' } }))
      .toBe('Waiting for the filament to be approved')
    expect(statusBadge({ status: 'published' })).toContain('fdb-status-success')
    expect(statusBadge({ status: 'rejected' })).toContain('fdb-status-error')
    expect(statusBadge({ status: 'pending' })).toContain('fdb-status-warning')
  })

  it('shows the registration hint with a link to db.filaman.app', () => {
    expect(noTokenNoticeHtml()).toContain('fm-db-hint')
  })

  it('turns backend error codes into messages', () => {
    const limit = contribErrorMessage(new ApiError(429, 'daily_limit_reached', 'raw'))
    expect(limit).toContain('daily limit')
    expect(contribErrorMessage(new ApiError(400, 'something_else', 'Backend text'))).toBe('Backend text')
    expect(contribErrorMessage(new Error('boom'))).toBe('boom')
    const invalid = contribErrorMessage(new ApiError(422, 'validation_error', 'Input should be less than or equal to 200', { field: 'temp_bed', max: 200 }))
    expect(invalid).not.toContain('Input should')
    expect(invalid).toContain('200')
  })

  it('describes token status', () => {
    expect(tokenStatusText({ saved: false })).toBe('No token saved')
    expect(tokenStatusText({ saved: true, display_name: 'Maker' })).toBe('Saved for Maker')
  })
})

describe('community profile cards', () => {
  it('draws stars from the average', () => {
    expect(starsText(4.4)).toBe('★★★★☆')
    expect(starsText(null)).toBe('☆☆☆☆☆')
  })

  it('does not offer rating or reporting on own profiles', () => {
    const own = renderCommunityCard({ id: 1, is_own: true, rating_count: 2, rating_avg: 4, nozzle_temp_c: 215 }, { canRate: true, canAdopt: true })
    expect(own).not.toContain('data-cp-rate')
    expect(own).not.toContain('data-cp-report')
    expect(own).toContain('data-cp-adopt="1"')
    const other = renderCommunityCard({ id: 2, is_own: false, author_display_name: '<b>x</b>' }, { canRate: true, canAdopt: false })
    expect(other).toContain('data-cp-rate="2"')
    expect(other).toContain('data-cp-report="2"')
    expect(other).not.toContain('data-cp-adopt')
    expect(other).not.toContain('<b>x</b>')
  })

  it('hides rating without a token', () => {
    const card = renderCommunityCard({ id: 3, is_own: false }, { canRate: false, canAdopt: true })
    expect(card).not.toContain('data-cp-rate')
  })
})

describe('planBulkSend', () => {
  const ok = { ...basePreview, blockers: [], matches: [] }
  it('sends, skips and flags duplicates', () => {
    const plan = planBulkSend([
      { id: 1, preview: ok },
      { id: 2, entry: { status: 'pending', changed: false }, preview: ok },
      { id: 3, preview: { ...ok, blockers: [{ code: 'material_unknown', message: 'x' }] } },
      { id: 4, preview: { ...ok, matches: [{ type: 'filament', id: 9, label: 'A', score: 0.9 }] } },
      { id: 5, entry: { status: 'published', changed: true }, preview: ok },
      { id: 6, error: 'boom' },
    ])
    expect(plan.map(d => [d.id, d.action, d.reason])).toEqual([
      [1, 'send', null],
      [2, 'skip', 'unchanged'],
      [3, 'skip', 'blocked'],
      [4, 'duplicate', 'duplicate'],
      [5, 'send', null],
      [6, 'skip', 'error'],
    ])
  })
})
