import { describe, expect, it } from 'vitest'

import {
  buildDriverConfigPayload,
  isStructuredProp,
  type SchemaProperty,
} from './driver-config-form'

describe('isStructuredProp', () => {
  it.each([
    [{ type: 'array' }, [], true],
    [{ type: 'object' }, {}, true],
    [{ type: 'string' }, 'http://printer', false],
    [{ type: 'integer' }, 10, false],
    [{ type: 'boolean' }, true, false],
    // Schema omits the type but the stored value is structured anyway.
    [{}, [{ slot_index: '0-0' }], true],
    [{}, null, false],
    [undefined, 'plain', false],
  ])('%o with %o -> %s', (prop, value, expected) => {
    expect(isStructuredProp(prop as SchemaProperty, value)).toBe(expected)
  })

  it('classifies an array property before it holds a value', () => {
    // The create form has no stored value yet, so only the schema can say.
    expect(isStructuredProp({ type: 'array' }, undefined)).toBe(true)
  })
})

describe('buildDriverConfigPayload', () => {
  // The shipped Moonraker driver's schema, which is what issue #128 hit.
  const moonrakerProps: Record<string, SchemaProperty> = {
    moonraker_url: { type: 'string' },
    api_key: { type: 'string' },
    mode: { type: 'string', enum: ['toolhead_only', 'tray_macros'] },
    request_timeout_seconds: { type: 'integer' },
    slot_targets: { type: 'array' },
    slot_count: { type: 'integer' },
  }

  const slotTargets = [
    { slot_index: '0-0', slot_name: 'Tray 1', assign_gcode: 'T0' },
    { slot_index: '0-1', slot_name: 'Tray 2', assign_gcode: 'T1' },
  ]

  const storedConfig = {
    moonraker_url: 'http://printer.local',
    api_key: 'secret',
    mode: 'tray_macros',
    request_timeout_seconds: 10,
    slot_targets: slotTargets,
    slot_count: 4,
  }

  it('keeps slot_targets when an unrelated field is edited', () => {
    const payload = buildDriverConfigPayload(moonrakerProps, storedConfig, {
      moonraker_url: 'http://printer.local:7125',
      api_key: 'secret',
      mode: 'tray_macros',
      request_timeout_seconds: 10,
      slot_count: 4,
    })

    expect(payload.moonraker_url).toBe('http://printer.local:7125')
    // Same array, not "[object Object]" and not dropped.
    expect(payload.slot_targets).toEqual(slotTargets)
  })

  it('ignores a form value for a structured property', () => {
    // What the old text input would have submitted.
    const payload = buildDriverConfigPayload(moonrakerProps, storedConfig, {
      slot_targets: '[object Object],[object Object]',
    })

    expect(payload.slot_targets).toEqual(slotTargets)
  })

  it('survives repeated save round-trips', () => {
    let config: Record<string, unknown> = storedConfig
    for (let i = 0; i < 3; i++) {
      config = buildDriverConfigPayload(moonrakerProps, config, {
        moonraker_url: `http://printer.local:${7125 + i}`,
      })
    }

    expect(config.slot_targets).toEqual(slotTargets)
  })

  it('omits a structured property the stored config does not have', () => {
    const payload = buildDriverConfigPayload(
      moonrakerProps,
      { moonraker_url: 'http://printer.local' },
      { moonraker_url: 'http://printer.local' }
    )

    expect('slot_targets' in payload).toBe(false)
  })

  it('writes booleans as booleans, not as strings', () => {
    const payload = buildDriverConfigPayload(
      { verify_ssl: { type: 'boolean' } },
      { verify_ssl: true },
      { verify_ssl: false }
    )

    expect(payload.verify_ssl).toBe(false)
  })

  it('drops form values for keys the schema does not declare', () => {
    const payload = buildDriverConfigPayload(
      { moonraker_url: { type: 'string' } },
      {},
      { moonraker_url: 'http://printer.local', stale_key: 'x' } as never
    )

    expect(payload).toEqual({ moonraker_url: 'http://printer.local' })
  })
})
