import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  dpToStep,
  collectSystemFieldValues,
  unflattenFieldValues,
  renderFieldInput,
  renderFieldDisplay,
  renderFieldPlainText,
  formatDateTimeDisplay,
  formatDateTimeInputValue,
  isUnsafeExtraFieldPath,
  renderUnknownFieldPlainText,
  type SystemExtraFieldDef,
} from './extra-fields'

// ── helper factories ─────────────────────────────────────────────────────────

function field(overrides: Partial<SystemExtraFieldDef> & { field_type: string }): SystemExtraFieldDef {
  return {
    id: 1,
    key: 'test_key',
    label: 'Test Label',
    ...overrides,
  }
}

// ── escapeHtml ───────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('')
  })

  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#x27;s')
  })

  it('leaves safe strings unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123')
  })

  it('handles all special chars together', () => {
    const result = escapeHtml('<a href="x" data-y=\'z\'>&</a>')
    expect(result).not.toContain('<')
    expect(result).not.toContain('>')
    expect(result).not.toContain('"')
    expect(result).not.toContain("'")
    expect(result).toContain('&amp;')
    expect(result).toContain('&lt;')
    expect(result).toContain('&gt;')
  })
})

describe('extra-field path safety', () => {
  it('recognizes reserved and empty dotted path segments', () => {
    expect(isUnsafeExtraFieldPath('__proto__.polluted')).toBe(true)
    expect(isUnsafeExtraFieldPath('constructor.prototype.polluted')).toBe(true)
    expect(isUnsafeExtraFieldPath('safe..field')).toBe(true)
    expect(isUnsafeExtraFieldPath('drying.temperature')).toBe(false)
  })

  it('unflattens reserved legacy keys without mutating object prototypes', () => {
    const objectPrototype = Object.prototype as Record<string, unknown>
    delete objectPrototype.polluted
    delete objectPrototype.infected

    const result = unflattenFieldValues({
      '__proto__.polluted': 'no',
      'constructor.prototype.infected': 'no',
    })

    expect(objectPrototype.polluted).toBeUndefined()
    expect(objectPrototype.infected).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual({
      polluted: 'no',
    })
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')?.value).toEqual({
      prototype: { infected: 'no' },
    })
  })
})

// ── dpToStep ─────────────────────────────────────────────────────────────────

describe('dpToStep', () => {
  it('returns "any" for null', () => {
    expect(dpToStep(null)).toBe('any')
  })

  it('returns "any" for undefined', () => {
    expect(dpToStep(undefined)).toBe('any')
  })

  it('returns "1" for 0 decimal places', () => {
    expect(dpToStep(0)).toBe('1')
  })

  it('returns "0.1" for 1 decimal place', () => {
    expect(dpToStep(1)).toBe('0.1')
  })

  it('returns "0.01" for 2 decimal places', () => {
    expect(dpToStep(2)).toBe('0.01')
  })

  it('returns "0.001" for 3 decimal places', () => {
    expect(dpToStep(3)).toBe('0.001')
  })
})

// ── renderFieldInput ─────────────────────────────────────────────────────────

