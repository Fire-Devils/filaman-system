export const QR_RECOMMENDED_DPI = 300
export const QR_RECOMMENDED_DOTS_PER_MODULE = 4
export const QR_QUIET_ZONE_MODULES = 4

function validModuleCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function getQrModuleCount(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('_oQRCode' in value)) return undefined
  const model = value._oQRCode
  if (!model || typeof model !== 'object' || !('getModuleCount' in model) || typeof model.getModuleCount !== 'function') {
    return undefined
  }
  try {
    const moduleCount: unknown = model.getModuleCount()
    return validModuleCount(moduleCount) ? moduleCount : undefined
  } catch {
    return undefined
  }
}

export function getQrRecommendedSideMm(moduleCount: unknown): number | undefined {
  if (!validModuleCount(moduleCount)) return undefined
  const rawMm = moduleCount * QR_RECOMMENDED_DOTS_PER_MODULE * 25.4 / QR_RECOMMENDED_DPI
  return Math.ceil(rawMm * 100) / 100
}
