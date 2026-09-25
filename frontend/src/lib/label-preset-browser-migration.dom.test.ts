// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'

import { createDefaultLabelDesign } from './freeform-label/defaults'
import {
  FILAMENT_LABEL_PRESETS_KEY,
  readBrowserPresetsForMigration,
  SPOOL_LABEL_PRESETS_KEY,
} from './label-preset-browser-migration'

describe('browser label preset migration payload', () => {
  beforeEach(() => localStorage.clear())

  it('preserves native v2 browser-only preset data during first database migration', () => {
    const data = {
      version: 2 as const,
      design: createDefaultLabelDesign('spool', () => 'element-1'),
    }
    localStorage.setItem(SPOOL_LABEL_PRESETS_KEY, JSON.stringify({
      version: 2,
      presets: [{ name: 'Native', data, settings: {} }],
    }))

    expect(readBrowserPresetsForMigration()).toContainEqual({
      preset_type: 'spool',
      name: 'Native',
      data,
    })
  })

  it('still wraps legacy settings and ignores malformed records', () => {
    const settings = { label: { width: 72 } }
    localStorage.setItem(FILAMENT_LABEL_PRESETS_KEY, JSON.stringify([
      { name: ' Legacy ', settings },
      { name: '', settings },
      { name: 'Missing settings' },
      null,
    ]))

    expect(readBrowserPresetsForMigration()).toEqual([{
      preset_type: 'filament',
      name: 'Legacy',
      data: { settings },
    }])
  })
})
