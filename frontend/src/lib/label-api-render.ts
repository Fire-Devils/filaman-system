import { buildSpoolDataFromApiSpool, renderDesignerLabel } from './label-designer'
import { captureLabelElement } from './label-export'
import { normalizeDesignerPresetData } from './freeform-label/migrate-v1'
import { buildStandardLabelDataFromApiSpool, renderStandardLabel } from './label-standard'
import type { SpoolExtraFieldDefinitionMap } from './spool-label-data'

export interface ApiLabelRenderPayload {
  spool: unknown
  preset: unknown | null
  fieldDefinitions: SpoolExtraFieldDefinitionMap
  logoUrl?: string | null
  assets: Record<string, string>
  pixelWidth: number
  pixelHeight: number
}

/** Server-supplied data uses the same rendering and capture as browser exports. */
export async function renderApiLabel(payload: ApiLabelRenderPayload): Promise<string> {
  const element = document.createElement('div')
  element.className = 'label-preview'
  document.body.appendChild(element)
  try {
    const data = buildSpoolDataFromApiSpool(payload.spool, undefined, payload.fieldDefinitions)
    if (payload.preset !== null) {
      await renderDesignerLabel({
        element,
        design: normalizeDesignerPresetData(payload.preset, 'spool').design,
        data,
        logoUrl: payload.logoUrl,
        resolveAssetUrl: id => Object.hasOwn(payload.assets, id) ? payload.assets[id] : null,
        previewBorder: false,
      })
    } else {
      await renderStandardLabel({
        element,
        data: buildStandardLabelDataFromApiSpool(payload.spool, data.remaining_weight_g
          ? [{ label: 'Remaining', value: `${data.remaining_weight_g} g` }]
          : []),
        settings: {
          widthMm: 60, heightMm: 40, fontScale: 1, qrSizeMm: 18,
          showLogo: true, showQR: true, showID: true, showManufacturer: true,
          showMaterial: true, showColor: true, showColorSwatch: true, showColorHex: false,
        },
        logoUrl: payload.logoUrl,
      })
    }
    return await captureLabelElement(element, {
      pixelRatio: 1, canvasWidth: payload.pixelWidth, canvasHeight: payload.pixelHeight,
    })
  } finally {
    element.remove()
  }
}
