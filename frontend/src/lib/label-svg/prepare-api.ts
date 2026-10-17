import type { SpoolExtraFieldDefinitionMap } from '../spool-label-data'
import { buildSpoolDataFromApiSpool, buildFilamentDataFromApiFilament } from '../label-designer-data'
import { normalizeDesignerPresetData } from '../freeform-label/migrate-v1'
import { API_DEFAULT_LABEL_SETTINGS, apiDefaultExtraFields } from '../label-standard'
import type { SvgAsset, SvgInput } from './types'

export interface ApiLabelRenderPayload {
  spool?: unknown
  filament?: unknown
  preset: unknown | null
  fieldDefinitions: SpoolExtraFieldDefinitionMap
  logoUrl?: string | null
  assets: Record<string, string>
  pixelWidth: number
  pixelHeight: number
  thermal?: boolean
}

export function prepareSvgApiInput(payload: ApiLabelRenderPayload, origin: string, assets: Record<string, SvgAsset>): SvgInput {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid renderer origin')
  const kind = payload.filament ? 'filament' : 'spool'
  const data = kind === 'filament'
    ? buildFilamentDataFromApiFilament(payload.filament, payload.fieldDefinitions)
    : buildSpoolDataFromApiSpool(payload.spool, undefined, payload.fieldDefinitions)
  const defaults = API_DEFAULT_LABEL_SETTINGS
  // Reuse the migration boundary; Default is request-local, never a saved/selected preset.
  const preset = normalizeDesignerPresetData(payload.preset ?? { version: 1, settings: {
    label: { width: defaults.widthMm, height: defaults.heightMm, marginMm: 2 },
    logo: { show: defaults.showLogo, spaceMm: 5 },
    title: { template: '{filament.name}', sizeMm: 4, fitToWidth: true },
    qr: { show: defaults.showQR, sizeMm: defaults.qrSizeMm },
    info: { template: ['ID: {id}', '{filament.manufacturer}', '{filament.type}',
      `${defaults.showColorSwatch ? '{color_swatch[4]} ' : ''}{filament.color}`,
      ...apiDefaultExtraFields(data.remaining_weight_g).map(field => `${field.label}: {remaining_weight_g} g`)].join('\n') },
  } }, kind)
  const embedded: Record<string, SvgAsset> = {}
  for (const [id, path] of Object.entries(payload.assets)) if (assets[path]) embedded[id] = assets[path]
  if (payload.logoUrl && assets[payload.logoUrl]) embedded.logo = assets[payload.logoUrl]
  if (assets.qrLogo) embedded.qrLogo = assets.qrLogo
  return { preset, data, assets: embedded, origin: url.origin, entityPath: kind === 'filament' ? 'filaments' : 'spools',
    pixelWidth: payload.pixelWidth, pixelHeight: payload.pixelHeight, thermal: !!payload.thermal }
}
