import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  dpToStep,
  renderFieldInput,
  renderFieldDisplay,
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

describe('renderFieldDisplay — url', () => {
  it('renders anchor tag', () => {
    const html = renderFieldDisplay(field({ field_type: 'url' }), 'https://example.com')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('escapes URL to prevent XSS — javascript: scheme replaced with #', () => {
    const html = renderFieldDisplay(field({ field_type: 'url' }), 'javascript:alert(1)')
    expect(html).not.toContain('href="javascript:')
    // Display text is still escaped and shown
    expect(html).toContain('javascript:alert(1)')
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