describe('renderFieldInput — number (and legacy float alias)', () => {
  it('renders number input for type "number"', () => {
    const html = renderFieldInput(field({ field_type: 'number' }), null)
    expect(html).toContain('type="number"')
    expect(html).toContain('data-key="test_key"')
    expect(html).toContain('data-type="number"')
  })

  it('still renders correctly for legacy type "float"', () => {
    const html = renderFieldInput(field({ field_type: 'float' }), null)
    expect(html).toContain('type="number"')
    expect(html).toContain('data-type="float"')
  })

  it('includes unit span when unit is configured', () => {
    const html = renderFieldInput(field({ field_type: 'number', config: { unit: 'mm' } }), null)
    expect(html).toContain('mm')
    expect(html).toContain('display:flex')
  })

  it('sets step="any" when decimal_places is null', () => {
    const html = renderFieldInput(field({ field_type: 'number' }), null)
    expect(html).toContain('step="any"')
  })

  it('sets step="0.01" for 2 decimal places', () => {
    const html = renderFieldInput(field({ field_type: 'number', config: { decimal_places: 2 } }), null)
    expect(html).toContain('step="0.01"')
  })

  it('includes min attr from config', () => {
    const html = renderFieldInput(field({ field_type: 'number', config: { min_bound: 10 } }), null)
    expect(html).toContain('min="10"')
  })

  it('includes max attr from config', () => {
    const html = renderFieldInput(field({ field_type: 'number', config: { max_bound: 999 } }), null)
    expect(html).toContain('max="999"')
  })

  it('prefills value from rawValue', () => {
    const html = renderFieldInput(field({ field_type: 'number' }), 42.5)
    expect(html).toContain('value="42.5"')
  })

  it('prefills value from flat fallback', () => {
    const html = renderFieldInput(field({ field_type: 'number' }), null, { test_key: 3.14 })
    expect(html).toContain('value="3.14"')
  })
})

describe('renderFieldInput — range', () => {
  it('renders two number inputs', () => {
    const html = renderFieldInput(field({ field_type: 'range' }), null)
    const count = (html.match(/<input type="number"/g) ?? []).length
    expect(count).toBe(2)
  })

  it('uses .min data-key for first input', () => {
    const html = renderFieldInput(field({ field_type: 'range' }), null)
    expect(html).toContain('data-key="test_key.min"')
  })

  it('uses .max data-key for second input', () => {
    const html = renderFieldInput(field({ field_type: 'range' }), null)
    expect(html).toContain('data-key="test_key.max"')
  })

  it('populates min/max from rawValue object', () => {
    const html = renderFieldInput(field({ field_type: 'range' }), { min: 100, max: 250 })
    expect(html).toContain('value="100"')
    expect(html).toContain('value="250"')
  })

  it('populates min/max from flat fallback', () => {
    const html = renderFieldInput(field({ field_type: 'range' }), null, {
      'test_key.min': 5,
      'test_key.max': 15,
    })
    expect(html).toContain('value="5"')
    expect(html).toContain('value="15"')
  })

  it('shows unit for range with unit config', () => {
    const html = renderFieldInput(field({ field_type: 'range', config: { unit: '°C' } }), null)
    expect(html).toContain('°C')
  })
})

describe('renderFieldInput — datetime', () => {
  it('renders a datetime-local input and preserves the stored value', () => {
    const html = renderFieldInput(
      field({ field_type: 'datetime' }),
      '2026-07-25T14:30',
    )

    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('data-type="datetime"')
    expect(html).toContain('value="2026-07-25T14:30"')
  })

  it('shows a timezone-bearing value in local form without losing the original', () => {
    const raw = '2026-07-25T14:30:45.123Z'
    const local = formatDateTimeInputValue(raw)
    const html = renderFieldInput(field({ field_type: 'datetime' }), raw)

    expect(local).not.toBeNull()
    expect(html).toContain(`value="${local}"`)
    expect(html).toContain(`data-original-raw="${raw}"`)
    expect(html).not.toContain(`value="${raw}"`)
  })

  it('uses a text fallback so an invalid legacy value remains editable', () => {
    const html = renderFieldInput(field({ field_type: 'datetime' }), 'unknown')

    expect(html).toContain('type="text"')
    expect(html).toContain('value="unknown"')
  })
})

