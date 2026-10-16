import type { SpoolData } from './label-template'
import { clampFinite } from './freeform-label/geometry'
import { renderSvgDesignerLabel } from './label-svg/browser'
import type { LabelDesignV2 } from './freeform-label/types'
export { buildSpoolDataFromFlatLabel, buildSpoolDesignerDataFromLabelData, buildSpoolDataFromApiSpool } from './label-designer-data'
export type { DesignerExtraField, DesignerFlatLabelData } from './label-designer-data'

export function getDesignerLabelDimensions(design: LabelDesignV2) {
  return {
    widthMm: clampFinite(Number(design.label.widthMm), 20, 300, 60),
    heightMm: clampFinite(Number(design.label.heightMm), 10, 200, 40),
  }
}

export interface RenderDesignerLabelOptions {
  element: HTMLElement
  design: LabelDesignV2
  data: SpoolData
  logoUrl?: string | null
  previewBorder?: boolean
  isStale?: () => boolean
  entityPath?: string
  resolveAssetUrl?: (assetId: string) => string | null | Promise<string | null>
  interactive?: boolean
}

export async function renderDesignerLabel(options: RenderDesignerLabelOptions) {
  if (!options.design || options.design.version !== 2) {
    throw new Error('A version 2 label design is required')
  }
  await renderSvgDesignerLabel({
    element: options.element,
    design: options.design,
    data: options.data,
    logoUrl: options.logoUrl,
    resolveAssetUrl: options.resolveAssetUrl,
    previewBorder: options.previewBorder,
    interactive: options.interactive,
    isStale: options.isStale,
    entityPath: options.entityPath === 'filaments' ? 'filaments' : 'spools',
  })
}
