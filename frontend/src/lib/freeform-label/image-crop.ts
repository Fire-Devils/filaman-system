import type { LabelImageCrop } from './types'

const MINIMUM_CROP_SIZE = 0.01

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeImageCrop(value: unknown): LabelImageCrop | undefined {
  if (!isRecord(value)) return undefined
  const values = [value.x, value.y, value.w, value.h]
  if (!values.every(field => typeof field === 'number' && Number.isFinite(field))) return undefined

  const x = clamp(value.x as number, 0, 1 - MINIMUM_CROP_SIZE)
  const y = clamp(value.y as number, 0, 1 - MINIMUM_CROP_SIZE)
  const w = clamp(value.w as number, MINIMUM_CROP_SIZE, 1 - x)
  const h = clamp(value.h as number, MINIMUM_CROP_SIZE, 1 - y)
  return { x, y, w, h }
}