describe('collectSystemFieldValues', () => {
  function rootWith(scalars: any[], multiselect: any[] = []): ParentNode {
    return {
      querySelectorAll: (selector: string) => selector === '.system-field-input' ? scalars : multiselect,
    } as unknown as ParentNode
  }

  it('collects scalar, numeric, checkbox, and multiselect values centrally', () => {
    const result = collectSystemFieldValues(rootWith([
      { dataset: { key: 'name', type: 'text' }, value: 'PLA' },
      { dataset: { key: 'temp', type: 'number' }, value: '215.5' },
      { dataset: { key: 'enabled', type: 'checkbox' }, checked: true, value: '' },
    ], [
      { dataset: { key: 'tags' }, checked: true, value: 'Matte' },
      { dataset: { key: 'tags' }, checked: false, value: 'Silk' },
    ]))

    expect(result).toEqual({
      flat: { name: 'PLA', temp: 215.5, enabled: 'true' },
      direct: { tags: ['Matte'] },
    })
  })

  it('preserves a timezone-bearing datetime when its local display was not edited', () => {
    const raw = '2026-07-25T14:30:45.123Z'
    const local = formatDateTimeInputValue(raw)!
    const result = collectSystemFieldValues(rootWith([
      {
        dataset: {
          key: 'certified_at',
          type: 'datetime',
          originalRaw: raw,
          originalDisplay: local,
        },
        value: local,
      },
    ]))

    expect(result?.flat.certified_at).toBe(raw)
  })

  it('stores the new local value when a datetime was deliberately edited', () => {
    const result = collectSystemFieldValues(rootWith([
      {
        dataset: {
          key: 'certified_at',
          type: 'datetime',
          originalRaw: '2026-07-25T14:30:45.123Z',
          originalDisplay: '2026-07-25T09:30',
        },
        value: '2026-07-26T10:45',
      },
    ]))

    expect(result?.flat.certified_at).toBe('2026-07-26T10:45')
  })

  it('rejects a range whose minimum exceeds its maximum', () => {
    let clearFromMin: (() => void) | undefined
    const maxInput = {
      dataset: { key: 'temps.max', type: 'number', rangeKey: 'temps', rangeEnd: 'max' },
      value: '100',
      setCustomValidity(message: string) { this.validationMessage = message },
      addEventListener() {},
      reportValidity() {},
      validationMessage: '',
    }
    const result = collectSystemFieldValues(rootWith([
      {
        dataset: { key: 'temps.min', type: 'number', rangeKey: 'temps', rangeEnd: 'min' },
        value: '200',
        addEventListener(_event: string, listener: () => void) { clearFromMin = listener },
      },
      maxInput,
    ]))

    expect(result).toBeNull()
    expect(maxInput.validationMessage).toContain('Maximum')
    clearFromMin?.()
    expect(maxInput.validationMessage).toBe('')
  })
})

describe('unflattenFieldValues', () => {
  it('builds range objects without coercing typed values', () => {
    expect(unflattenFieldValues({
      'temps.min': 190.5,
      'temps.max': 220,
      numeric_text: '00123',
    })).toEqual({
      temps: { min: 190.5, max: 220 },
      numeric_text: '00123',
    })
  })
})

describe('renderFieldInput — date', () => {
  it('renders date input', () => {
    const html = renderFieldInput(field({ field_type: 'date' }), null)
    expect(html).toContain('type="date"')
    expect(html).toContain('data-type="date"')
  })

  it('prefills date value', () => {
    const html = renderFieldInput(field({ field_type: 'date' }), '2024-06-15')
    expect(html).toContain('value="2024-06-15"')
  })
})

describe('renderFieldInput — url', () => {
  it('renders url input', () => {
    const html = renderFieldInput(field({ field_type: 'url' }), null)
    expect(html).toContain('type="url"')
    expect(html).toContain('placeholder="https://"')
  })
})

