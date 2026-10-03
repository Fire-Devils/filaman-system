import { describe, expect, it } from 'vitest'

import { cropImageBox } from './crop-box'
import type { LabelDesignV2, LabelImageCrop, LabelImageElement } from './types'

const label = (widthMm = 60, heightMm = 40): LabelDesignV2['label'] => ({
  widthMm,
  heightMm,
  marginMm: 0,
  border: false,
})

const image = (
  geometry: Pick<LabelImageElement, 'x' | 'y' | 'w' | 'h'>,
  crop?: LabelImageCrop,
): LabelImageElement => ({
  id: 'image',
  type: 'image',
  assetId: 'asset',
  objectFit: 'contain',
  z: 0,
  ...geometry,
  ...(crop ? { crop } : {}),
})

describe('cropImageBox', () => {
  it('removes vertical letterboxing around a landscape image crop', () => {
    const result = cropImageBox(
      image({ x: 10, y: 10, w: 30, h: 30 }),
      { x: 0.25, y: 0, w: 0.5, h: 1 },
      { width: 400, height: 200 },
      label(),
    )

    expect(result).toEqual({ x: 17.5, y: 17.5, w: 15, h: 15 })
  })

  it('removes horizontal letterboxing around a portrait image crop', () => {
    const result = cropImageBox(
      image({ x: 10, y: 5, w: 30, h: 20 }),
      { x: 0, y: 0.25, w: 1, h: 0.5 },
      { width: 200, height: 400 },
      label(),
    )

    expect(result).toEqual({ x: 20, y: 10, w: 10, h: 10 })
  })

  it('maps a replacement crop through the displayed scale of the previous crop', () => {
    const result = cropImageBox(
      image(
        { x: 17.5, y: 17.5, w: 15, h: 15 },
        { x: 0.25, y: 0, w: 0.5, h: 1 },
      ),
      { x: 0.5, y: 0.25, w: 0.25, h: 0.5 },
      { width: 400, height: 200 },
      label(),
    )

    expect(result).toEqual({ x: 25, y: 21.25, w: 7.5, h: 7.5 })
  })

  it('restores tight full-source bounds when resetting an already-cropped image', () => {
    const result = cropImageBox(
      image(
        { x: 17.5, y: 17.5, w: 15, h: 15 },
        { x: 0.25, y: 0, w: 0.5, h: 1 },
      ),
      { x: 0, y: 0, w: 1, h: 1 },
      { width: 400, height: 200 },
      label(),
    )

    expect(result).toEqual({ x: 10, y: 17.5, w: 30, h: 15 })
  })

  it('scales an expanded crop down while preserving its overlapping center shift', () => {
    const result = cropImageBox(
      image(
        { x: 50, y: 30, w: 10, h: 10 },
        { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      ),
      { x: 0, y: 0, w: 1, h: 1 },
      { width: 100, height: 100 },
      label(),
    )

    expect(result).toEqual({ x: 35, y: 15, w: 40, h: 40 })
  })

  it('proportionally enlarges a tiny crop to the image minimum size', () => {
    const result = cropImageBox(
      image({ x: 10, y: 10, w: 20, h: 20 }),
      { x: 0.5, y: 0.5, w: 0.01, h: 0.02 },
      { width: 1000, height: 1000 },
      label(),
    )

    expect(result).toEqual({ x: 18.6, y: 17.2, w: 3, h: 6 })
  })

  it('preserves an extreme crop aspect when its short axis cannot reach the usual minimum', () => {
    const result = cropImageBox(
      image({ x: 0, y: 0, w: 20, h: 10 }),
      { x: 0, y: 0, w: 1, h: 0.01 },
      { width: 100, height: 100 },
      label(20, 10),
    )

    expect(result).toEqual({ x: 0, y: -0.05, w: 20, h: 0.2 })
  })

  it('keeps a cropped box partially outside when it still overlaps the label', () => {
    const result = cropImageBox(
      image({ x: -10, y: 10, w: 20, h: 20 }),
      { x: 0, y: 0, w: 1, h: 1 },
      { width: 100, height: 100 },
      label(),
    )

    expect(result).toEqual({ x: -10, y: 10, w: 20, h: 20 })
  })

  it.each([
    { width: 0, height: 200 },
    { width: 400, height: Number.NaN },
  ])('keeps the original geometry for an invalid source size %#', source => {
    const element = image({ x: 4, y: 6, w: 12, h: 8 })

    expect(cropImageBox(element, { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, source, label()))
      .toEqual({ x: 4, y: 6, w: 12, h: 8 })
  })
})
