import { ApiError } from '../api'
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
  loadPreset: (name: string, source?: 'own' | 'cross' | 'builtin') => boolean
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

// The server sends these texts with the code `invalid_label_asset`; each one has its own key.
const invalidLabelAssetKeys: Record<string, string> = {
  'The image is empty': 'labelDesigner.imageEmpty',
  'Label images cannot exceed 5 MiB': 'labelDesigner.imageTooLarge',
  'The processed label image exceeds 5 MiB': 'labelDesigner.imageTooLarge',
  'The file is not a valid supported image': 'labelDesigner.imageInvalid',
  'Only PNG, JPEG, and WebP images are supported': 'labelDesigner.imageUnsupportedFormat',
  'Animated images are not supported': 'labelDesigner.imageAnimated',
  'Image dimensions must be positive': 'labelDesigner.imageDimensionsInvalid',
  'Image dimensions are too large': 'labelDesigner.imageDimensionsTooLarge',
  'Label images cannot exceed 12 megapixels': 'labelDesigner.imageTooManyPixels',
  'The image could not be decoded safely': 'labelDesigner.imageDecodeFailed',
  'Label image limit reached (maximum 100 images)': 'labelDesigner.imageLimitReached',
  'Label image storage limit reached (maximum 50 MiB)': 'labelDesigner.imageStorageLimitReached',
}

function labelAssetApiErrorMessage(
  error: ApiError,
  translate: (key: string, fallback: string) => string,
  key: string,
  fallback: string,
) {
  switch (error.code) {
    case 'label_asset_conflict':
      return translate('labelDesigner.imageConflict', error.message)
    case 'label_asset_not_found':
      return translate('labelDesigner.imageNotFound', error.message)
    case 'label_asset_in_use': {
      const presetNames = error.detail?.preset_names
      const names = Array.isArray(presetNames)
        ? presetNames.filter((name): name is string => typeof name === 'string')
        : []
      return names.length > 0
        ? translate('labelDesigner.imageInUseBy', error.message).replace('{names}', names.join(', '))
        : translate('labelDesigner.imageInUse', error.message)
    }
    case 'invalid_label_asset': {
      // An unknown text (for example a reworded one) falls back to the generic message, never to English.
      const messageKey = invalidLabelAssetKeys[error.message.trim()]
      return messageKey ? translate(messageKey, error.message) : translate(key, fallback)
    }
    default:
      return null
  }
}

export function localizedErrorMessage(
  error: unknown,
  translate: (key: string, fallback: string) => string,
  key: string,
  fallback: string,
) {
  if (error instanceof ApiError) {
    // nginx refuses large uploads itself (nginx.conf, client_max_body_size): no JSON, no error code.
    if (error.status === 413) return translate('labelDesigner.imageTooLarge', 'Label images cannot exceed 5 MiB')
    const message = labelAssetApiErrorMessage(error, translate, key, fallback)
    if (message) return message
  }
  // fetch() rejects with a TypeError when the server cannot be reached.
  if (error instanceof TypeError) return translate('common.networkError', 'Network error. Please try again.')
  return error instanceof Error && error.message.trim()
    ? error.message
    : translate(key, fallback)
}