describe('renderFieldInput — multiselect', () => {
  const opts = ['Red', 'Green', 'Blue']

  it('renders a checkbox per option', () => {
    const html = renderFieldInput(field({ field_type: 'multiselect', options: opts }), [])
    const count = (html.match(/type="checkbox"/g) ?? []).length
    expect(count).toBe(3)
  })

  it('uses system-field-input-multi class', () => {
    const html = renderFieldInput(field({ field_type: 'multiselect', options: opts }), [])
    expect(html).toContain('system-field-input-multi')
  })

  it('marks selected options as checked', () => {
    const html = renderFieldInput(field({ field_type: 'multiselect', options: opts }), ['Green'])
    // Green should be checked, Red should not
    expect(html).toContain('" checked')
    const greenChecked = html.match(/value="Green"([^>]*)/)?.[0] ?? ''
    expect(greenChecked).toContain('checked')
  })

  it('handles empty rawValue array', () => {
    const html = renderFieldInput(field({ field_type: 'multiselect', options: opts }), [])
    expect(html).not.toContain(' checked')
  })

  it('handles null options gracefully', () => {
    const html = renderFieldInput(field({ field_type: 'multiselect', options: null }), [])
    expect(html).toContain('flex-direction:column')
  })
})

describe('renderFieldInput — textarea', () => {
  it('renders textarea element', () => {
    const html = renderFieldInput(field({ field_type: 'textarea' }), null)
    expect(html).toContain('<textarea')
    expect(html).toContain('data-type="textarea"')
  })

  it('uses max_length from config', () => {
    const html = renderFieldInput(field({ field_type: 'textarea', config: { max_length: 200 } }), null)
    expect(html).toContain('maxlength="200"')
  })

  it('defaults maxlength to 2000', () => {
    const html = renderFieldInput(field({ field_type: 'textarea' }), null)
    expect(html).toContain('maxlength="2000"')
  })

  it('includes prefilled value', () => {
    const html = renderFieldInput(field({ field_type: 'textarea' }), 'some notes')
    expect(html).toContain('some notes')
  })
})

describe('renderFieldInput — checkbox', () => {
  it('renders checkbox input', () => {
    const html = renderFieldInput(field({ field_type: 'checkbox', label: 'Enabled' }), null)
    expect(html).toContain('type="checkbox"')
  })

  it('includes field label', () => {
    const html = renderFieldInput(field({ field_type: 'checkbox', label: 'Enabled' }), null)
    expect(html).toContain('Enabled')
  })

  it('sets checked for true string', () => {
    const html = renderFieldInput(field({ field_type: 'checkbox', label: 'L' }), 'true')
    expect(html).toContain(' checked')
  })

  it('sets checked for boolean true', () => {
    const html = renderFieldInput(field({ field_type: 'checkbox', label: 'L' }), true)
    expect(html).toContain(' checked')
  })

  it('does not set checked for false', () => {
    const html = renderFieldInput(field({ field_type: 'checkbox', label: 'L' }), false)
    expect(html).not.toContain(' checked')
  })
})

describe('renderFieldInput — dropdown', () => {
  it('renders select element', () => {
    const html = renderFieldInput(field({ field_type: 'dropdown', options: ['A', 'B'] }), null)
    expect(html).toContain('<select')
    expect(html).toContain('data-type="dropdown"')
  })

  it('renders one option per value plus empty default', () => {
    const html = renderFieldInput(field({ field_type: 'dropdown', options: ['X', 'Y'] }), null)
    const count = (html.match(/<option/g) ?? []).length
    expect(count).toBe(3) // empty + X + Y
  })

  it('marks matching option as selected', () => {
    const html = renderFieldInput(field({ field_type: 'dropdown', options: ['A', 'B', 'C'] }), 'B')
    expect(html).toContain('value="B" selected')
  })
})

describe('renderFieldInput — formula', () => {
  it('renders computed span', () => {
    const html = renderFieldInput(field({ field_type: 'formula' }), null)
    expect(html).toContain('(computed)')
  })
})

describe('renderFieldInput — text (default)', () => {
  it('renders text input for type "text"', () => {
    const html = renderFieldInput(field({ field_type: 'text' }), null)
    expect(html).toContain('type="text"')
    expect(html).toContain('data-type="text"')
  })

  it('renders text input for unknown type', () => {
    const html = renderFieldInput(field({ field_type: 'unknown_future_type' }), null)
    expect(html).toContain('type="text"')
  })
})

