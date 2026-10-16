export interface SnapBox {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapGuide {
  axis: 'x' | 'y'
  edge: 'start' | 'center' | 'end'
  value: number
}

export type SnapOperation =
  | { type: 'move' }
  | {
      type: 'resize'
      edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }
      proportional: boolean
      minimumWidth: number
      minimumHeight: number
      maximumWidth: number
      maximumHeight: number
    }

type Axis = SnapGuide['axis']
type Edge = 'start' | 'end'

interface Candidate {
  delta: number
  guide: SnapGuide
  size?: number
}

const targetsFor = (size: number, margin: number) => (
  [...new Set([0, margin, size - margin, size])].sort((left, right) => left - right)
)

function nearestCandidate(candidates: Candidate[], thresholdMm: number): Candidate | null {
  let nearest: Candidate | null = null
  for (const candidate of candidates) {
    if (Math.abs(candidate.delta) > thresholdMm) continue
    if (!nearest || Math.abs(candidate.delta) < Math.abs(nearest.delta)) nearest = candidate
  }
  return nearest
}

function moveCandidates(
  axis: Axis,
  start: number,
  size: number,
  targets: number[],
  center: number,
): Candidate[] {
  const candidates: Candidate[] = []
  for (const [edge, value] of [['start', start], ['end', start + size]] as const) {
    for (const target of targets) {
      candidates.push({ delta: target - value, guide: { axis, edge, value: target } })
    }
  }
  candidates.push({ delta: center - (start + size / 2), guide: { axis, edge: 'center', value: center } })
  return candidates
}

function resizeCandidates(
  axis: Axis,
  start: number,
  size: number,
  activeStart: boolean,
  activeEnd: boolean,
  targets: number[],
  minimum: number,
  maximum: number,
): Candidate[] {
  const candidates: Candidate[] = []
  const add = (edge: Edge, value: number) => {
    for (const target of targets) {
      const delta = target - value
      const nextSize = edge === 'start' ? size - delta : size + delta
      if (nextSize >= minimum && nextSize <= maximum) {
        candidates.push({ delta, size: nextSize, guide: { axis, edge, value: target } })
      }
    }
  }
  if (activeStart) add('start', start)
  if (activeEnd) add('end', start + size)
  return candidates
}

export function snapElementGeometry(
  box: SnapBox,
  label: { widthMm: number; heightMm: number; marginMm: number },
  thresholdMm: number,
  operation: SnapOperation,
  quietZoneRatio = 0,
): { geometry: SnapBox; guides: SnapGuide[] } {
  const xTargets = targetsFor(label.widthMm, label.marginMm)
  const yTargets = targetsFor(label.heightMm, label.marginMm)

  if (quietZoneRatio > 0) {
    const padding = box.w * quietZoneRatio
    if (operation.type === 'move') {
      const result = snapElementGeometry({
        x: box.x - padding, y: box.y - padding, w: box.w + 2 * padding, h: box.h + 2 * padding,
      }, label, thresholdMm, operation)
      return { geometry: { ...box, x: result.geometry.x + padding, y: result.geometry.y + padding }, guides: result.guides }
    }
    const candidates: Candidate[] = []
    const minimum = Math.max(operation.minimumWidth, operation.minimumHeight)
    const maximum = Math.min(operation.maximumWidth, operation.maximumHeight)
    for (const [axis, start, size, targets, startActive, endActive] of [
      ['x', box.x, box.w, xTargets, operation.edges.left, operation.edges.right],
      ['y', box.y, box.h, yTargets, operation.edges.top, operation.edges.bottom],
    ] as const) {
      for (const target of targets) {
        for (const edge of ['start', 'end'] as const) {
          if (!(edge === 'start' ? startActive : endActive)) continue
          const nextSize = (edge === 'start' ? start + size - target : target - start) / (1 + quietZoneRatio)
          if (nextSize < minimum || nextSize > maximum) continue
          candidates.push({
            delta: target - (edge === 'start' ? start - padding : start + size + padding),
            size: nextSize, guide: { axis, edge, value: target },
          })
        }
      }
    }
    const snap = nearestCandidate(candidates, thresholdMm)
    if (snap?.size === undefined) return { geometry: { ...box }, guides: [] }
    return {
      geometry: {
        x: operation.edges.left ? box.x + box.w - snap.size : box.x,
        y: operation.edges.top ? box.y + box.h - snap.size : box.y,
        w: snap.size, h: snap.size,
      },
      guides: [snap.guide],
    }
  }

  if (operation.type === 'move') {
    const xSnap = nearestCandidate(moveCandidates('x', box.x, box.w, xTargets, label.widthMm / 2), thresholdMm)
    const ySnap = nearestCandidate(moveCandidates('y', box.y, box.h, yTargets, label.heightMm / 2), thresholdMm)
    return {
      geometry: {
        ...box,
        x: box.x + (xSnap?.delta ?? 0),
        y: box.y + (ySnap?.delta ?? 0),
      },
      guides: [xSnap?.guide, ySnap?.guide].filter((guide): guide is SnapGuide => Boolean(guide)),
    }
  }

  const { edges } = operation
  if (operation.proportional) {
    const minimum = Math.max(operation.minimumWidth, operation.minimumHeight)
    const maximum = Math.min(operation.maximumWidth, operation.maximumHeight)
    const candidates = [
      ...resizeCandidates('x', box.x, box.w, Boolean(edges.left), Boolean(edges.right), xTargets, minimum, maximum),
      ...resizeCandidates('y', box.y, box.h, Boolean(edges.top), Boolean(edges.bottom), yTargets, minimum, maximum),
    ]
    const snap = nearestCandidate(candidates, thresholdMm)
    if (!snap || snap.size === undefined) return { geometry: { ...box }, guides: [] }
    const right = box.x + box.w
    const bottom = box.y + box.h
    return {
      geometry: {
        x: edges.left ? right - snap.size : box.x,
        y: edges.top ? bottom - snap.size : box.y,
        w: snap.size,
        h: snap.size,
      },
      guides: [snap.guide],
    }
  }

  const xSnap = nearestCandidate(resizeCandidates(
    'x', box.x, box.w, Boolean(edges.left), Boolean(edges.right), xTargets,
    operation.minimumWidth, operation.maximumWidth,
  ), thresholdMm)
  const ySnap = nearestCandidate(resizeCandidates(
    'y', box.y, box.h, Boolean(edges.top), Boolean(edges.bottom), yTargets,
    operation.minimumHeight, operation.maximumHeight,
  ), thresholdMm)
  const right = box.x + box.w
  const bottom = box.y + box.h
  const width = xSnap?.size ?? box.w
  const height = ySnap?.size ?? box.h
  return {
    geometry: {
      x: edges.left ? right - width : box.x,
      y: edges.top ? bottom - height : box.y,
      w: width,
      h: height,
    },
    guides: [xSnap?.guide, ySnap?.guide].filter((guide): guide is SnapGuide => Boolean(guide)),
  }
}
