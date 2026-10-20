import { describe, expect, it } from 'vitest'

import { snapElementGeometry } from './snapping'

const label = { widthMm: 60, heightMm: 40, marginMm: 1 }

describe('snapElementGeometry', () => {
  it('snaps the outside QR white outline to the label margin without resizing the pattern', () => {
    const result = snapElementGeometry({ x: 3.1, y: 10, w: 18.5, h: 18.5 }, label, 0.5, { type: 'move' }, 4 / 37)
    expect(result.geometry).toEqual({ x: 3, y: 10, w: 18.5, h: 18.5 })
    expect(result.guides).toContainEqual({ axis: 'x', edge: 'start', value: 1 })
  })

  it('snaps a QR resize by its growing outline while preserving the opposite pattern edge', () => {
    const result = snapElementGeometry({ x: 36.9, y: 5, w: 20, h: 20 }, label, 0.5, {
      type: 'resize', edges: { right: true }, proportional: true,
      minimumWidth: 3, minimumHeight: 3, maximumWidth: 40, maximumHeight: 40,
    }, 4 / 37)
    expect(result.geometry.x).toBe(36.9)
    expect(result.geometry.w).toBeCloseTo(19.943902439)
    expect(result.geometry.x + result.geometry.w * (1 + 4 / 37)).toBeCloseTo(59)
    expect(result.guides).toEqual([{ axis: 'x', edge: 'end', value: 59 }])
  })
  it('snaps the nearest moving edge and resolves equal distances deterministically', () => {
    expect(snapElementGeometry(
      { x: 0.5, y: 10, w: 20, h: 5 },
      label,
      0.6,
      { type: 'move' },
    )).toEqual({
      geometry: { x: 0, y: 10, w: 20, h: 5 },
      guides: [{ axis: 'x', edge: 'start', value: 0 }],
    })

    expect(snapElementGeometry(
      { x: 39.7, y: 10, w: 20, h: 5 },
      label,
      0.6,
      { type: 'move' },
    )).toEqual({
      geometry: { x: 40, y: 10, w: 20, h: 5 },
      guides: [{ axis: 'x', edge: 'end', value: 60 }],
    })
  })

  it('snaps a moving element center to both label centerlines', () => {
    expect(snapElementGeometry(
      { x: 19.7, y: 17.6, w: 20, h: 5 },
      label,
      0.6,
      { type: 'move' },
    )).toEqual({
      geometry: { x: 20, y: 17.5, w: 20, h: 5 },
      guides: [
        { axis: 'x', edge: 'center', value: 30 },
        { axis: 'y', edge: 'center', value: 20 },
      ],
    })
  })

  it('snaps an active resize edge while preserving its opposite anchor', () => {
    expect(snapElementGeometry(
      { x: 1.2, y: 10, w: 28.8, h: 5 },
      label,
      0.6,
      {
        type: 'resize',
        edges: { left: true },
        proportional: false,
        minimumWidth: 3,
        minimumHeight: 3,
        maximumWidth: 60,
        maximumHeight: 40,
      },
    )).toEqual({
      geometry: { x: 1, y: 10, w: 29, h: 5 },
      guides: [{ axis: 'x', edge: 'start', value: 1 }],
    })
  })

  it('uses the nearest achievable axis when proportional resize targets conflict', () => {
    expect(snapElementGeometry(
      { x: 0.8, y: 2.8, w: 24.2, h: 24.2 },
      label,
      0.6,
      {
        type: 'resize',
        edges: { left: true, top: true },
        proportional: true,
        minimumWidth: 3,
        minimumHeight: 3,
        maximumWidth: 40,
        maximumHeight: 40,
      },
    )).toEqual({
      geometry: { x: 1, y: 3, w: 24, h: 24 },
      guides: [{ axis: 'x', edge: 'start', value: 1 }],
    })
  })

  it('leaves geometry unchanged outside the snap distance', () => {
    expect(snapElementGeometry(
      { x: 1.7, y: 10, w: 20, h: 5 },
      label,
      0.6,
      { type: 'move' },
    )).toEqual({
      geometry: { x: 1.7, y: 10, w: 20, h: 5 },
      guides: [],
    })
  })
})