describe('renderFieldInput — XSS safety', () => {
  it('escapes key in data-key attribute', () => {
    const html = renderFieldInput(field({ field_type: 'text', key: '"><script>' }), null)
    expect(html).not.toContain('<script>')
  })

  it('escapes value to prevent XSS', () => {
    const html = renderFieldInput(field({ field_type: 'text' }), '<img onerror=alert(1)>')
    expect(html).not.toContain('<img')
  })
})

// ── renderFieldDisplay ───────────────────────────────────────────────────────

describe('renderFieldDisplay — null / undefined', () => {
  it('returns em-dash for null', () => {
    expect(renderFieldDisplay(field({ field_type: 'text' }), null)).toBe('—')
  })

  it('returns em-dash for undefined', () => {
    expect(renderFieldDisplay(field({ field_type: 'text' }), undefined)).toBe('—')
  })
})

describe('renderFieldDisplay — number', () => {
  it('formats number with decimal places', () => {
    const html = renderFieldDisplay(field({ field_type: 'number', config: { decimal_places: 2 } }), 3.14159)
    expect(html).toContain('3.14')
  })

  it('shows number without unit when config absent', () => {
    const html = renderFieldDisplay(field({ field_type: 'number' }), 42)
    expect(html).toContain('42')
    expect(html).not.toContain('<span style')
  })

  it('appends unit span when unit configured', () => {
    const html = renderFieldDisplay(field({ field_type: 'number', config: { unit: 'kg' } }), 1.5)
    expect(html).toContain('kg')
  })

  it('returns string for non-numeric value', () => {
    const html = renderFieldDisplay(field({ field_type: 'number' }), 'not-a-number')
    expect(html).toContain('not-a-number')
  })

  it('does not partially parse malformed numeric strings', () => {
    expect(renderFieldDisplay(field({ field_type: 'number' }), '12abc')).toBe('12abc')
  })
})

describe('renderFieldDisplay — range', () => {
  it('renders min–max with en dash', () => {
    const html = renderFieldDisplay(field({ field_type: 'range' }), { min: 100, max: 250 })
    expect(html).toContain('100')
    expect(html).toContain('250')
    expect(html).toContain('–')
  })

  it('applies decimal places to both bounds', () => {
    const html = renderFieldDisplay(
      field({ field_type: 'range', config: { decimal_places: 1 } }),
      { min: 100, max: 250 }
    )
    expect(html).toContain('100.0')
    expect(html).toContain('250.0')
  })

  it('returns string for non-object value', () => {
    const result = renderFieldDisplay(field({ field_type: 'range' }), 'not-an-object')
    expect(result).toContain('not-an-object')
  })
})

describe('renderFieldDisplay — date', () => {
  it('wraps date string in span', () => {
    const html = renderFieldDisplay(field({ field_type: 'date' }), '2024-06-15')
    expect(html).toContain('2024-06-15')
    expect(html).toContain('<span>')
  })
})

describe('renderFieldDisplay — datetime', () => {
  it('shows a compact local date and time instead of raw ISO metadata', () => {
    const raw = '2026-07-25T14:30:45.123Z'
    const html = renderFieldDisplay(field({ field_type: 'datetime' }), raw)

    expect(html).toBe(`<span>${formatDateTimeDisplay(raw)}</span>`)
    expect(html).not.toContain('T14:30:45.123Z')
  })

  it('keeps an invalid legacy value visible', () => {
    expect(renderFieldDisplay(field({ field_type: 'datetime' }), 'unknown'))
      .toBe('<span>unknown</span>')
  })
})

