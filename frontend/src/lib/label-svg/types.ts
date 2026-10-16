import type { LabelDesignerPresetData } from '../freeform-label/types'
import type { SpoolData } from '../label-template'

export interface SvgAsset { dataUrl: string; width: number; height: number }
export interface SvgInput {
  preset: LabelDesignerPresetData
  data: SpoolData
  assets: Record<string, SvgAsset>
  origin: string
  entityPath: 'spools' | 'filaments'
  pixelWidth: number
  pixelHeight: number
  thermal: boolean
}
export interface SvgBox { id: string; x: number; y: number; w: number; h: number; hidden: boolean }
export type SvgOutput = ReturnType<typeof import('./core.mjs').renderSvgLabelPng>
export type SvgRuntime = Awaited<ReturnType<typeof import('./runtime.mjs').createSvgRuntime>>
