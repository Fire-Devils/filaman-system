import type { DesignerExtraField } from '../label-designer'
import type { SpoolData } from '../label-template'
import type { InteractFactory } from './interaction-adapter'
import type { TemplateTextModifier } from './text-modifiers'
import type { LabelDesignV2, LabelElementIdFactory, LabelElementType, LabelKind } from './types'

export interface LabelAssetMetadata {
  id: string
  display_name: string
  sha256: string
  media_type: string
  width: number
  height: number
  byte_size: number
  orphaned_at: string | null
  created_at: string
  updated_at: string
  content_url: string
}

export interface LabelAssetClient {
  list(): Promise<LabelAssetMetadata[]>
  upload(file: File): Promise<LabelAssetMetadata>
  delete(assetId: string): Promise<void>
}

export type LabelFieldModifier = TemplateTextModifier

export interface FreeformEditorState {
  design: LabelDesignV2
  selectedId: string | null
  assets: LabelAssetMetadata[]
  assetsLoading: boolean
  assetError: string | null
  destroyed: boolean
}

export interface FreeformEditorOptions {
  initialDesign?: LabelDesignV2
  kind?: LabelKind
  createId?: LabelElementIdFactory
  assets?: LabelAssetClient
  onChange?: (state: FreeformEditorState) => void
  render?: () => void | Promise<void>
  translate?: (key: string, fallback: string) => string
}

export interface FreeformLabelDesignerEditorOptions {
  extraFields?: DesignerExtraField[]
  entityType?: LabelKind
  batchMode?: boolean
  onChange: () => Promise<void>
  translate?: (key: string, fallback: string) => string
  presetsKey: string
  settingsKey: string
  entityLabel?: string
  crossPresetsKey?: string
  ownPresetsLabel?: string
  crossPresetsLabel?: string
  loadInteract?: () => Promise<InteractFactory>
  getPreviewData?: () => SpoolData | null | undefined
}

export interface FreeformLabelDesignerEditorController {
  getDesign: () => LabelDesignV2
  savePreset: (asNew?: boolean) => Promise<string | null>
  loadSettings: (design?: LabelDesignV2) => boolean
  loadPreset: (name: string) => boolean
  refresh: () => Promise<void>
  refreshInteractions: () => Promise<void>
  refreshExtraFields: (extraFields: DesignerExtraField[]) => void
  refreshPresetList: (selectName?: string) => void
  destroy: () => void
}

export interface JsonApplyResult {
  ok: boolean
  error?: string
}

export const elementLabelKeys: Record<LabelElementType, string> = {
  text: 'labelDesigner.elementText',
  qr: 'labelDesigner.elementQr',
  manufacturerLogo: 'labelDesigner.elementManufacturerLogo',
  image: 'labelDesigner.elementImage',
  swatch: 'labelDesigner.elementSwatch',
  shape: 'labelDesigner.elementShape',
}

export const elementLabelFallbacks: Record<LabelElementType, string> = {
  text: 'Text element',
  qr: 'QR code element',
  manufacturerLogo: 'Manufacturer logo element',
  image: 'Image element',
  swatch: 'Color swatch element',
  shape: 'Shape element',
}

export function localizedErrorMessage(
  error: unknown,
  translate: (key: string, fallback: string) => string,
  key: string,
  fallback: string,
) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : translate(key, fallback)
}