describe('renderFieldDisplay — url', () => {
  it('renders anchor tag', () => {
    const html = renderFieldDisplay(field({ field_type: 'url' }), 'https://example.com')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('renders unsafe URL schemes as plain text', () => {
    const html = renderFieldDisplay(field({ field_type: 'url' }), 'javascript:alert(1)')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<a ')
    expect(html).toContain('javascript:alert(1)')
  })

  it('renders malformed HTTP URLs as plain text', () => {
    const html = renderFieldDisplay(field({ field_type: 'url' }), 'https://')
    expect(html).toBe('https://')
  })
})

describe('renderFieldDisplay — multiselect', () => {
  it('wraps each value in fm-pill span', () => {
    const html = renderFieldDisplay(field({ field_type: 'multiselect' }), ['PLA', 'PETG'])
    expect(html).toContain('class="fm-pill"')
    expect(html).toContain('>PLA<')
    expect(html).toContain('>PETG<')
  })

  it('returns string for non-array value', () => {
    const result = renderFieldDisplay(field({ field_type: 'multiselect' }), 'not-array')
    expect(result).toContain('not-array')
  })
})

describe('renderFieldDisplay — textarea', () => {
  it('wraps in pre-wrap div', () => {
    const html = renderFieldDisplay(field({ field_type: 'textarea' }), 'line1\nline2')
    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('line1\nline2')
  })
})

describe('renderFieldDisplay — checkbox', () => {
  it('returns checkmark for true', () => {
    expect(renderFieldDisplay(field({ field_type: 'checkbox' }), true)).toBe('✓')
  })

  it('returns checkmark for string "true"', () => {
    expect(renderFieldDisplay(field({ field_type: 'checkbox' }), 'true')).toBe('✓')
  })

  it('returns cross for false', () => {
    expect(renderFieldDisplay(field({ field_type: 'checkbox' }), false)).toBe('✗')
  })

  it('returns cross for string "false"', () => {
    expect(renderFieldDisplay(field({ field_type: 'checkbox' }), 'false')).toBe('✗')
  })
})

describe('renderFieldDisplay — text (default)', () => {
  it('returns escaped value', () => {
    const result = renderFieldDisplay(field({ field_type: 'text' }), 'Hello <World>')
    expect(result).toContain('&lt;World&gt;')
    expect(result).not.toContain('<World>')
  })
})

describe('renderFieldPlainText', () => {
  it('formats numbers with configured decimals and unit for labels', () => {
    const result = renderFieldPlainText(
      field({ field_type: 'number', config: { decimal_places: 1, unit: 'g' } }),
      215.55,
    )
    expect(result).toBe('215.6 g')
  })

  it('formats ranges without object stringification', () => {
    const result = renderFieldPlainText(
      field({ field_type: 'range', config: { decimal_places: 1, unit: '°C' } }),
      { min: 190, max: 215 },
    )
    expect(result).toBe('190.0–215.0 °C')
  })

  it('formats multiselect values with readable separators', () => {
    expect(renderFieldPlainText(field({ field_type: 'multiselect' }), ['Matte', 'Silk']))
      .toBe('Matte, Silk')
  })

  it('prints datetimes compactly without seconds or timezone metadata', () => {
    const raw = '2026-07-25T14:30:45.123Z'
    const result = renderFieldPlainText(field({ field_type: 'datetime' }), raw)

    expect(result).toBe(formatDateTimeDisplay(raw))
    expect(result).not.toContain('T14:30:45.123Z')
  })
})

describe('renderUnknownFieldPlainText', () => {
  it('keeps unknown arrays at one readable top-level value', () => {
    expect(renderUnknownFieldPlainText(['One', 'Two'])).toBe('One, Two')
  })

  it('keeps unknown range-like objects readable for labels', () => {
    expect(renderUnknownFieldPlainText({ min: 12.5, max: 88.5 })).toBe('12.5–88.5')
  })

  it('serializes unknown objects without object stringification', () => {
    expect(renderUnknownFieldPlainText({ alpha: 'A', beta: 'B' })).toBe('{"alpha":"A","beta":"B"}')
  })
})
