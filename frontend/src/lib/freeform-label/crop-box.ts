import { clampElementPosition, getElementMinimumSize } from './geometry'
import type { LabelGeometry } from './interaction-adapter'
import type { LabelDesignV2, LabelImageCrop, LabelImageElement } from './types'

/**
 * Coordinate contract:
 * - `element` and the returned box use label-space millimetres.
 * - `source` uses the image's intrinsic pixel dimensions.
 * - `crop` and `element.crop` are fractions of the complete source image, not
 *   fractions of one another.
 * - `element` frames the currently visible crop with `object-fit: contain`, so
 *   it may include letterboxing that is excluded from the returned tight box.
 */
export function cropImageBox(
  element: LabelImageElement,
  crop: LabelImageCrop,
  source: { width: number; height: number },
  label: LabelDesignV2['label'],
): LabelGeometry {
  const original = { x: element.x, y: element.y, w: element.w, h: element.h }
  if (
    !Number.isFinite(source.width)
    || !Number.isFinite(source.height)
    || source.width <= 0
    || source.height <= 0
  ) return original

  const current = element.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const currentSourceWidth = source.width * current.w
  const currentSourceHeight = source.height * current.h
  const sourceScale = Math.min(
    element.w / currentSourceWidth,
    element.h / currentSourceHeight,
  )
  const displayedWidth = currentSourceWidth * sourceScale
  const displayedHeight = currentSourceHeight * sourceScale
  const sourceOriginX = element.x + (element.w - displayedWidth) / 2
    - current.x * source.width * sourceScale
  const sourceOriginY = element.y + (element.h - displayedHeight) / 2
    - current.y * source.height * sourceScale

  const requested = {
    x: sourceOriginX + crop.x * source.width * sourceScale,
    y: sourceOriginY + crop.y * source.height * sourceScale,
    w: crop.w * source.width * sourceScale,
    h: crop.h * source.height * sourceScale,
  }
  const centerX = requested.x + requested.w / 2
  const centerY = requested.y + requested.h / 2
  const minimum = getElementMinimumSize(element)
  const minimumWidth = Math.min(minimum, label.widthMm)
  const minimumHeight = Math.min(minimum, label.heightMm)
  const scaleForMinimum = Math.max(
    1,
    minimumWidth / requested.w,
    minimumHeight / requested.h,
  )
  const scaleForMaximum = Math.min(
    label.widthMm / requested.w,
    label.heightMm / requested.h,
  )
  const scale = Math.min(scaleForMinimum, scaleForMaximum)
  const width = requested.w * scale
  const height = requested.h * scale

  const position = clampElementPosition({
    x: centerX - width / 2,
    y: centerY - height / 2,
    w: width,
    h: height,
  }, label)
  return {
    ...position,
    w: width,
    h: height,
  }
}
