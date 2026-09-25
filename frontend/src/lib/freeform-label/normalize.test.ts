import { describe, expect, it } from 'vitest'

import { createDefaultLabelDesign } from './defaults'
import { normalizeLabelDesign, parseLabelElementJson } from './normalize'

describe('freeform label defaults', () => {
  it('creates a spool design with stable unique element identities and millimetre geometry', () => {
    const ids = ['text-1', 'qr-1', 'logo-1', 'swatch-1']
    const design = createDefaultLabelDesign('spool', () => ids.shift()!)

    expect(design.version).toBe(2)
    expect(design.label).toEqual({
      widthMm: 60,
      heightMm: 40,
      marginMm: 1,
      border: false,
    })
    expect(design.elements.map(element => element.id)).toEqual([
      'text-1',
      'qr-1',
      'logo-1',
      'swatch-1',
    ])
    expect(new Set(design.elements.map(element => element.id)).size).toBe(4)
    expect(design.elements.every(element => (
      element.x >= 0
      && element.y >= 0
      && element.w > 0
      && element.h > 0
    ))).toBe(true)
  })
})

describe('freeform label normalization', () => {
  it('preserves a valid thin legacy title row for flow-compatible rendering', () => {
    const normalized = normalizeLabelDesign({
      version: 2,
      label: { widthMm: 40, heightMm: 20, marginMm: 1, border: false },
      elements: [{
        id: 'legacy-title', type: 'text', x: 1, y: 1, w: 38, h: 2, z: 0,
        template: 'Title', fontFamily: 'Space Grotesk', fontSizeMm: 2,
        fontWeight: 400, italic: false, underline: false, align: 'left',
        color: '#000000', wrap: false, legacyTextRole: 'title',
      }],
    })

    expect(normalized.elements[0].h).toBe(2)
  })
  it('keeps legacy title rows selectable when their stored width is invalid', () => {
    const normalized = normalizeLabelDesign({
      version: 2,
      label: { widthMm: 40, heightMm: 20, marginMm: 1, border: false },
      elements: [{
        id: 'legacy-title', type: 'text', x: 1, y: 1, w: 0, h: 2, z: 0,
        template: 'Title', fontFamily: 'Space Grotesk', fontSizeMm: 2,
        fontWeight: 400, italic: false, underline: false, align: 'left',
        color: '#000000', wrap: false, legacyTextRole: 'title',
      }],
    })

    expect(normalized.elements[0]).toMatchObject({ w: 3, h: 2 })
  })
  it.each(['top', 'middle', 'bottom'])('preserves explicit %s text placement through JSON round trips', verticalAlign => {
    const normalized = normalizeLabelDesign({ elements: [{ id: 'text', type: 'text', verticalAlign }] })
    expect(normalized.elements[0]).toMatchObject({ verticalAlign })
    expect(normalizeLabelDesign(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized)
  })

  it.each([undefined, 'center', null, 1])('omits invalid or missing vertical alignment %s to preserve legacy top placement', verticalAlign => {
    const normalized = normalizeLabelDesign({ elements: [{ id: 'text', type: 'text', verticalAlign }] })
    expect(normalized.elements[0]).not.toHaveProperty('verticalAlign')
  })

  it('preserves bounded and explicit full-frame crops while omitting malformed crops', () => {
    const normalized = normalizeLabelDesign({
      label: { widthMm: 60, heightMm: 40 },
      elements: [
        { id: 'cropped', type: 'image', assetId: 'asset-1', crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.75 } },
        { id: 'full', type: 'image', assetId: 'asset-2', crop: { x: 0, y: 0, w: 1, h: 1 } },
        { id: 'malformed', type: 'image', assetId: 'asset-3', crop: { x: 0, y: Number.NaN, w: 0.5, h: 0.5 } },
      ],
    })

    expect(normalized.elements).toMatchObject([
      { id: 'cropped', crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.75 } },
      { id: 'full' },
      { id: 'malformed' },
    ])
    expect(normalized.elements[1]).toHaveProperty('crop', { x: 0, y: 0, w: 1, h: 1 })
    expect(normalized.elements[2]).not.toHaveProperty('crop')
  })

  it('clamps image crop coordinates and dimensions to a visible bounded rectangle', () => {
    const normalized = normalizeLabelDesign({
      label: { widthMm: 60, heightMm: 40 },
      elements: [{
        id: 'image', type: 'image', assetId: 'asset-1',
        crop: { x: -0.2, y: 0.98, w: 1.4, h: 0.001 },
      }],
    })

    expect(normalized.elements[0]).toMatchObject({
      crop: { x: 0, y: 0.98, w: 1, h: 0.01 },
    })
  })

  it('preserves valid thin cropped-image geometry through normalization round trips', () => {
    const raw = {
      label: { widthMm: 20, heightMm: 10 },
      elements: [{
        id: 'cropped', type: 'image', assetId: 'asset-1', x: 0, y: 0, w: 20, h: 0.2,
        crop: { x: 0, y: 0, w: 1, h: 0.01 },
      }],
    }

    const normalized = normalizeLabelDesign(raw)

    expect(normalized.elements[0]).toMatchObject({ w: 20, h: 0.2 })
    expect(normalizeLabelDesign(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized)
  })

  it('preserves partial overflow while keeping some of every element on the label', () => {
    const normalized = normalizeLabelDesign({
      label: { widthMm: 60, heightMm: 40 },
      elements: [
        { id: 'partial', type: 'text', x: -10, y: 39.95, w: 20, h: 5 },
        { id: 'outside', type: 'text', x: 100, y: -100, w: 20, h: 5 },
        {
          id: 'thin', type: 'image', assetId: 'asset-1', x: 20, y: 100, w: 20, h: 0.0004,
          crop: { x: 0, y: 0, w: 1, h: 0.01 },
        },
      ],
    })

    expect(normalized.elements[0]).toMatchObject({ x: -10, y: 39.9, w: 20, h: 5 })
    expect(normalized.elements[1]).toMatchObject({ x: 59.9, y: -4.9, w: 20, h: 5 })
    expect(normalized.elements[2]).toMatchObject({ x: 20, w: 20, h: 0.0004 })
    expect(normalized.elements[2].y).toBeCloseTo(39.9996, 8)
  })

  it('keeps the standard minimum size for uncropped images', () => {
    const normalized = normalizeLabelDesign({
      label: { widthMm: 20, heightMm: 10 },
      elements: [{ id: 'image', type: 'image', assetId: 'asset-1', w: 0.2, h: 0.2 }],
    })

    expect(normalized.elements[0]).toMatchObject({ w: 3, h: 3 })
  })

  it('bounds default QR, logo, and swatch geometry inside a small label', () => {
    const normalized = normalizeLabelDesign({
      label: { widthMm: 20, heightMm: 10 },
      elements: [
        { id: 'qr', type: 'qr' },
        { id: 'logo', type: 'manufacturerLogo' },
        { id: 'swatch', type: 'swatch' },
      ],
    })

    expect(normalized.elements).toMatchObject([
      { id: 'qr', x: 0, y: 0, w: 10, h: 10 },
      { id: 'logo', x: 0, y: 0, w: 20, h: 6 },
      { id: 'swatch', x: 0, y: 0, w: 20, h: 6 },
    ])
    expect(normalized.elements.every(element => element.x >= 0 && element.y >= 0)).toBe(true)
  })

  it('keeps a thick line overlapping the label', () => {
    const normalized = normalizeLabelDesign({ label: { widthMm: 60, heightMm: 40 }, elements: [{
      id: 'line', type: 'shape', shape: 'line', w: 25, h: 0.3, y: 39.7, strokeWidthMm: 2,
    }] })
    expect(normalized.elements[0]).toMatchObject({ h: 2, y: 39.7, strokeWidthMm: 2 })
  })

  it.each(['circle', 'square'])('keeps default %s geometry inside a short label', shape => {
    const normalized = normalizeLabelDesign({ label: { widthMm: 60, heightMm: 10 }, elements: [{
      id: 'shape', type: 'shape', shape, y: 0,
    }] })
    expect(normalized.elements[0]).toMatchObject({ x: 0, y: 0, w: 10, h: 10 })
  })

  it.each(['circle', 'square', 'rectangle', 'line'])('preserves %s shapes through JSON round trips with bounded geometry', shape => {
    const raw = { label: { widthMm: 60, heightMm: 40 }, elements: [{
      id: 'shape', type: 'shape', shape, w: 50, h: 10,
    }] }
    const normalized = normalizeLabelDesign(raw)
    expect(normalized.elements[0]).toMatchObject({
      shape, w: shape === 'circle' || shape === 'square' ? 40 : 50,
      h: shape === 'circle' || shape === 'square' ? 40 : 10,
    })
    expect(normalizeLabelDesign(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized)
  })

  it('returns a sanitized copy with bounded label and element geometry', () => {
    const raw = {
      version: 2,
      ignored: 'remove me',
      label: { widthMm: 500, heightMm: 2, marginMm: -5, border: 1 },
      elements: [{
        id: 'title',
        type: 'text',
        x: -4,
        y: 500,
        w: 900,
        h: 0,
        z: 99,
        template: '{filament.name}',
        fontFamily: 'Comic Sans',
        fontSizeMm: 80,
        fontWeight: 900,
        italic: 'yes',
        underline: true,
        align: 'sideways',
        color: 'red<script>',
        wrap: false,
        ignored: true,
      }],
    }

    const normalized = normalizeLabelDesign(raw)

    expect(normalized).toEqual({
      version: 2,
      label: { widthMm: 300, heightMm: 10, marginMm: 0, border: false },
      elements: [{
        id: 'title',
        type: 'text',
        x: -4,
        y: 9.9,
        w: 300,
        h: 3,
        z: 0,
        template: '{filament.name}',
        fontFamily: 'Space Grotesk',
        fontSizeMm: 20,
        fontWeight: 600,
        italic: false,
        underline: true,
        align: 'left',
        color: '#000000',
        wrap: false,
      }],
    })
    expect(raw.elements[0].x).toBe(-4)
  })

  it('normalizes every supported element type and keeps QR geometry square', () => {
    const design = normalizeLabelDesign({
      version: 2,
      label: { widthMm: 60, heightMm: 40 },
      elements: [
        { id: 'qr', type: 'qr', x: 2, y: 3, w: 12, h: 18, mode: 'colorLogo', linkMode: 'url', urlTemplate: 'https://example.test' },
        { id: 'logo', type: 'manufacturerLogo', x: 1, y: 1, w: 30, h: 6, objectFit: 'cover' },
        { id: 'image', type: 'image', x: 4, y: 4, w: 20, h: 10, assetId: 'asset-1', objectFit: 'cover' },
        { id: 'swatch', type: 'swatch', x: 5, y: 30, w: 50, h: 5, radiusMm: 20 },
        { id: 'shape', type: 'shape', x: 0, y: 0, w: 60, h: 40, shape: 'ellipse', fill: '#abcdef', stroke: '#123456', strokeWidthMm: 30, radiusMm: -2 },
      ],
    })

    expect(design.elements).toEqual([
      { id: 'qr', type: 'qr', x: 2, y: 3, w: 12, h: 12, z: 0, mode: 'colorLogo', linkMode: 'url', urlTemplate: 'https://example.test' },
      { id: 'logo', type: 'manufacturerLogo', x: 1, y: 1, w: 30, h: 6, z: 1, objectFit: 'contain' },
      { id: 'image', type: 'image', x: 4, y: 4, w: 20, h: 10, z: 2, assetId: 'asset-1', objectFit: 'contain' },
      { id: 'swatch', type: 'swatch', x: 5, y: 30, w: 50, h: 5, z: 3, radiusMm: 2.5 },
      { id: 'shape', type: 'shape', x: 0, y: 0, w: 60, h: 40, z: 4, shape: 'rectangle', fill: '#ABCDEF', stroke: '#123456', strokeWidthMm: 10, radiusMm: 0 },
    ])
  })

  it('replaces blank or duplicate ids and compacts z-order after invalid elements', () => {
    const ids = ['generated-1', 'generated-2']
    const design = normalizeLabelDesign({
      label: { widthMm: 60, heightMm: 40 },
      elements: [
        { id: 'same', type: 'text' },
        { id: 'ignored', type: 'video' },
        { id: 'same', type: 'image', assetId: 'asset-1' },
        { id: '  ', type: 'shape' },
      ],
    }, { createId: () => ids.shift()! })

    expect(design.elements.map(element => element.id)).toEqual([
      'same',
      'generated-1',
      'generated-2',
    ])
    expect(design.elements.map(element => element.z)).toEqual([0, 1, 2])
  })

  it('rejects malformed JSON and changes to the selected element identity', () => {
    const current = createDefaultLabelDesign('spool', () => 'selected').elements[0]
    const label = { widthMm: 60, heightMm: 40, marginMm: 1, border: false }

    expect(() => parseLabelElementJson('{', current, label)).toThrow('valid JSON')
    expect(() => parseLabelElementJson(JSON.stringify({
      ...current,
      id: 'replacement',
    }), current, label)).toThrow('id cannot be changed')
    expect(() => parseLabelElementJson(JSON.stringify({
      ...current,
      type: 'shape',
    }), current, label)).toThrow('type cannot be changed')
  })

})
